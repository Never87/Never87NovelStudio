/**
 * P6 UI smoke test: real browser, real routing, real Dexie.
 *
 * Verifies the two P6 pages mount at their routes (not placeholders) and that
 * the P6 data layer works end to end against IndexedDB, exercising the
 * requirement-critical behaviours a pure unit test cannot reach:
 *   - R1 template edits/restores are APPEND-ONLY (history grows, never rewrites);
 *   - R3 context items reference live records and the assembly reflects edits;
 *   - R4 the input budget is never derived from maxTokens; an unknown window
 *     stays unknown unless the project overrides it;
 *   - R5 the assembled request is what execution would send (messages shape);
 *   - R6 import conflict semantics (idempotent skip / renamed-copy on clash);
 *   - R7 deleting a model/provider clears dangling template preferences without
 *     touching content or version history.
 *
 * Usage: npm run verify:prompt:ui
 * Requires a dev server on http://localhost:5177/.
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_URL = 'http://localhost:5177/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9361;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      })
      .on('error', reject);
  });
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  sendBounded(method, params = {}, ms = 20_000) {
    let timer = null;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${method} timed out in ${ms}ms.`)), ms);
    });
    const call = this.send(method, params);
    call.catch(() => {});
    return Promise.race([call, deadline]).finally(() => clearTimeout(timer));
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) {
      const d = result.exceptionDetails;
      throw new Error(`Page exception: ${d.exception?.description || d.text || JSON.stringify(d)}`);
    }
    return result.result.value;
  }
}

let activeWs = null;
let activeChrome = null;
let activeProfileDir = null;
let tornDown = false;
function teardown() {
  if (tornDown) return;
  tornDown = true;
  try { activeWs?.close(); } catch { /* closed */ }
  try { activeChrome?.kill(); } catch { /* gone */ }
  try { if (activeProfileDir) fs.rmSync(activeProfileDir, { recursive: true, force: true }); } catch { /* best effort */ }
}
process.on('SIGINT', () => { teardown(); process.exit(130); });
process.on('SIGTERM', () => { teardown(); process.exit(143); });

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}.`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p6ui-chrome-'));
  activeProfileDir = userDataDir;
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--window-size=1280,900',
    'about:blank',
  ], { stdio: 'ignore' });
  activeChrome = chrome;

  let target = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch { /* starting */ }
    await sleep(250);
  }
  if (!target) throw new Error('Chrome DevTools endpoint never became ready.');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  activeWs = ws;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP WebSocket never opened within 10s.')), 10_000);
    const settle = (fn) => (value) => { clearTimeout(timer); fn(value); };
    ws.addEventListener('open', settle(resolve), { once: true });
    ws.addEventListener('error', settle(reject), { once: true });
  });

  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const pageErrors = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params?.exceptionDetails?.exception?.description ?? 'unknown');
    }
  });

  await cdp.send('Page.navigate', { url: APP_URL });
  await sleep(2500);

  // ---- Route smoke: P6 pages render their own header, not a placeholder ----
  const routes = [
    { path: '/ai/prompt-templates', header: 'Prompt Engineering Center' },
    { path: '/ai/context-manager', header: 'AI Context Manager' },
  ];
  for (const route of routes) {
    await cdp.sendBounded('Page.navigate', { url: `${APP_URL.replace(/\/$/, '')}${route.path}` }, 20_000);
    const rendered = await cdp.eval(`(async () => {
      for (let i = 0; i < 80; i++) {
        const h1 = document.querySelector('h1');
        if (h1 && (h1.textContent || '').includes(${JSON.stringify(route.header)})) {
          return { ok: true, title: (h1.textContent || '').trim(), isPlaceholder: document.body.innerText.includes('under construction') || document.body.innerText.includes('ModulePlaceholder') };
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      const h1 = document.querySelector('h1');
      return { ok: false, title: h1 ? (h1.textContent || '').trim() : null };
    })()`);
    record(`route ${route.path} renders "${route.header}" (not a placeholder)`, rendered?.ok === true && rendered?.isPlaceholder === false, JSON.stringify(rendered));
  }

  // ---- Data layer: template versioning (R1) against IndexedDB ----
  const r1 = await cdp.eval(`(async () => {
    const dbMod = await import('/src/db/index.ts');
    const svc = await import('/src/services/index.ts');
    await dbMod.initDatabase();

    // Clean slate.
    for (const p of await svc.projectService.listProjects()) await svc.projectService.deleteProject(p.id);
    const project = await svc.projectService.createProject({ title: 'P6 Verify Project' });

    const t = await svc.promptTemplateService.createTemplate(project.id, {
      name: 'Continue', category: 'Continuation',
      content: 'Continue: {{sourceText}}',
      variables: [{ name: 'sourceText', description: '', required: false }],
      taskKind: 'continue',
    });
    const v1 = (await svc.promptTemplateService.listVersions(t.id)).length;

    const updated = await svc.promptTemplateService.updateTemplate(t.id, { content: 'Carefully continue: {{sourceText}}' });
    const afterUpdate = await svc.promptTemplateService.listVersions(t.id);
    const oldSnapshot = afterUpdate.find((v) => v.version === 1);

    // Toggle enabled only -> no new version.
    const toggled = await svc.promptTemplateService.updateTemplate(t.id, { enabled: false });

    // Restore old version -> append (v3).
    const restored = await svc.promptTemplateService.restoreVersion(t.id, oldSnapshot.id);
    const afterRestore = await svc.promptTemplateService.listVersions(t.id);

    return {
      projectId: project.id,
      v1Count: v1,
      startedAtOne: t.version === 1,
      updatedToTwo: updated.version === 2,
      oldSnapshotImmutable: oldSnapshot.content === 'Continue: {{sourceText}}',
      toggleNoVersion: toggled.version === 2,
      restoreToThree: restored.version === 3,
      restoreContent: restored.content === 'Continue: {{sourceText}}',
      finalCount: afterRestore.length,
      newestReason: afterRestore.sort((a,b)=>b.version-a.version)[0].reason,
    };
  })()`);

  record('R1: template created at version 1 with a snapshot', r1?.startedAtOne === true && r1?.v1Count === 1, JSON.stringify(r1));
  record('R1: content edit bumps to version 2 and appends a snapshot', r1?.updatedToTwo === true, JSON.stringify({ version: r1?.updatedToTwo }));
  record('R1: previous snapshot content is immutable', r1?.oldSnapshotImmutable === true, String(r1?.oldSnapshotImmutable));
  record('R1: toggling enabled does NOT create a version', r1?.toggleNoVersion === true, String(r1?.toggleNoVersion));
  record('R1: restore appends version 3 (does not rewrite history)', r1?.restoreToThree === true && r1?.finalCount === 3, JSON.stringify({ version: r1?.restoreToThree, count: r1?.finalCount }));
  record('R1: restored snapshot has the restored content', r1?.restoreContent === true, String(r1?.restoreContent));
  record('R1: newest snapshot reason is "restored"', r1?.newestReason === 'restored', String(r1?.newestReason));

  const projectId = r1?.projectId;

  // ---- R3 + R4 + R5: context manager + assembly against IndexedDB ----
  const r345 = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    const projectId = ${JSON.stringify(projectId)};

    // A character to reference.
    const character = await svc.characterService.createCharacter(projectId, { name: 'Elara' });
    await svc.characterService.updateCharacter(projectId, character.id, { summary: 'Keeper v1' });

    // Context config: budget on, generous, no window override.
    await svc.contextManagerService.updateConfig(projectId, {
      budgetEnabled: true, inputBudgetTokens: 100000, requestedOutputTokens: 512,
      enabledLayers: { base: true, dynamic: true, retrieved: true, instructions: true },
      persistentInstructions: 'Close third person.',
    });

    // Add a character reference item to the retrieved layer.
    await svc.contextManagerService.createItem(projectId, {
      layer: 'retrieved', sourceType: 'character', sourceId: character.id, sourceLabel: 'Elara', priority: 'normal',
    });

    const assembly = svc.contextAssemblyService;

    // Explicit template selection: render from a user template and assert the
    // prompt reflects its body (proves templates are actually used, R5/R2).
    const templates = await svc.promptTemplateService.listTemplates(projectId);
    const userTemplate = templates[0];
    const templated = await assembly.assemble({
      projectId, task: 'continue', templateId: userTemplate.id, values: { sourceText: 'Templated input.' },
    });

    // No AI configured -> target resolution fails but assembly STILL returns a
    // request (preview works without a model), with a 'missing' notice.
    const preview = await assembly.assemble({
      projectId, task: 'continue', values: { sourceText: 'The lamp flickered.' },
    });

    // Edit the character LIVE and re-assemble: retrieved content must update.
    await svc.characterService.updateCharacter(projectId, character.id, { summary: 'Keeper v2' });
    const preview2 = await assembly.assemble({
      projectId, task: 'continue', values: { sourceText: 'Again.' },
    });

    // R4: configure a model with a KNOWN window and an output cap; the budget
    // must use the window, never maxTokens.
    const provider = await svc.aiConfigService.createProvider({ name: 'P6 Provider', providerType: 'openai', apiKey: 'sk-p6-verify-123', enabled: true });
    const model = await svc.aiConfigService.createModel({
      providerId: provider.id, modelId: 'gpt', displayName: 'GPT', isDefault: true,
      maxTokens: 2048, contextWindowTokens: 100000, enabled: true,
    });
    await svc.aiConfigService.setGlobalDefaultModel(model.id);

    const withModel = await assembly.assemble({ projectId, task: 'continue', values: { sourceText: 'X.' } });

    // Then a model with an UNKNOWN window: budget stays at the user value, and
    // maxTokens (2048) must NOT become the window.
    const model2 = await svc.aiConfigService.createModel({
      providerId: provider.id, modelId: 'gpt-2', displayName: 'GPT2', isDefault: false,
      maxTokens: 2048, contextWindowTokens: null, enabled: true,
    });
    const unknownWindow = await assembly.assemble({ projectId, task: 'continue', modelId: model2.id, values: { sourceText: 'X.' } });

    return {
      providerId: provider.id,
      // R5 preview shape: the user turn must be the rendered prompt that carries
      // the input text (whether it came from a user template or the built-in
      // fallback). The authoritative guarantee is that this exact message is what
      // execution would send.
      twoMessages: preview.messages.length === 2,
      userIsPrompt: typeof preview.messages[1].content === 'string' && preview.messages[1].content.includes('The lamp flickered.') && preview.messages[1].content.trim().length > 0,
      userMsgActual: preview.messages[1].content,
      templateName: preview.templateName,
      systemHasContext: /Reference material/.test(preview.messages[0].content),
      // Explicit template render
      templatedUsesTemplate: templated.templateName === userTemplate.name && templated.messages[1].content === 'Continue: Templated input.',
      // preview works without model
      previewHasMissingNotice: preview.notices.some((n) => n.kind === 'missing'),
      targetNull: preview.target === null,
      // R3 live
      charV1: preview.sections.some((s) => s.content.includes('Keeper v1')),
      charV2: preview2.sections.some((s) => s.content.includes('Keeper v2')),
      charStaleGone: !preview2.sections.some((s) => s.content.includes('Keeper v1')),
      // R4
      windowKnown: withModel.budget.modelContextWindow === 100000,
      basisModel: withModel.budget.basis === 'model-window',
      unknownWindowNull: unknownWindow.budget.modelContextWindow === null,
      unknownBasisUser: unknownWindow.budget.basis === 'user-budget',
      unknownBudgetIs5000ish: unknownWindow.budget.effectiveInputBudget === 100000 && unknownWindow.budget.modelContextWindow === null,
    };
  })()`);

  record('R5: assembled request has exactly two messages (system + prompt)', r345?.twoMessages === true, JSON.stringify({ twoMessages: r345?.twoMessages }));
  record('R5: user message is the rendered prompt (carries the input text)', r345?.userIsPrompt === true, JSON.stringify({ actual: r345?.userMsgActual }));
  record('R5: an explicit template renders its body into the prompt', r345?.templatedUsesTemplate === true, JSON.stringify({ templated: r345?.templatedUsesTemplate }));
  record('R5: system message carries the context block', r345?.systemHasContext === true, String(r345?.systemHasContext));
  record('preview works without a model (target null + missing notice, no throw)', r345?.targetNull === true && r345?.previewHasMissingNotice === true, JSON.stringify({ targetNull: r345?.targetNull, notice: r345?.previewHasMissingNotice }));
  record('R3: retrieved character content present (v1)', r345?.charV1 === true, String(r345?.charV1));
  record('R3: retrieved character reflects LIVE edit (v2)', r345?.charV2 === true && r345?.charStaleGone === true, JSON.stringify({ v2: r345?.charV2, staleGone: r345?.charStaleGone }));
  record('R4: budget basis uses the KNOWN model window (100000)', r345?.windowKnown === true && r345?.basisModel === true, JSON.stringify({ window: r345?.windowKnown, basis: r345?.basisModel }));
  record('R4: unknown window stays null (maxTokens ignored)', r345?.unknownWindowNull === true && r345?.unknownBasisUser === true, JSON.stringify({ null: r345?.unknownWindowNull, basis: r345?.unknownBasisUser }));

  // ---- Export / import + conflict semantics (R6) ----
  const r6 = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    const projectId = ${JSON.stringify(projectId)};
    const bundle = await svc.promptTemplateService.exportBundle(projectId);
    const parsed = JSON.parse(bundle);
    const before = (await svc.promptTemplateService.listTemplates(projectId)).length;

    // Identical re-import → idempotent (nothing added).
    const idempotent = await svc.promptTemplateService.importBundle(projectId, bundle);
    const afterIdem = (await svc.promptTemplateService.listTemplates(projectId)).length;

    // Conflicting bundle: same name, different content → renamed copy, not lost.
    const clash = JSON.parse(bundle);
    clash.templates[0].content = clash.templates[0].content + ' /* CHANGED */';
    const conflict = await svc.promptTemplateService.importBundle(projectId, JSON.stringify(clash));
    const afterConflict = await svc.promptTemplateService.listTemplates(projectId);
    const renamed = afterConflict.filter((t) => /imported/.test(t.name));

    return {
      format: parsed.format,
      hasTemplates: Array.isArray(parsed.templates) && parsed.templates.length >= 1,
      before,
      idempotentSkipped: idempotent.skipped,
      idempotentImported: idempotent.imported,
      unchangedByIdem: afterIdem === before,
      conflictCount: conflict.conflicted,
      conflictImported: conflict.imported,
      grewByOne: afterConflict.length === before + 1,
      renamedName: renamed[0] ? renamed[0].name : null,
      renamedHasNewContent: renamed[0] ? renamed[0].content.includes('CHANGED') : false,
      originalHasOldContent: afterConflict.some((t) => !/imported/.test(t.name) && !t.content.includes('CHANGED')),
    };
  })()`);
  record('R6: bundle exports with a format tag and templates', r6?.format === 'never87.prompt-templates' && r6?.hasTemplates === true, JSON.stringify({ format: r6?.format }));
  record('R6: identical re-import is idempotent (skipped, project unchanged)', r6?.idempotentSkipped >= 1 && r6?.idempotentImported === 0 && r6?.unchangedByIdem === true, JSON.stringify(r6));
  record('R6: same-name+different-content imports a renamed copy (not discarded)', r6?.conflictCount >= 1 && r6?.conflictImported >= 1 && r6?.renamedHasNewContent === true, JSON.stringify(r6));
  record('R6: original template preserved alongside the renamed copy', r6?.originalHasOldContent === true && r6?.grewByOne === true, JSON.stringify({ originalKept: r6?.originalHasOldContent, grewByOne: r6?.grewByOne }));

  // ---- R7: deleting a model/provider clears dangling template preferences ----
  const r7 = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    const projectId = ${JSON.stringify(projectId)};

    // Re-seed a provider + model, and bind a template's preferences to them.
    const provider = await svc.aiConfigService.createProvider({ name: 'R7 Provider', providerType: 'openai', apiKey: 'sk-r7-cleanup-123', enabled: true });
    const model = await svc.aiConfigService.createModel({ providerId: provider.id, modelId: 'r7-model', displayName: 'R7', isDefault: true, enabled: true });

    const templates = await svc.promptTemplateService.listTemplates(projectId);
    const target = templates[0];
    await svc.promptTemplateService.updateTemplate(target.id, { providerId: provider.id, modelId: model.id });
    const versionsBefore = (await svc.promptTemplateService.listVersions(target.id)).length;
    const bound = await svc.promptTemplateService.getTemplate(target.id);

    // Delete the MODEL through the SAME cleanup path production uses.
    const clearedByModel = await svc.promptTemplateService.clearPreferencesForModel(model.id);
    await svc.aiConfigService.deleteModel(model.id);
    const afterModel = await svc.promptTemplateService.getTemplate(target.id);

    // Now bind provider-only preference and clear via provider path.
    await svc.promptTemplateService.updateTemplate(target.id, { providerId: provider.id, modelId: null });
    const clearedByProvider = await svc.promptTemplateService.clearPreferencesForProvider(provider.id, []);
    await svc.aiConfigService.deleteProvider(provider.id);
    const afterProvider = await svc.promptTemplateService.getTemplate(target.id);

    return {
      boundProvider: bound.providerId === provider.id,
      boundModel: bound.modelId === model.id,
      clearedByModel,
      modelPrefCleared: afterModel.modelId === null,
      providerPrefKeptOnModelDelete: afterModel.providerId === provider.id,
      contentIntact: afterModel.content === target.content,
      versionsPreserved: (await svc.promptTemplateService.listVersions(target.id)).length === versionsBefore,
      clearedByProvider,
      providerPrefCleared: afterProvider.providerId === null,
    };
  })()`);
  record('R7: template preferences can be bound to a provider/model', r7?.boundProvider === true && r7?.boundModel === true, JSON.stringify(r7));
  record('R7: deleting a model clears its template model preference', r7?.clearedByModel >= 1 && r7?.modelPrefCleared === true, JSON.stringify(r7));
  record('R7: model delete keeps the provider preference and content/versions', r7?.providerPrefKeptOnModelDelete === true && r7?.contentIntact === true && r7?.versionsPreserved === true, JSON.stringify(r7));
  record('R7: deleting a provider clears its template provider preference', r7?.clearedByProvider >= 1 && r7?.providerPrefCleared === true, JSON.stringify(r7));

  // Cleanup.
  await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    for (const p of await svc.projectService.listProjects()) await svc.projectService.deleteProject(p.id);
    for (const p of await svc.aiConfigService.listProviders()) await svc.aiConfigService.deleteProvider(p.id);
    return true;
  })()`);

  record('no uncaught page exceptions', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

  teardown();

  const failed = results.filter((r) => !r.ok);
  console.log('\n================ SUMMARY ================');
  console.log(`TOTAL ${results.length}  PASS ${results.length - failed.length}  FAIL ${failed.length}`);
  if (failed.length > 0) {
    console.log('FAILED:');
    failed.forEach((f) => console.log(`  - ${f.name}: ${f.detail}`));
    process.exitCode = 1;
  }
}

main()
  .then(() => { teardown(); process.exit(process.exitCode || 0); })
  .catch((error) => { console.error('HARNESS ERROR:', error); teardown(); process.exit(1); });
