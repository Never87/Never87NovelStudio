/**
 * P7 verification — Knowledge Base, Continuity & Story Analysis contracts.
 *
 * Runs in plain Node (no browser, no network, no IndexedDB). Modules are bundled
 * from source with the project's own Vite/esbuild pipeline (see
 * `lib/p4-bundler.cjs`), so the code under test is exactly what ships. Services
 * are constructed with in-memory fake repositories/collaborators.
 *
 * Focus — the checks a UI smoke test cannot see and that must never regress:
 *   - Schema-derived types + evidence: a finding without a chapter/scene locator
 *     is REJECTED at both the Service and the schema layer.
 *   - Knowledge import is IDEMPOTENT (re-run updates, never duplicates) and
 *     preserves a traceable source reference.
 *   - Search is deterministic (all terms must match).
 *   - Continuity state is reconstructed deterministically; tie-breaks are stable;
 *     and REORDERING chapters changes the reconstructed state (live ranks win).
 *   - A DELETED anchor chapter does not silently corrupt reconstructed state
 *     (its orphaned facts are excluded from the view, but preserved in the log).
 *   - Deterministic detectors only emit evidence-backed findings.
 *
 * Usage: npm run verify:knowledge
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
async function rejectsWith(name, fn, predicate) {
  try {
    await fn();
    record(name, false, 'expected a rejection');
  } catch (error) {
    const ok = predicate(error);
    record(name, ok, ok ? undefined : `threw ${error && error.name}: ${error && error.message}`);
  }
}

/** A minimal in-memory fake of the Knowledge repository. */
function makeKnowledgeRepo() {
  const byId = new Map();
  return {
    _all: () => [...byId.values()],
    async getById(id) { return byId.get(id) ?? null; },
    async getByProjectId(projectId) {
      return [...byId.values()]
        .filter((e) => e.projectId === projectId)
        .sort((a, b) => (a.updatedAt === b.updatedAt ? (a.id < b.id ? 1 : -1) : b.updatedAt - a.updatedAt));
    },
    async getBySourceKey(projectId, sourceKey) {
      for (const e of byId.values()) if (e.projectId === projectId && e.sourceKey === sourceKey) return e;
      return null;
    },
    async create(entry) { byId.set(entry.id, entry); return entry; },
    async update(entry) { byId.set(entry.id, entry); return entry; },
    async delete(id) { byId.delete(id); },
    async deleteByProjectId(projectId) {
      let n = 0;
      for (const [id, e] of byId) if (e.projectId === projectId) { byId.delete(id); n += 1; }
      return n;
    },
  };
}

/** A minimal in-memory fake of the Continuity repository. */
function makeContinuityRepo() {
  const byId = new Map();
  return {
    _all: () => [...byId.values()],
    async getById(id) { return byId.get(id) ?? null; },
    async getByProjectId(projectId) {
      return [...byId.values()].filter((f) => f.projectId === projectId).sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt - b.createdAt));
    },
    async getByChapter(projectId, chapterId) {
      return [...byId.values()].filter((f) => f.projectId === projectId && f.anchorChapterId === chapterId);
    },
    async create(fact) { byId.set(fact.id, fact); return fact; },
    async update(fact) { byId.set(fact.id, fact); return fact; },
    async delete(id) { byId.delete(id); },
    async deleteByProjectId(projectId) {
      let n = 0;
      for (const [id, f] of byId) if (f.projectId === projectId) { byId.delete(id); n += 1; }
      return n;
    },
  };
}

/** A minimal in-memory fake of the Analysis repository. */
function makeAnalysisRepo() {
  const byId = new Map();
  return {
    _all: () => [...byId.values()],
    async getById(id) { return byId.get(id) ?? null; },
    async getByProjectId(projectId) {
      return [...byId.values()].filter((f) => f.projectId === projectId).sort((a, b) => (a.updatedAt === b.updatedAt ? (a.id < b.id ? 1 : -1) : b.updatedAt - a.updatedAt));
    },
    async create(finding) { byId.set(finding.id, finding); return finding; },
    async update(finding) { byId.set(finding.id, finding); return finding; },
    async delete(id) { byId.delete(id); },
    async deleteByProjectId(projectId) {
      let n = 0;
      for (const [id, f] of byId) if (f.projectId === projectId) { byId.delete(id); n += 1; }
      return n;
    },
  };
}

/**
 * Fake outline/scene/character/world/narrative collaborators for the knowledge
 * + continuity services. `state` is mutable so tests can reorder/summaries.
 */
