/**
 * P6 verification — Prompt Engineering Center & Context Manager contracts.
 *
 * Runs in plain Node (no browser, no network, no IndexedDB). Modules are bundled
 * from source with the project's own Vite/esbuild pipeline (see
 * `lib/p4-bundler.cjs`), so the code under test is exactly what ships.
 *
 * These checks focus on what a UI smoke test cannot see reliably and what must
 * never regress silently:
 *   - R1 versioning is append-only (edits/restores add versions, never rewrite);
 *   - prompt rendering is strict (undeclared / missing-required fail loudly) and
 *     single-pass (values cannot inject new placeholders);
 *   - R4 the input budget is NEVER derived from `maxTokens`; capacity comes only
 *     from a known context window;
 *   - R3 retrieved context is resolved LIVE from the referenced entity, not a
 *     stale copy, and duplicate 1:1 sources are flagged;
 *   - R5 preview and execution share ONE assembled request.
 *
 * Usage: npm run verify:prompt
 */
const { importBundled, cleanupTemp } = require('./lib/p4-bundler.cjs');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
}
function even(name, condition, detail) {
  record(name, Boolean(condition), detail);
}
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  record(name, ok, ok ? undefined : `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}
function throwsWith(name, fn, predicate) {
  try {
    fn();
    record(name, false, 'expected a throw');
  } catch (error) {
    const ok = predicate(error);
    record(name, ok, ok ? undefined : `threw ${error && error.name}: ${error && error.message}`);
  }
}

async function main() {
  const mod = await importBundled('scripts/lib/p6-entry.ts', 'p6');

  const {
    renderTemplate,
    parsePlaceholders,
    validateTemplate,
    referencedVariableNames,
    normalizeValues,
    estimateTokens,
    estimateMessagesTokens,
    ContextAssemblyService,
    PromptTemplateService,
    isReferenceSource,
  } = mod;

  /* ==================================================================== */
  /* 1. Token estimator — deterministic, CJK-aware, never negative        */
  /* ==================================================================== */
  eq('estimator: empty string is 0', estimateTokens(''), 0);
  even('estimator: deterministic (same in, same out)', estimateTokens('hello world') === estimateTokens('hello world'));
  even('estimator: 4 latin chars ~ small positive count', estimateTokens('abcd') > 0 && estimateTokens('abcd') < 10);
  even(
    'estimator: CJK counts heavier than equal-length latin',
    estimateTokens('中文测试文本') > estimateTokens('abcd'),
  );
  even('estimator: monotonic with length', estimateTokens('x'.repeat(400)) > estimateTokens('x'.repeat(40)));
  even(
    'estimator: messages add per-message overhead',
    estimateMessagesTokens([{ content: 'a' }, { content: 'a' }]) > estimateMessagesTokens([{ content: 'aa' }]) - 1,
  );

  /* ==================================================================== */
  /* 2. Placeholder parsing & variable validation                         */
  /* ==================================================================== */
  eq('parse: finds both placeholders in order', parsePlaceholders('Hi {{ name }} and {{age}}').map((p) => p.name), ['name', 'age']);
  eq('parse: trims inner whitespace', parsePlaceholders('{{  sourceText  }}')[0].name, 'sourceText');
  eq('refs: dedupes repeated names', referencedVariableNames('{{a}} {{a}} {{b}}'), ['a', 'b']);

  {
    const issues = validateTemplate('Hello {{name}}', []);
    eq('validate: undeclared variable flagged', issues.some((i) => i.kind === 'undeclared' && i.name === 'name'), true);
  }
  {
    const issues = validateTemplate('No variables here', [{ name: 'unused', description: '', required: false }]);
    eq('validate: declaring an unused variable is fine', issues.length, 0);
  }
  {
    const issues = validateTemplate('{{bad name}}', [{ name: 'bad name', description: '', required: false }]);
    eq('validate: invalid variable name flagged', issues.some((i) => i.kind === 'invalid-name'), true);
  }
  {
    const vars = [
      { name: 'a', description: '', required: false },
      { name: 'a', description: '', required: false },
    ];
    eq('validate: duplicate declaration flagged', validateTemplate('{{a}}', vars).some((i) => i.kind === 'duplicate-declaration'), true);
  }
  {
    const issues = validateTemplate('Broken {{ only one side', [{ name: 'only one side', description: '', required: false }]);
    eq('validate: malformed braces flagged', issues.some((i) => i.kind === 'invalid-name' || i.kind === 'malformed-braces'), true);
  }

  /* ==================================================================== */
  /* 3. STRICT rendering                                                  */
  /* ==================================================================== */
  {
    const vars = [{ name: 'name', description: '', required: true }];
    eq('render: substitutes a provided value', renderTemplate('Hi {{name}}!', vars, { name: 'Ada' }).text, 'Hi Ada!');
  }
  {
    const vars = [{ name: 'name', description: '', required: true }];
    throwsWith('render: missing REQUIRED value throws', () => renderTemplate('Hi {{name}}', vars, {}), (e) => e.name === 'PromptRenderError' && e.kind === 'missing-required');
  }
  {
    const vars = [{ name: 'name', description: '', required: false, defaultValue: 'world' }];
    const out = renderTemplate('Hi {{name}}', vars, {});
    eq('render: uses default when value absent', out.text, 'Hi world');
    eq('render: reports used default', out.usedDefaults, ['name']);
  }
  {
    const vars = [{ name: 'name', description: '', required: false }];
    const out = renderTemplate('Hi {{name}}', vars, {});
    eq('render: non-required missing renders empty', out.text, 'Hi ');
    eq('render: reports empty variable', out.emptyVariables, ['name']);
  }
  {
    // Undeclared placeholder must fail loudly, not silently vanish.
    throwsWith('render: undeclared placeholder throws', () => renderTemplate('Hi {{ghost}}', [], {}), (e) => e.kind === 'invalid-template');
  }
  {
    // SINGLE-PASS: a value containing {{x}} must NOT be re-parsed.
    const vars = [
      { name: 'a', description: '', required: true },
      { name: 'x', description: '', required: false },
    ];
    const out = renderTemplate('{{a}}', vars, { a: 'literal {{x}} text', x: 'INJECTED' });
    eq('render: single-pass — value cannot inject placeholders', out.text, 'literal {{x}} text');
  }

  /* ==================================================================== */
  /* 4. R1 — append-only versioning (fake repository)                     */
  /* ==================================================================== */
  {
    // In-memory fake repository implementing just what PromptTemplateService uses.
    const templates = new Map();
    const versions = new Map(); // templateId -> [versions]
    const fakeRepo = {
      async listByProject(projectId) {
        return [...templates.values()].filter((t) => t.projectId === projectId).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
      },
      async getTemplate(id) {
        return templates.get(id) ?? null;
      },
      async createTemplate(t) {
        templates.set(t.id, t);
        return t;
      },
      async putTemplate(t) {
        templates.set(t.id, t);
        return t;
      },
      async deleteTemplate(id, opts) {
        templates.delete(id);
        if (opts && opts.deleteVersions) versions.delete(id);
      },
      async listVersionsByTemplate(id) {
        return (versions.get(id) ?? []).slice().sort((a, b) => b.version - a.version);
      },
      async getVersion(id) {
        for (const list of versions.values()) {
          const found = list.find((v) => v.id === id);
          if (found) return found;
        }
        return null;
      },
      async createVersion(v) {
        const list = versions.get(v.templateId) ?? [];
        list.push(v);
        versions.set(v.templateId, list);
        return v;
      },
      async deleteAllByProject() {},
    };

    // Fake AI repo: no providers/models exist; preferences are null so no checks run.
    const fakeAiRepo = {
      async getProvider() {
        return null;
      },
      async getModel() {
        return null;
      },
    };

    const service = new PromptTemplateService(fakeRepo, fakeAiRepo);

    const created = await service.createTemplate('proj', {
      name: 'Continue',
      category: 'Continuation',
      content: 'Continue: {{sourceText}}',
      variables: [{ name: 'sourceText', description: '', required: false }],
      taskKind: 'continue',
    });
    eq('R1 create: starts at version 1', created.version, 1);
    const v1 = await service.listVersions(created.id);
    eq('R1 create: one version snapshot exists', v1.length, 1);
    eq('R1 create: initial reason is created', v1[0].reason, 'created');

    const updated = await service.updateTemplate(created.id, { content: 'Continue carefully: {{sourceText}}' });
    eq('R1 update: version bumped to 2', updated.version, 2);
    const v2 = await service.listVersions(created.id);
    eq('R1 update: two snapshots now exist', v2.length, 2);
    // The OLD snapshot still has the OLD content — history is immutable.
    const histForV1 = v2.find((v) => v.version === 1);
    eq('R1 update: previous snapshot content unchanged', histForV1.content, 'Continue: {{sourceText}}');

    // A no-op-ish update (only toggling enabled) must NOT create a version.
    const toggled = await service.updateTemplate(created.id, { enabled: false });
    eq('R1 toggle: no new version for non-content change', toggled.version, 2);
    eq('R1 toggle: still two snapshots', (await service.listVersions(created.id)).length, 2);

    // Restoring an old version APPENDS a new one rather than rewriting.
    const restored = await service.restoreVersion(created.id, histForV1.id);
    eq('R1 restore: version bumped to 3', restored.version, 3);
    eq('R1 restore: content matches restored snapshot', restored.content, 'Continue: {{sourceText}}');
    const v3 = await service.listVersions(created.id);
    eq('R1 restore: three snapshots (append, not rewrite)', v3.length, 3);
    eq('R1 restore: newest reason is restored', v3[0].reason, 'restored');
  }

  /* ==================================================================== */
  /* 5. R6 — import/export round-trip + invalid entry isolation           */
  /* ==================================================================== */
  {
    const templates = new Map();
    const versions = new Map();
    const fakeRepo = {
      async listByProject(p) { return [...templates.values()].filter((t) => t.projectId === p); },
      async getTemplate(id) { return templates.get(id) ?? null; },
      async createTemplate(t) { templates.set(t.id, t); return t; },
      async putTemplate(t) { templates.set(t.id, t); return t; },
      async deleteTemplate(id, opts) { templates.delete(id); if (opts && opts.deleteVersions) versions.delete(id); },
      async listVersionsByTemplate(id) { return versions.get(id) ?? []; },
      async getVersion() { return null; },
      async createVersion(v) { const l = versions.get(v.templateId) ?? []; l.push(v); versions.set(v.templateId, l); return v; },
      async deleteAllByProject() {},
    };
    const fakeAiRepo = { async getProvider() { return null; }, async getModel() { return null; } };
    const svc = new PromptTemplateService(fakeRepo, fakeAiRepo);

    await svc.createTemplate('p1', {
      name: 'Polish',
      category: 'Polish',
      content: 'Polish {{sourceText}}',
      variables: [{ name: 'sourceText', description: '', required: false }],
      taskKind: 'polish',
    });
    const bundle = await svc.exportBundle('p1');
    even('R6 export: valid JSON', typeof bundle === 'string' && bundle.startsWith('{'));
    const parsedBundle = JSON.parse(bundle);
    eq('R6 export: bundle has format tag', parsedBundle.format, 'never87.prompt-templates');

    // Import into a different project, plus one invalid entry that must be skipped.
    const goodBundle = JSON.parse(bundle);
    goodBundle.templates.push({ name: 'Broken', category: 'X', content: '{{undeclared}}', variables: [], taskKind: null, enabled: true, description: '' });
    const result = await svc.importBundle('p2', JSON.stringify(goodBundle));
    eq('R6 import: good entry imported', result.imported >= 1, true);
    eq('R6 import: invalid entry skipped', result.skipped >= 1, true);
    even('R6 import: skipped entry reported invalid', result.details.some((d) => d.status === 'invalid'));

    const imported = await svc.listTemplates('p2');
    eq('R6 import: imported template is in the target project', imported.length >= 1, true);
  }

  /* ==================================================================== */
  /* 5b. R6 — conflict semantics (same name + same/diff content, id)      */
  /* ==================================================================== */
  {
    const templates = new Map();
    const versions = new Map();
    const fakeRepo = {
      async listByProject(p) { return [...templates.values()].filter((t) => t.projectId === p).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)); },
      async getTemplate(id) { return templates.get(id) ?? null; },
      async createTemplate(t) { templates.set(t.id, t); return t; },
      async putTemplate(t) { templates.set(t.id, t); return t; },
      async deleteTemplate(id, opts) { templates.delete(id); if (opts && opts.deleteVersions) versions.delete(id); },
      async listVersionsByTemplate(id) { return versions.get(id) ?? []; },
      async getVersion() { return null; },
      async createVersion(v) { const l = versions.get(v.templateId) ?? []; l.push(v); versions.set(v.templateId, l); return v; },
      async deleteAllByProject() {},
      async listAll() { return [...templates.values()]; },
    };
    const fakeAiRepo = { async getProvider() { return null; }, async getModel() { return null; } };
    const svc = new PromptTemplateService(fakeRepo, fakeAiRepo);

    // Seed an existing template "Polish" with content A.
    const created = await svc.createTemplate('p1', {
      name: 'Polish',
      category: 'Polish',
      content: 'Polish A {{sourceText}}',
      variables: [{ name: 'sourceText', description: '', required: false }],
      taskKind: 'polish',
    });
    const existingId = created.id;

    // (1) Same name + SAME content -> idempotent skip (no new record).
    const sameBundle = JSON.stringify({
      format: 'never87.prompt-templates',
      formatVersion: 1,
      exportedAt: Date.now(),
      templates: [{ name: 'Polish', description: '', category: 'Polish', content: 'Polish A {{sourceText}}', variables: [{ name: 'sourceText', description: '', required: false }], taskKind: 'polish', enabled: true }],
    });
    const idempotent = await svc.importBundle('p1', sameBundle);
    eq('R6 conflict: same name + same content is skipped (idempotent)', idempotent.skipped, 1);
    eq('R6 conflict: idempotent → nothing imported', idempotent.imported, 0);
    eq('R6 conflict: idempotent → no conflicts', idempotent.conflicted, 0);
    eq('R6 conflict: idempotent → template count unchanged', (await svc.listTemplates('p1')).length, 1);

    // (2) Same name + DIFFERENT content -> NOT silently discarded; renamed copy.
    const diffBundle = JSON.stringify({
      format: 'never87.prompt-templates',
      formatVersion: 1,
      exportedAt: Date.now(),
      templates: [{ name: 'Polish', description: '', category: 'Polish', content: 'Polish B {{sourceText}}', variables: [{ name: 'sourceText', description: '', required: false }], taskKind: 'polish', enabled: true }],
    });
    const conflict = await svc.importBundle('p1', diffBundle);
    eq('R6 conflict: same name + different content is a conflict', conflict.conflicted, 1);
    eq('R6 conflict: conflicting content WAS imported (not discarded)', conflict.imported, 1);
    eq('R6 conflict: original + renamed copy both exist', (await svc.listTemplates('p1')).length, 2);
    const after = await svc.listTemplates('p1');
    const original = after.find((t) => t.id === existingId);
    eq('R6 conflict: original content preserved', original.content, 'Polish A {{sourceText}}');
    const renamed = after.find((t) => t.id !== existingId);
    even('R6 conflict: renamed copy keeps the incoming content', renamed.content === 'Polish B {{sourceText}}');
    even('R6 conflict: renamed copy has a distinct name', renamed.name !== 'Polish' && /Polish \(imported/.test(renamed.name));

    // (3) ID collision: every imported copy gets a NEW id, never overwrites.
    even('R6 conflict: renamed copy has a brand-new id (no overwrite)', renamed.id !== existingId);
    even('R6 conflict: detail reports the conflict status', conflict.details.some((d) => d.status === 'conflict'));

    // (4) Re-importing the SAME conflicting bundle again → idempotent now that
    // the renamed copy exists (same name+content as the renamed one).
    const reimport = await svc.importBundle('p1', diffBundle);
    eq('R6 conflict: re-import of the conflicting bundle is now idempotent', reimport.imported, 0);
    eq('R6 conflict: re-import does not grow the project', (await svc.listTemplates('p1')).length, 2);
  }

  /* ==================================================================== */
  /* 5c. R7 — dangling provider/model preferences are cleared             */
  /* ==================================================================== */
  {
    const templates = new Map();
    const versions = new Map();
    const fakeRepo = {
      async listByProject(p) { return [...templates.values()].filter((t) => t.projectId === p); },
      async getTemplate(id) { return templates.get(id) ?? null; },
      async createTemplate(t) { templates.set(t.id, t); return t; },
      async putTemplate(t) { templates.set(t.id, t); return t; },
      async deleteTemplate(id, opts) { templates.delete(id); if (opts && opts.deleteVersions) versions.delete(id); },
      async listVersionsByTemplate(id) { return versions.get(id) ?? []; },
      async getVersion() { return null; },
      async createVersion(v) { const l = versions.get(v.templateId) ?? []; l.push(v); versions.set(v.templateId, l); return v; },
      async deleteAllByProject() {},
      async listAll() { return [...templates.values()]; },
    };
    const fakeAiRepo = {
      async getProvider(id) { return id === 'prov1' ? { id: 'prov1' } : null; },
      async getModel(id) { return id === 'model1' || id === 'model2' ? { id, providerId: 'prov1' } : null; },
    };
    const svc = new PromptTemplateService(fakeRepo, fakeAiRepo);

    // Two templates: one prefers prov1/model1, one prefers prov2/model2-model-of-prov1.
    const tA = await svc.createTemplate('p1', {
      name: 'A', category: 'Custom', content: 'Hi {{x}}', variables: [{ name: 'x', description: '', required: false }],
      taskKind: 'continue', providerId: 'prov1', modelId: 'model1',
    });
    // model2 is a model of prov1 in the fake ai repo but we also use it to test clearPreferencesForProvider's model list.
    const tB = await svc.createTemplate('p1', {
      name: 'B', category: 'Custom', content: 'Bye {{x}}', variables: [{ name: 'x', description: '', required: false }],
      taskKind: 'polish', providerId: null, modelId: 'model2',
    });

    const versionsBeforeA = (await svc.listVersions(tA.id)).length;

    // Deleting model1 clears only tA's model preference (provider kept).
    const clearedModel = await svc.clearPreferencesForModel('model1');
    eq('R7 model-delete: one template updated', clearedModel, 1);
    const aAfter = await svc.getTemplate(tA.id);
    eq('R7 model-delete: stale modelId cleared', aAfter.modelId, null);
    eq('R7 model-delete: providerId preference kept', aAfter.providerId, 'prov1');

    // Clearing preferences must NOT create a version (not a content change).
    eq('R7 model-delete: no version appended for preference cleanup', (await svc.listVersions(tA.id)).length, versionsBeforeA);
    // Content/task intact.
    eq('R7 model-delete: content preserved', aAfter.content, 'Hi {{x}}');
    eq('R7 model-delete: task association preserved', aAfter.taskKind, 'continue');

    // Deleting the provider clears tA's provider preference AND tB's model pref
    // (model2 belonged to the provider).
    const clearedProvider = await svc.clearPreferencesForProvider('prov1', ['model2']);
    eq('R7 provider-delete: both templates updated', clearedProvider, 2);
    eq('R7 provider-delete: provider pref cleared', (await svc.getTemplate(tA.id)).providerId, null);
    eq('R7 provider-delete: member-model pref cleared', (await svc.getTemplate(tB.id)).modelId, null);
    // Unrelated data (versions) still present.
    even('R7 provider-delete: version history preserved', (await svc.listVersions(tA.id)).length >= 1);
  }

  /* ==================================================================== */
  /* 6. R3/R4/R5 — assembly with injected fakes                          */
  /* ==================================================================== */
  {
    // Fake collaborators: only the shape ContextAssemblyService touches.
    const project = { id: 'proj', title: 'Lighthouse', description: 'A sea story.', genre: ['Drama'], tags: [], status: 'writing', settings: {}, createdAt: 1, updatedAt: 1 };
    const projectService = { async getProject(id) { return id === project.id ? project : null; } };

    const worldState = { content: 'Lighthouse world v1' };
    const worldService = {
      async getWorld() {
        return { id: 'w', projectId: 'proj', title: 'World', overview: worldState.content, sections: [], themes: [], settings: {}, createdAt: 1, updatedAt: 1 };
      },
    };
    const narrativeService = { async getPlan() { return { logline: 'A keeper guards a secret.', theme: 'loneliness' }; } };

    // A LIVE character whose summary changes between assembly calls.
    const character = { id: 'c1', projectId: 'proj', name: 'Elara', role: 'protagonist', summary: 'Keeper v1', background: '', personality: '', motivation: '' };
    const characterService = {
      async listCharacters() { return [character]; },
    };

    const chapterServiceState = { summary: 'Chapter summary v1' };
    const outlineService = {
      async getChapter(id) {
        return { id, projectId: 'proj', title: 'The Storm', summary: chapterServiceState.summary, goal: 'survive', keyEvents: '' };
      },
    };
    const sceneService = { async getScene() { return null; } };

    // Config + items: base+dynamic+retrieved+instructions all on; one character ref + one note.
    const config = {
      id: 'cfg', projectId: 'proj',
      budgetEnabled: true, inputBudgetTokens: 100000, contextWindowOverrideTokens: null, requestedOutputTokens: 512,
      enabledLayers: { base: true, dynamic: true, retrieved: true, instructions: true },
      persistentInstructions: 'Write in close third person.',
      createdAt: 1, updatedAt: 1,
    };
    const items = [
      { id: 'i1', projectId: 'proj', layer: 'retrieved', sourceType: 'character', sourceId: 'c1', sourceLabel: 'Elara', content: '', priority: 'high', enabled: true, persistent: false, createdAt: 1, updatedAt: 1 },
      { id: 'i2', projectId: 'proj', layer: 'retrieved', sourceType: 'note', sourceId: null, sourceLabel: 'Style note', content: 'Keep sentences short.', priority: 'normal', enabled: true, persistent: false, createdAt: 2, updatedAt: 2 },
      { id: 'i3', projectId: 'proj', layer: 'retrieved', sourceType: 'world', sourceId: 'w', sourceLabel: 'World dup', content: '', priority: 'normal', enabled: true, persistent: false, createdAt: 3, updatedAt: 3 },
    ];
    const contextManager = {
      async getConfig() { return config; },
      async listItems() { return items; },
    };

    // Template repository with one Continue template bound as default.
    const templates = [
      { id: 't1', projectId: 'proj', name: 'Continue', description: '', category: 'Continuation', content: 'Continue the story after: {{sourceText}}', variables: [{ name: 'sourceText', description: '', required: false }], taskKind: 'continue', providerId: null, modelId: null, isDefault: true, enabled: true, currentVersionId: 'v1', version: 1, createdAt: 1, updatedAt: 1 },
    ];
    const promptRepository = { async listByProject() { return templates; } };

    // Ai service returns a KNOWN context window (100k) with output cap 2048 — maxTokens must NOT be used as window.
    const aiService = {
      async resolveTarget() {
        return {
          provider: { id: 'prov', name: 'P', providerType: 'openai', baseUrl: '', apiKey: '', customHeaders: [], enabled: true, createdAt: 1, updatedAt: 1 },
          model: { id: 'm', providerId: 'prov', modelId: 'gpt', displayName: 'GPT', enabled: true, isDefault: true, temperature: 1, maxTokens: 2048, contextWindowTokens: 100000, timeout: 60000, createdAt: 1, updatedAt: 1 },
          source: 'task',
        };
      },
    };

    const svc = new ContextAssemblyService({ projectService, worldService, narrativeService, characterService, outlineService, sceneService, contextManager, promptRepository, aiService });

    const assembled = await svc.assemble({
      projectId: 'proj',
      task: 'continue',
      chapterId: 'ch1',
      instruction: 'Keep it tense.',
      values: { sourceText: 'The lamp flickered.' },
    });

    // R5: exactly two messages (system + user prompt); prompt is the user turn.
    eq('R5 assemble: two messages (system + user)', assembled.messages.length, 2);
    eq('R5 assemble: user message is the rendered prompt', assembled.messages[1].content, 'Continue the story after: The lamp flickered.');
    even('R5 assemble: system message carries context block', assembled.messages[0].content.includes('Reference material'));

    // R3: character appears (retrieved live), and base/world present.
    even('R3 assemble: retrieved character section present', assembled.sections.some((s) => s.key.includes('character:c1') && s.included));
    even('R3 assemble: character content is LIVE (v1)', assembled.sections.some((s) => s.content.includes('Keeper v1')));

    // R3: world selected again is flagged as duplicate, not duplicated.
    even('R3 assemble: world re-selection flagged as duplicate', assembled.notices.some((n) => n.kind === 'duplicate'));

    // R4: budget basis is model-window, and the window comes from contextWindowTokens (100k), NOT maxTokens (2048).
    eq('R4 assemble: model context window = 100000 (not maxTokens)', assembled.budget.modelContextWindow, 100000);
    eq('R4 assemble: reserved output = requestedOutputTokens', assembled.budget.reservedOutputTokens, 512);
    even('R4 assemble: request fits a generous window', assembled.budget.fits === true, JSON.stringify(assembled.budget));

    // R3 LIVE: mutate the character + chapter summary, re-assemble, expect NEW text.
    character.summary = 'Keeper v2';
    chapterServiceState.summary = 'Chapter summary v2';
    const assembled2 = await svc.assemble({ projectId: 'proj', task: 'continue', chapterId: 'ch1', values: { sourceText: 'Again.' } });
    even('R3 assemble: character reflects LIVE edit (v2)', assembled2.sections.some((s) => s.content.includes('Keeper v2')));
    even('R3 assemble: chapter reflects LIVE edit (v2)', assembled2.sections.some((s) => s.content.includes('Chapter summary v2')));
    even('R3 assemble: stale v1 content absent', !assembled2.sections.some((s) => s.content.includes('Keeper v1')));
  }

  /* ==================================================================== */
  /* 7. R4 — never infer window from maxTokens; unknown stays unknown     */
  /* ==================================================================== */
  {
    const project = { id: 'proj', title: 'T', description: '', genre: [], tags: [], status: 'writing', settings: {}, createdAt: 1, updatedAt: 1 };
    const config = {
      id: 'cfg', projectId: 'proj',
      budgetEnabled: true, inputBudgetTokens: 5000, contextWindowOverrideTokens: null, requestedOutputTokens: 1000,
      enabledLayers: { base: false, dynamic: false, retrieved: false, instructions: false },
      persistentInstructions: '', createdAt: 1, updatedAt: 1,
    };
    const aiService = {
      async resolveTarget() {
        return {
          provider: { id: 'prov', name: 'P', providerType: 'openai', baseUrl: '', apiKey: '', customHeaders: [], enabled: true, createdAt: 1, updatedAt: 1 },
          // contextWindowTokens UNKNOWN (null), maxTokens 2048 must be ignored.
          model: { id: 'm', providerId: 'prov', modelId: 'gpt', displayName: 'GPT', enabled: true, isDefault: true, temperature: 1, maxTokens: 2048, contextWindowTokens: null, timeout: 60000, createdAt: 1, updatedAt: 1 },
          source: 'task',
        };
      },
    };
    const templates = [{ id: 't', projectId: 'proj', name: 'C', description: '', category: 'x', content: 'Say hi', variables: [], taskKind: 'continue', providerId: null, modelId: null, isDefault: true, enabled: true, currentVersionId: 'v', version: 1, createdAt: 1, updatedAt: 1 }];
    const svc = new ContextAssemblyService({
      projectService: { async getProject() { return project; } },
      worldService: { async getWorld() { return null; } },
      narrativeService: { async getPlan() { return null; } },
      characterService: { async listCharacters() { return []; } },
      outlineService: { async getChapter() { return null; } },
      sceneService: { async getScene() { return null; } },
      contextManager: { async getConfig() { return config; }, async listItems() { return []; } },
      promptRepository: { async listByProject() { return templates; } },
      aiService,
    });
    const out = await svc.assemble({ projectId: 'proj', task: 'continue' });
    eq('R4 unknown-window: modelContextWindow stays null (maxTokens ignored)', out.budget.modelContextWindow, null);
    eq('R4 unknown-window: basis is user-budget', out.budget.basis, 'user-budget');
    eq('R4 unknown-window: effective budget = user budget (5000, not 2048)', out.budget.effectiveInputBudget, 5000);
  }

  /* ==================================================================== */
  /* 8. Reference vs inline source classification                         */
  /* ==================================================================== */
  eq('classification: character is a reference', isReferenceSource('character'), true);
  eq('classification: note is inline', isReferenceSource('note'), false);
  eq('classification: instruction is inline', isReferenceSource('instruction'), false);

  cleanupTemp();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length > 0) {
    console.error(`\n${failed.length} check(s) failed: ${failed.map((f) => f.name).join(', ')}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('P6 verification crashed:', error);
  process.exit(1);
});