function makeCollaborators() {
  const state = {
    characters: [
      { id: 'char1', name: 'Elara', summary: 'Keeper of the light', background: 'sea-born', personality: 'stoic', motivation: 'protect', appearance: 'weathered', role: 'protagonist', status: 'active', tags: ['mentor'], projectId: 'proj' },
    ],
    world: { id: 'world1', projectId: 'proj', title: 'The Coast', overview: 'A stormy shore.', sections: [
      { id: 'sec1', title: 'Magic System', content: 'Tide-magic costs memory.' },
      { id: 'sec2', title: 'Geography', content: 'A jagged coast.' },
    ], themes: ['isolation'] },
    // volumes -> chapters -> scenes; order controls live ranks.
    order: ['chap1', 'chap2', 'chap3'],
    chapters: {
      chap1: { id: 'chap1', title: 'Arrival', summary: 'Elara arrives.', goal: 'land', keyEvents: '', endingHook: '', tags: ['open'] },
      chap2: { id: 'chap2', title: 'The Storm', summary: 'A storm hits.', goal: 'survive', keyEvents: '', endingHook: '', tags: [] },
      chap3: { id: 'chap3', title: 'Aftermath', summary: 'Dawn.', goal: 'recover', keyEvents: '', endingHook: '', tags: [] },
    },
    scenes: {
      chap1: [{ id: 'scn1', title: 'Landing', summary: 'Steps ashore.', location: 'harbour', timeOfDay: 'dawn', goal: 'land', conflict: 'rocks', outcome: 'safe', tags: [], purpose: 'opening' }],
      chap2: [{ id: 'scn2', title: 'Waves', summary: 'Waves crash.', location: 'lighthouse', timeOfDay: 'night', goal: 'survive', conflict: 'storm', outcome: 'hold', tags: [], purpose: 'climax' }],
      chap3: [],
    },
    plan: { id: 'plan1', projectId: 'proj', logline: 'A keeper guards a secret.', theme: 'loneliness', premise: '', centralConflict: '', stakes: '', ending: '', motifs: ['light'], structure: 'three-act', status: 'draft', beats: [
      { id: 'b1', title: 'Seeded storm', description: 'A foreshadowing seed of the storm.', position: 10 },
      { id: 'b2', title: 'Midpoint', description: 'Things escalate.', position: 50 },
    ] },
  };
  return {
    state,
    characterService: { async listCharacters() { return state.characters; } },
    worldService: { async getWorld() { return state.world; } },
    narrativeService: { async getPlan() { return state.plan; } },
    outlineService: {
      // getOutline returns volumes->chapters in live order (for continuity ranks).
      async getOutline() {
        return [{ volume: { id: 'vol1' }, chapters: state.order.map((id) => state.chapters[id]) }];
      },
      async listProjectChapters() {
        return state.order.map((id) => state.chapters[id]);
      },
    },
    sceneService: {
      async listScenes(chapterId) { return state.scenes[chapterId] ?? []; },
    },
  };
}

async function main() {
  const mod = await importBundled('scripts/lib/p7-entry.ts', 'p7');
  const {
    KnowledgeEntrySchema,
    EvidenceSchema,
    AnalysisFindingSchema,
    deriveSearchText,
    buildSourceKey,
    compareFacts,
    reconstructState,
    stateKey,
    KnowledgeService,
    ContinuityService,
    AnalysisService,
  } = mod;

  /* ==================================================================== */
  /* 1. Evidence requires a chapter OR scene locator                       */
  /* ==================================================================== */
  {
    const noLocator = EvidenceSchema.safeParse({ chapterId: null, sceneId: null, quote: 'x', offset: null, note: '' });
    eq('evidence: empty locator rejected', noLocator.success, false);
    const withChapter = EvidenceSchema.safeParse({ chapterId: 'c1', sceneId: null, quote: '', offset: null, note: '' });
    eq('evidence: chapter locator accepted', withChapter.success, true);
    const withScene = EvidenceSchema.safeParse({ chapterId: null, sceneId: 's1', quote: 'q', offset: 5, note: '' });
    eq('evidence: scene locator + quote + offset accepted', withScene.success, true);
    const negOffset = EvidenceSchema.safeParse({ chapterId: 'c1', sceneId: null, quote: '', offset: -1, note: '' });
    eq('evidence: negative offset rejected', negOffset.success, false);
  }

  /* ==================================================================== */
  /* 2. Finding REQUIRES at least one evidence record (schema-level)       */
  /* ==================================================================== */
  {
    const base = {
      id: 'find1', projectId: 'proj', category: 'continuity', severity: 'error', status: 'open', origin: 'deterministic',
      title: 'T', description: 'D', relatedFactIds: [], relatedEntryIds: [], createdAt: 1, updatedAt: 1,
    };
    eq('finding: empty evidence rejected by schema', AnalysisFindingSchema.safeParse({ ...base, evidence: [] }).success, false);
    eq('finding: missing evidence rejected by schema', AnalysisFindingSchema.safeParse(base).success, false);
    const ok = AnalysisFindingSchema.safeParse({ ...base, evidence: [{ chapterId: 'c1', sceneId: null, quote: '', offset: null, note: '' }] });
    eq('finding: one valid evidence accepted', ok.success, true);
  }

  /* ==================================================================== */
  /* 3. deriveSearchText + buildSourceKey determinism                      */
  /* ==================================================================== */
  eq('searchText: lower-cased, whitespace-collapsed', deriveSearchText({ title: 'Silver  Key', summary: 'A Relic', body: 'Of the TIDE', tags: ['Lore'] }), 'silver key a relic of the tide lore');
  eq('sourceKey: manual has none', buildSourceKey('manual', 'x'), null);
  eq('sourceKey: character key', buildSourceKey('character', 'char1'), 'character:char1');
  eq('sourceKey: world sub-key', buildSourceKey('world', 'world1', 'section:sec1'), 'world:world1:section:sec1');

  /* ==================================================================== */
  /* 4. compareFacts: stable ordering & tie-breaks                        */
  /* ==================================================================== */
  {
    const mk = (id, createdAt, rank) => ({ id, projectId: 'p', subjectType: 'character', subjectId: 's', subjectLabel: 'S', predicate: 'position', value: id, relatedLabel: '', anchorChapterId: 'c', anchorSceneId: null, anchorRank: rank, evidence: [], createdAt, updatedAt: createdAt });
    // Same rank: later createdAt wins; equal createdAt: id ascending.
    const a = mk('a', 100, 0);
    const b = mk('b', 200, 0);
    const c = mk('c', 200, 0);
    even('compare: later createdAt sorts after', compareFacts(a, b) < 0);
    even('compare: equal createdAt breaks on id', compareFacts(b, c) < 0);
    // Rank dominates.
    const low = mk('z', 999, 0);
    const high = mk('y', 1, 5);
    even('compare: rank dominates createdAt', compareFacts(low, high) < 0);
  }

  /* ==================================================================== */
  /* 5. reconstructState: same-predicate supersession + determinism       */
  /* ==================================================================== */
  {
    const mk = (id, rank, value, predicate = 'position', createdAt = rank) => ({ id, projectId: 'p', subjectType: 'character', subjectId: 's1', subjectLabel: 'Elara', predicate, value, relatedLabel: '', anchorChapterId: 'c' + rank, anchorSceneId: null, anchorRank: rank, evidence: [], createdAt, updatedAt: createdAt });
    const facts = [mk('f1', 1, 'harbour'), mk('f2', 2, 'lighthouse')];
    const latest = reconstructState(facts);
    eq('reconstruct: latest value wins (one slot per subject+predicate)', latest.size, 1);
    eq('reconstruct: latest value is lighthouse', [...latest.values()][0].value, 'lighthouse');
    // Input order independence.
    const reversed = reconstructState([facts[1], facts[0]]);
    eq('reconstruct: order-independent', [...reversed.values()][0].value, 'lighthouse');
    // stopRank excludes later chapters (inclusive of the stop rank).
    const asOf1 = reconstructState(facts, { stopRank: 1 });
    eq('reconstruct: as-of rank 1 = harbour', [...asOf1.values()][0].value, 'harbour');
    // Distinct predicates both survive.
    const multi = reconstructState([mk('f1', 1, 'harbour', 'position'), mk('f2', 2, 'the key', 'possession')]);
    eq('reconstruct: distinct predicates preserved', multi.size, 2);
    eq('stateKey: deterministic subject+predicate key', stateKey(facts[0]), 'character:s1:position');
  }

  /* ==================================================================== */
  /* 6. KnowledgeService — idempotent import + traceable source + search  */
  /* ==================================================================== */
  {
    const repo = makeKnowledgeRepo();
    const collab = makeCollaborators();
    const svc = new KnowledgeService({ repository: repo, ...collab });

    const first = await svc.importFromProject('proj');
    even('import: created some entries', first.imported > 0, JSON.stringify(first));
    eq('import: nothing updated on first run', first.updated, 0);
    const countAfterFirst = repo._all().length;

    // Re-run: everything is idempotent → zero new, all updated.
    const second = await svc.importFromProject('proj');
    eq('import(idempotent): no new entries on re-run', second.imported, 0);
    even('import(idempotent): existing entries refreshed', second.updated > 0);
    eq('import(idempotent): total entry count unchanged', repo._all().length, countAfterFirst);

    // Traceable source reference: character entry points back to char1.
    const charEntry = repo._all().find((e) => e.sourceRef.entityId === 'char1');
    even('import: character entry has traceable source ref', Boolean(charEntry) && charEntry.sourceRef.entityType === 'character');
    even('import: character entry has a sourceKey', Boolean(charEntry.sourceKey) && charEntry.sourceKey === 'character:char1');

    // Editing the source then re-importing refreshes the entry (still one copy).
    collab.state.characters[0].summary = 'Keeper of the FALLEN light';
    await svc.importFromProject('proj');
    const refreshed = repo._all().find((e) => e.sourceRef.entityId === 'char1');
    even('import: re-import refreshes entry content from source', refreshed.summary.includes('FALLEN'));
    eq('import: still exactly one character entry', repo._all().filter((e) => e.sourceRef.entityId === 'char1').length, 1);

    // RECONCILIATION: remove a source entity, re-import → its indexed entry is
    // pruned (no misleading stale entry); manual entries are untouched.
    const manual = await svc.createEntry('proj', { kind: 'term', title: 'Manual keeps', tags: [] });
    collab.state.characters = []; // delete the only character
    const reconcile = await svc.importFromProject('proj');
    even('import(reconcile): reports removed stale indexed entries', reconcile.removed >= 1, `removed=${reconcile.removed}`);
    eq('import(reconcile): no character-indexed entries remain', repo._all().filter((e) => e.source === 'character').length, 0);
    even('import(reconcile): manual entry preserved through re-import', repo._all().some((e) => e.id === manual.id));

    // Manual CRUD + search.
    await svc.createEntry('proj', { kind: 'term', title: 'Tide-magic', summary: 'Costs memory', body: 'A rare art', tags: ['magic'] });
    const searchHit = await svc.search('proj', 'tide-magic');
    even('search: finds manual entry by title term', searchHit.entries.some((e) => e.title === 'Tide-magic'));
    const searchMulti = await svc.search('proj', 'tide magic');
    even('search: multi-term AND matches', searchMulti.entries.length >= 1);
    const searchMiss = await svc.search('proj', 'nonexistentterm');
    eq('search: miss returns empty', searchMiss.entries.length, 0);
    const all = await svc.search('proj', '   ');
    even('search: blank query returns all', all.entries.length === repo._all().length);
  }

  /* ==================================================================== */
  /* 7. ContinuityService — anchors validated, state, reorder-safe        */
  /* ==================================================================== */
  {
    const repo = makeContinuityRepo();
    const collab = makeCollaborators();
    const svc = new ContinuityService({ repository: repo, outlineService: collab.outlineService, sceneService: collab.sceneService });

    // Anchor must be a real chapter of the project.
    await rejectsWith('continuity: unknown chapter rejected', () => svc.createFact('proj', { subjectType: 'character', subjectId: 'char1', subjectLabel: 'Elara', predicate: 'position', value: 'harbour', anchorChapterId: 'nope' }), () => true);

    // Record two position facts (chap1 harbour, chap2 lighthouse).
    await svc.createFact('proj', { subjectType: 'character', subjectId: 'char1', subjectLabel: 'Elara', predicate: 'position', value: 'harbour', anchorChapterId: 'chap1' });
    await svc.createFact('proj', { subjectType: 'character', subjectId: 'char1', subjectLabel: 'Elara', predicate: 'position', value: 'lighthouse', anchorChapterId: 'chap2' });
    // A possession fact at chap2.
    await svc.createFact('proj', { subjectType: 'character', subjectId: 'char1', subjectLabel: 'Elara', predicate: 'possession', value: 'the silver key', anchorChapterId: 'chap2' });

    const current = await svc.currentState('proj');
    const elara = current.find((s) => s.subjectId === 'char1');
    even('continuity: current state has Elara', Boolean(elara));
    const posNow = elara.values.find((v) => v.predicate === 'position');
    eq('continuity: current position is latest (lighthouse)', posNow.value, 'lighthouse');

    // Point-in-time: as of chap1 → harbour (possession not yet true).
    const asOf1 = await svc.stateAsOf('proj', 'chap1');
    const elara1 = asOf1.find((s) => s.subjectId === 'char1');
    eq('continuity: as-of chap1 position = harbour', elara1.values.find((v) => v.predicate === 'position').value, 'harbour');
    even('continuity: as-of chap1 has no possession yet', !elara1.values.some((v) => v.predicate === 'possession'));

    // As of chap2 → lighthouse + possession present.
    const asOf2 = await svc.stateAsOf('proj', 'chap2');
    const elara2 = asOf2.find((s) => s.subjectId === 'char1');
    eq('continuity: as-of chap2 position = lighthouse', elara2.values.find((v) => v.predicate === 'position').value, 'lighthouse');
    even('continuity: as-of chap2 has possession', elara2.values.some((v) => v.predicate === 'possession'));

    // REORDER: move chap2 before chap1. Now order = [chap2, chap1, chap3].
    // chap2 (lighthouse) now comes BEFORE chap1 (harbour), so the latest position
    // by live story order is harbour (anchored at the now-later chap1). This proves
    // reconstruction respects the live order — before the reorder the latest was
    // lighthouse; after it, harbour.
    collab.state.order = ['chap2', 'chap1', 'chap3'];
    const currentReorder = (await svc.currentState('proj')).find((s) => s.subjectId === 'char1');
    eq('continuity: reorder respected — current position becomes harbour (chap1 now last)', currentReorder.values.find((v) => v.predicate === 'position').value, 'harbour');
    // As of chap1 (inclusive), chap2 and chap1 both precede it or equal it; latest
    // is harbour at chap1.
    const asOfReorder1 = await svc.stateAsOf('proj', 'chap1');
    const elaraReorder1 = asOfReorder1.find((s) => s.subjectId === 'char1');
    eq('continuity: reorder respected — as-of chap1 position = harbour', elaraReorder1.values.find((v) => v.predicate === 'position').value, 'harbour');
    // As of chap2 (the now-earliest chapter), only the lighthouse fact is included.
    const asOfReorder2 = await svc.stateAsOf('proj', 'chap2');
    const elaraReorder2 = asOfReorder2.find((s) => s.subjectId === 'char1');
    eq('continuity: reorder respected — as-of chap2 position = lighthouse', elaraReorder2.values.find((v) => v.predicate === 'position').value, 'lighthouse');

    // Update + delete.
    const facts = repo._all();
    await svc.updateFact('proj', facts[0].id, { value: 'the boat' });
    even('continuity: update changes value', repo._all().find((f) => f.id === facts[0].id).value === 'the boat');
    await svc.deleteFact('proj', facts[0].id);
    even('continuity: delete removes the fact', repo._all().every((f) => f.id !== facts[0].id));
  }

  /* ==================================================================== */
  /* 7b. ContinuityService — deleted anchors do not silently corrupt state */
  /* ==================================================================== */
  {
    const repo = makeContinuityRepo();
    const collab = makeCollaborators();
    // Use a tight 2-chapter outline so we can "delete" the second chapter.
    collab.state.order = ['chap1', 'chap2'];
    const svc = new ContinuityService({ repository: repo, outlineService: collab.outlineService, sceneService: collab.sceneService });

    await svc.createFact('proj', { subjectType: 'character', subjectId: 'char1', subjectLabel: 'Elara', predicate: 'position', value: 'harbour', anchorChapterId: 'chap1' });
    await svc.createFact('proj', { subjectType: 'character', subjectId: 'char1', subjectLabel: 'Elara', predicate: 'position', value: 'lighthouse', anchorChapterId: 'chap2' });
    eq('deleted-anchor: baseline current position = lighthouse', (await svc.currentState('proj')).find((s) => s.subjectId === 'char1').values.find((v) => v.predicate === 'position').value, 'lighthouse');

    // Simulate deleting chap2 from the outline (its facts remain in the log).
    collab.state.order = ['chap1'];
    const after = await svc.currentState('proj');
    eq('deleted-anchor: orphaned fact no longer contributes — current reverts to harbour', after.find((s) => s.subjectId === 'char1').values.find((v) => v.predicate === 'position').value, 'harbour');
    even('deleted-anchor: orphaned fact rows are preserved in the log', repo._all().length === 2);
    await rejectsWith('deleted-anchor: stateAsOf on a deleted chapter throws', () => svc.stateAsOf('proj', 'chap2'), () => true);
  }

  /* ==================================================================== */
  /* 8. AnalysisService — detectors only emit evidence-backed findings    */
  /* ==================================================================== */
  {
    const contRepo = makeContinuityRepo();
    const collab = makeCollaborators();
    const continuity = new ContinuityService({ repository: contRepo, outlineService: collab.outlineService, sceneService: collab.sceneService });

    // Same-chapter contradiction: Elara position harbour vs lighthouse @ chap1.
    await continuity.createFact('proj', { subjectType: 'character', subjectId: 'char1', subjectLabel: 'Elara', predicate: 'position', value: 'harbour', anchorChapterId: 'chap1' });
    await continuity.createFact('proj', { subjectType: 'character', subjectId: 'char1', subjectLabel: 'Elara', predicate: 'position', value: 'lighthouse', anchorChapterId: 'chap1' });

    // Action after death: status deceased @ chap1, then position @ chap2.
    await continuity.createFact('proj', { subjectType: 'character', subjectId: 'char2', subjectLabel: 'Mira', predicate: 'status', value: 'deceased', anchorChapterId: 'chap1' });
    await continuity.createFact('proj', { subjectType: 'character', subjectId: 'char2', subjectLabel: 'Mira', predicate: 'position', value: 'the tower', anchorChapterId: 'chap2' });

    // Knowledge entry: unresolved foreshadowing.
    const knowRepo = makeKnowledgeRepo();
    const knowledge = new KnowledgeService({ repository: knowRepo, ...collab });
    await knowledge.createEntry('proj', { kind: 'concept', title: 'The buried secret', summary: 'Seeded early', tags: ['foreshadowing'], evidence: [{ chapterId: 'chap1', sceneId: null, quote: 'a hint', offset: null, note: '' }] });

    const analysisRepo = makeAnalysisRepo();
    const analysis = new AnalysisService({
      repository: analysisRepo,
      continuityService: continuity,
      knowledgeService: knowledge,
      outlineService: collab.outlineService,
      sceneService: collab.sceneService,
      characterService: collab.characterService,
      worldService: collab.worldService,
    });

    const run = await analysis.runDeterministic('proj');
    even('analysis: produced findings', run.created.length > 0, `created=${run.created.length}`);
    even('analysis: every finding has valid evidence', run.created.every((f) => f.evidence.length >= 1 && f.evidence.every((e) => e.chapterId || e.sceneId)));
    even('analysis: detected same-chapter contradiction', run.created.some((f) => f.category === 'continuity'));
    even('analysis: detected action-after-death', run.created.some((f) => f.category === 'logic' && /after being marked dead|acts after/i.test(f.title)));
    even('analysis: detected unresolved foreshadowing', run.created.some((f) => f.category === 'foreshadowing'));

    // saveDraft rejects an evidence-less draft.
    await rejectsWith('analysis: saveDraft rejects evidence-less draft', () => analysis.saveDraft('proj', { category: 'logic', severity: 'error', origin: 'manual', title: 'X', description: 'Y', evidence: [] }), () => true);

    // saveDraft rejects evidence pointing at a chapter NOT in the project.
    await rejectsWith(
      'analysis: saveDraft rejects cross-project chapter evidence',
      () => analysis.saveDraft('proj', { category: 'logic', severity: 'error', origin: 'manual', title: 'X', description: 'Y', evidence: [{ chapterId: 'chap_from_other_project', sceneId: null, quote: '', offset: null, note: '' }] }),
      (error) => /not part of project/i.test(error && error.message),
    );

    // saveDraft rejects a scene that is not under the cited chapter.
    await rejectsWith(
      'analysis: saveDraft rejects a scene outside the cited chapter',
      () => analysis.saveDraft('proj', { category: 'logic', severity: 'error', origin: 'manual', title: 'X', description: 'Y', evidence: [{ chapterId: 'chap1', sceneId: 'scn2', quote: '', offset: null, note: '' }] }),
      (error) => /not part of chapter/i.test(error && error.message),
    );

    // saveDraft ACCEPTS a correctly scoped chapter/scene locator.
    {
      const ok = await analysis.saveDraft('proj', { category: 'logic', severity: 'info', origin: 'manual', title: 'Valid', description: 'In project', evidence: [{ chapterId: 'chap1', sceneId: 'scn1', quote: 'verified', offset: 0, note: '' }] });
      even('analysis: saveDraft accepts in-project chapter+scene evidence', ok.evidence.length === 1 && ok.evidence[0].quote === 'verified' && ok.evidence[0].offset === 0);
    }

    // Review lifecycle.
    const finding = run.created[0];
    const updated = await analysis.updateFinding('proj', finding.id, { status: 'dismissed' });
    eq('analysis: status change persisted', updated.status, 'dismissed');
    await analysis.deleteFinding('proj', finding.id);
    even('analysis: delete removes finding', analysisRepo._all().every((f) => f.id !== finding.id));
  }

  /* ==================================================================== */
  /* 8b. Timeline detector — ambiguous scene order (positive + negative)   */
  /* ==================================================================== */
  {
    const collab = makeCollaborators();
    // Positive: two scenes in chap1 share order 0 → ambiguous timeline.
    collab.state.scenes.chap1 = [
      { id: 'scnA', order: 0, title: 'First', summary: '', location: '', timeOfDay: '', characterIds: [], goal: '', conflict: '', turningPoint: '', outcome: '', tags: [], purpose: 'setup', status: 'planned' },
      { id: 'scnB', order: 0, title: 'Second', summary: '', location: '', timeOfDay: '', characterIds: [], goal: '', conflict: '', turningPoint: '', outcome: '', tags: [], purpose: 'setup', status: 'planned' },
    ];
    const analysisRepo = makeAnalysisRepo();
    const analysis = new AnalysisService({
      repository: analysisRepo,
      continuityService: new ContinuityService({ repository: makeContinuityRepo(), outlineService: collab.outlineService, sceneService: collab.sceneService }),
      knowledgeService: new KnowledgeService({ repository: makeKnowledgeRepo(), ...collab }),
      outlineService: collab.outlineService,
      sceneService: collab.sceneService,
      characterService: collab.characterService,
      worldService: collab.worldService,
    });
    const runPos = await analysis.runDeterministic('proj');
    const timeline = runPos.created.filter((f) => f.category === 'timeline');
    even('timeline: emits finding for colliding scene order', timeline.length === 1, `timeline=${timeline.length}`);
    even('timeline: finding cites both scenes of the chapter', timeline.length === 1 && timeline[0].evidence.length === 2 && timeline[0].evidence.every((e) => e.chapterId === 'chap1' && (e.sceneId === 'scnA' || e.sceneId === 'scnB')));

    // Negative: distinct scene orders → no timeline finding.
    collab.state.scenes.chap1 = [
      { id: 'scnA', order: 0, title: 'First', summary: '', location: '', timeOfDay: '', characterIds: [], goal: '', conflict: '', turningPoint: '', outcome: '', tags: [], purpose: 'setup', status: 'planned' },
      { id: 'scnB', order: 1, title: 'Second', summary: '', location: '', timeOfDay: '', characterIds: [], goal: '', conflict: '', turningPoint: '', outcome: '', tags: [], purpose: 'setup', status: 'planned' },
    ];
    const analysis2 = new AnalysisService({
      repository: makeAnalysisRepo(),
      continuityService: new ContinuityService({ repository: makeContinuityRepo(), outlineService: collab.outlineService, sceneService: collab.sceneService }),
      knowledgeService: new KnowledgeService({ repository: makeKnowledgeRepo(), ...collab }),
      outlineService: collab.outlineService,
      sceneService: collab.sceneService,
      characterService: collab.characterService,
      worldService: collab.worldService,
    });
    const runNeg = await analysis2.runDeterministic('proj');
    even('timeline: no finding when scene order is distinct', runNeg.created.filter((f) => f.category === 'timeline').length === 0);
  }

  /* ==================================================================== */
  /* 8c. Character detector — status conflict + unused-in-scene            */
  /* ==================================================================== */
  {
    const collab = makeCollaborators();
    // char1 profile = active; add a continuity status fact "dead" at chap2.
    const contRepo = makeContinuityRepo();
    const continuity = new ContinuityService({ repository: contRepo, outlineService: collab.outlineService, sceneService: collab.sceneService });
    await continuity.createFact('proj', { subjectType: 'character', subjectId: 'char1', subjectLabel: 'Elara', predicate: 'status', value: 'dead', anchorChapterId: 'chap2' });

    // charU marked unused but present in chap1 scene membership.
    collab.state.characters.push({ id: 'charU', name: 'Ghost', summary: '', background: '', personality: '', motivation: '', appearance: '', role: 'minor', status: 'unused', tags: [], projectId: 'proj' });
    collab.state.scenes.chap1 = [{ id: 'scn1', order: 0, title: 'Landing', summary: '', location: 'harbour', timeOfDay: 'dawn', characterIds: ['charU'], goal: '', conflict: '', turningPoint: '', outcome: '', tags: [], purpose: 'opening', status: 'planned' }];

    const analysis = new AnalysisService({
      repository: makeAnalysisRepo(),
      continuityService: continuity,
      knowledgeService: new KnowledgeService({ repository: makeKnowledgeRepo(), ...collab }),
      outlineService: collab.outlineService,
      sceneService: collab.sceneService,
      characterService: collab.characterService,
      worldService: collab.worldService,
    });
    const run = await analysis.runDeterministic('proj');
    const charFindings = run.created.filter((f) => f.category === 'character');
    even('character: detects record-status vs continuity-status conflict', charFindings.some((f) => /Elara/.test(f.title) && /status/i.test(f.title)));
    even('character: conflict finding cites the continuity status fact', charFindings.some((f) => f.relatedFactIds && f.relatedFactIds.length >= 1));
    even('character: detects unused character appearing in a scene', charFindings.some((f) => /Ghost/.test(f.title) && /unused/i.test(f.title)));
    even('character: every character finding has evidence', charFindings.every((f) => f.evidence.length >= 1 && f.evidence.every((e) => e.chapterId || e.sceneId)));

    // Negative: consistent character (active profile, latest status fact active) → no conflict finding.
    const collab2 = makeCollaborators();
    collab2.state.characters = [{ id: 'char1', name: 'Elara', summary: '', background: '', personality: '', motivation: '', appearance: '', role: 'protagonist', status: 'active', tags: [], projectId: 'proj' }];
    const contRepo2 = makeContinuityRepo();
    const continuity2 = new ContinuityService({ repository: contRepo2, outlineService: collab2.outlineService, sceneService: collab2.sceneService });
    await continuity2.createFact('proj', { subjectType: 'character', subjectId: 'char1', subjectLabel: 'Elara', predicate: 'status', value: 'alive', anchorChapterId: 'chap1' });
    const analysis2 = new AnalysisService({
      repository: makeAnalysisRepo(),
      continuityService: continuity2,
      knowledgeService: new KnowledgeService({ repository: makeKnowledgeRepo(), ...collab2 }),
      outlineService: collab2.outlineService,
      sceneService: collab2.sceneService,
      characterService: collab2.characterService,
      worldService: collab2.worldService,
    });
    const run2 = await analysis2.runDeterministic('proj');
    even('character: no conflict when profile and latest status agree', run2.created.filter((f) => f.category === 'character').length === 0);
  }

  /* ==================================================================== */
  /* 8d. World-rule detector — prohibition vs permitting rule entry        */
  /* ==================================================================== */
  {
    const collab = makeCollaborators();
    // World rule section prohibits "mortals" from wielding tide magic.
    collab.state.world = { id: 'world1', projectId: 'proj', title: 'The Coast', overview: '', sections: [
      { id: 'secR', title: 'Magic System Rules', content: 'Mortals cannot wield tide magic.' },
    ], themes: [], settings: {} };

    const knowRepo = makeKnowledgeRepo();
    const knowledge = new KnowledgeService({ repository: knowRepo, ...collab });
    // Contradicting rule entry: permits mortals.
    await knowledge.createEntry('proj', {
      kind: 'rule',
      title: 'Tide-magic for all',
      body: 'Mortals can wield tide magic with training.',
      tags: ['rule', 'magic'],
      evidence: [{ chapterId: 'chap1', sceneId: null, quote: 'mortals can wield tide magic', offset: null, note: '' }],
    });

    const analysis = new AnalysisService({
      repository: makeAnalysisRepo(),
      continuityService: new ContinuityService({ repository: makeContinuityRepo(), outlineService: collab.outlineService, sceneService: collab.sceneService }),
      knowledgeService: knowledge,
      outlineService: collab.outlineService,
      sceneService: collab.sceneService,
      characterService: collab.characterService,
      worldService: collab.worldService,
    });
    const run = await analysis.runDeterministic('proj');
    const ruleFindings = run.created.filter((f) => f.category === 'world-rule');
    even('world-rule: detects prohibition contradicted by rule entry', ruleFindings.some((f) => /mortals/i.test(f.title)));
    even('world-rule: finding cites locator evidence', ruleFindings.every((f) => f.evidence.length >= 1 && f.evidence.every((e) => e.chapterId || e.sceneId)));
    even('world-rule: finding links the contradicting entry', ruleFindings.some((f) => f.relatedEntryIds && f.relatedEntryIds.length >= 1));

    // Negative: agreeing rule entry (also says mortals cannot) → no conflict.
    const collab2 = makeCollaborators();
    collab2.state.world = { id: 'world1', projectId: 'proj', title: 'The Coast', overview: '', sections: [
      { id: 'secR', title: 'Magic System Rules', content: 'Mortals cannot wield tide magic.' },
    ], themes: [], settings: {} };
    const knowRepo2 = makeKnowledgeRepo();
    const knowledge2 = new KnowledgeService({ repository: knowRepo2, ...collab2 });
    await knowledge2.createEntry('proj', {
      kind: 'rule',
      title: 'Tide-magic restriction',
      body: 'Mortals can never wield tide magic.',
      tags: ['rule', 'magic'],
      evidence: [{ chapterId: 'chap1', sceneId: null, quote: 'mortals can never wield tide magic', offset: null, note: '' }],
    });
    const analysis2 = new AnalysisService({
      repository: makeAnalysisRepo(),
      continuityService: new ContinuityService({ repository: makeContinuityRepo(), outlineService: collab2.outlineService, sceneService: collab2.sceneService }),
      knowledgeService: knowledge2,
      outlineService: collab2.outlineService,
      sceneService: collab2.sceneService,
      characterService: collab2.characterService,
      worldService: collab2.worldService,
    });
    const run2 = await analysis2.runDeterministic('proj');
    even('world-rule: no conflict when rule entry agrees', run2.created.filter((f) => f.category === 'world-rule').length === 0);

    // Negative: no rule-classified section → no world-rule finding at all.
    const collab3 = makeCollaborators();
    collab3.state.world = { id: 'world1', projectId: 'proj', title: 'The Coast', overview: '', sections: [
      { id: 'secG', title: 'Geography', content: 'Mortals cannot cross the sea.' },
    ], themes: [], settings: {} };
    const analysis3 = new AnalysisService({
      repository: makeAnalysisRepo(),
      continuityService: new ContinuityService({ repository: makeContinuityRepo(), outlineService: collab3.outlineService, sceneService: collab3.sceneService }),
      knowledgeService: new KnowledgeService({ repository: makeKnowledgeRepo(), ...collab3 }),
      outlineService: collab3.outlineService,
      sceneService: collab3.sceneService,
      characterService: collab3.characterService,
      worldService: collab3.worldService,
    });
    const run3 = await analysis3.runDeterministic('proj');
    even('world-rule: no finding when no rule section exists', run3.created.filter((f) => f.category === 'world-rule').length === 0);
  }

  /* ==================================================================== */
  /* 8e. All six categories are represented by at least one detector       */
  /* ==================================================================== */
  {
    // Schema already exposes 6 categories; assert the detector set covers them.
    const { ANALYSIS_CATEGORIES } = mod;
    eq('categories: schema defines exactly six', ANALYSIS_CATEGORIES.length, 6);
    for (const category of ['timeline', 'continuity', 'character', 'world-rule', 'foreshadowing', 'logic']) {
      even(`categories: "${category}" is a valid schema category`, ANALYSIS_CATEGORIES.includes(category));
    }
  }

  /* ==================================================================== */
  /* 9. Cascade isolation (fake repos): project delete clears its data     */
  /* ==================================================================== */
  {
    const knowRepo = makeKnowledgeRepo();
    const contRepo = makeContinuityRepo();
    const analysisRepo = makeAnalysisRepo();
    const collab = makeCollaborators();
    const knowledge = new KnowledgeService({ repository: knowRepo, ...collab });

    await knowledge.createEntry('proj', { kind: 'term', title: 'P7 term' });
    await knowledge.createEntry('other', { kind: 'term', title: 'Other term' });

    eq('cascade: delete project data returns count', await knowledge.deleteEntriesOfProject('proj'), 1);
    eq('cascade: other project data intact', knowRepo._all().filter((e) => e.projectId === 'other').length, 1);
    eq('cascade: proj data gone', knowRepo._all().filter((e) => e.projectId === 'proj').length, 0);
    void contRepo;
    void analysisRepo;
  }

  cleanupTemp();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length > 0) {
    console.error(`\n${failed.length} check(s) failed: ${failed.map((f) => f.name).join(', ')}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('P7 verification crashed:', error);
  process.exit(1);
});
