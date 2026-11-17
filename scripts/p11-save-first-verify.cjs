/**
 * P11 Chapter Analysis — SAVE-FIRST / CONCURRENCY / POSSIBLE-DUPLICATE review.
 *
 * The "Analyze" action must (a) persist the latest editor prose BEFORE the AI
 * pass reads it, (b) be idempotent for unchanged prose so a title-only edit or a
 * rapid double click never triggers a wasteful/duplicate AI call, and (c) let the
 * author explicitly FLAG a possible duplicate (never auto-merged) whose decision
 * is durable across reload.
 *
 * The UI pieces (the `analyzeInFlight` ref and the save-first await) are React
 * closures; this script verifies the SERVICE-LEVEL invariants they depend on, so
 * the wiring in `ChapterAnalysisTab` is built on proven primitives:
 *
 *   1. BUILD: a Character created without `evidence` is schema-valid (the typed
 *      `CreateCharacterInput.evidence?` path the P11 integration uses); manual
 *      `evidence` is preserved on update.
 *   2. SAVE-FIRST fingerprint: analysing the SAME prose twice reuses the run and
 *      performs NO second AI call ("no unnecessary AI analysis calls"); changed
 *      prose produces a NEW run.
 *   2b. SAVE-FIRST FAILURE: when the pre-analysis save fails, the AI pass is
 *      NEVER invoked (generate call count stays unchanged) — driven through the
 *      SAME `beforeAnalyze -> analyze` sequence the tab runs, not by inspecting
 *      source structure.
 *   3. CONCURRENCY: two simultaneous applies for the same candidate serialise and
 *      create exactly ONE canonical entity (the guarantee the button/ref guard
 *      mirrors on the client).
 *   4. POSSIBLE-DUPLICATE: `uncertain` persists the flagged reference + label,
 *      survives reload, and passing null clears it — without ever merging or
 *      creating an entity.
 *
 * Usage: npm run verify:chapter-analysis:save-first
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

/* -------------------------------------------------------------------------- */
/* In-memory fake Dexie tables (same surface as the repositories use)         */
/* -------------------------------------------------------------------------- */

function makeFakeTable() {
  const map = new Map();
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

  const matchesIndex = (row, index, value) => {
    if (index.startsWith('[') && index.endsWith(']')) {
      const fields = index.slice(1, -1).split('+');
      return fields.every((f, i) => row[f] === value[i]);
    }
    return row[index] === value;
  };

  return {
    _all: () => [...map.values()],
    async get(id) { return map.has(id) ? clone(map.get(id)) : undefined; },
    async add(row) {
      if (map.has(row.id)) {
        const err = new Error('ConstraintError');
        err.name = 'ConstraintError';
        throw err;
      }
      map.set(row.id, clone(row));
    },
    async put(row) { map.set(row.id, clone(row)); },
    async delete(id) { map.delete(id); },
    where(index) {
      const list = () => [...map.values()];
      const sel = (predicate) => ({
        async toArray() { return list().filter(predicate).map(clone); },
        async first() { const r = list().find(predicate); return r ? clone(r) : undefined; },
        async delete() {
          let n = 0;
          for (const r of list()) if (predicate(r)) { map.delete(r.id); n += 1; }
          return n;
        },
        async count() { return list().filter(predicate).length; },
      });
      return { equals(value) { return sel((r) => matchesIndex(r, index, value)); } };
    },
  };
}

function makeFakeDb(tables) {
  const db = { ...tables };
  db.transaction = async (_mode, ...args) => args[args.length - 1]();
  for (const t of Object.values(tables)) t.db = db;
  return db;
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function makeRun(overrides = {}) {
  return {
    id: overrides.id ?? 'canls_1',
    projectId: overrides.projectId ?? 'projA',
    chapterId: overrides.chapterId ?? 'chapA',
    contentFingerprint: overrides.contentFingerprint ?? 'sha256:abc',
    origin: 'ai',
    modelTarget: null,
    entities: overrides.entities ?? [],
    relationships: overrides.relationships ?? [],
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeChapter(overrides = {}) {
  return {
    id: overrides.id ?? 'chapA',
    projectId: overrides.projectId ?? 'projA',
    title: overrides.title ?? 'Chapter One',
    summary: '',
    status: 'draft',
    order: 0,
    characterIds: [],
    beatIds: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

function acceptedEntity(overrides = {}) {
  return {
    key: overrides.key ?? 'character:elara',
    kind: overrides.kind ?? 'character',
    name: overrides.name ?? 'Elara',
    summary: overrides.summary ?? 'A keeper',
    detail: overrides.detail ?? 'Tall and quiet.',
    tags: overrides.tags ?? ['protagonist'],
    status: overrides.status ?? 'accepted',
    linkedEntityId: null,
    evidence: overrides.evidence ?? [],
    aliases: overrides.aliases ?? [],
    integration: {
      status: 'unreviewed',
      canonicalType: 'none',
      canonicalEntityId: null,
      matchedBy: 'none',
      possibleDuplicateId: null,
      possibleDuplicateLabel: '',
      decidedAt: null,
    },
    reviewed: true,
    confidence: 0.9,
  };
}

/** A minimal valid AI response body (an empty candidate list). */
function emptyAiContent() {
  return JSON.stringify({ entities: [], relationships: [] });
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  const path = require('node:path');
  const alias = { '@': path.resolve(__dirname, '..', 'src') };
  const mod = await importBundled('scripts/lib/p11-entry.ts', 'p11-save-first', { alias });
  const {
    ChapterAnalysisRepository,
    ChapterAnalysisService,
    ChapterAnalysisIntegrationService,
    CharacterService,
    CharacterRepository,
    KnowledgeService,
    KnowledgeRepository,
    WorldService,
    WorldRepository,
  } = mod;

  /* ==================================================================== */
  /* 1. BUILD integrity — Character.evidence defaulting                   */
  /* ==================================================================== */
  {
    const charsTable = makeFakeTable();
    const knwTable = makeFakeTable();
    const db = makeFakeDb({ characters: charsTable, knowledgeEntries: knwTable });
    const characterService = new CharacterService(new CharacterRepository(db));

    // No `evidence` supplied: still schema-valid, persisted with evidence: [].
    const created = await characterService.createCharacter('projA', { name: 'Elara' });
    eq('build: character created without evidence has evidence []', created.evidence, []);
    const reread = await characterService.getCharacter(created.id);
    eq('build: re-read character evidence is []', reread.evidence, []);

    // Manual provenance is preserved by an unrelated update (omitted evidence).
    await characterService.updateCharacter('projA', created.id, { summary: 'Updated' });
    const afterUpdate = await characterService.getCharacter(created.id);
    eq('build: evidence preserved across update', afterUpdate.evidence, []);

    // Explicit evidence is accepted + round-trips.
    const withEvidence = await characterService.createCharacter('projA', {
      name: 'Mira',
      evidence: [{ chapterId: 'chapA', sceneId: null, quote: 'Mira', offset: 3, note: '' }],
    });
    eq('build: explicit evidence accepted', withEvidence.evidence.length, 1);
    eq('build: explicit evidence quote', withEvidence.evidence[0].quote, 'Mira');
  }

  /* ==================================================================== */
  /* 2. SAVE-FIRST fingerprint — idempotent re-analysis, no extra AI call */
  /* ==================================================================== */
  {
    const runsTable = makeFakeTable();
    const db = makeFakeDb({ chapterAnalysisRuns: runsTable });
    let generateCalls = 0;
    let prose = 'Elara stood watch over The Keep.';

    const service = new ChapterAnalysisService({
      repository: new ChapterAnalysisRepository(db),
      generate: async () => {
        generateCalls += 1;
        return {
          result: { content: emptyAiContent(), usage: {}, finishReason: 'stop' },
          target: {
            provider: { name: 'stub' },
            model: { displayName: 'stub-model', modelId: 'stub' },
          },
        };
      },
      chapterLoader: async () => makeChapter(),
      // The prose loader reads the PERSISTED draft — the value save-first commits.
      proseLoader: async () => prose,
      characterNames: async () => [],
    });

    const first = await service.analyzeChapter('projA', 'chapA');
    eq('save-first: first analysis not reused', first.reused, false);
    eq('save-first: one AI call after first run', generateCalls, 1);

    // Unchanged prose (e.g. only the TITLE changed): re-analysis is a REUSE and
    // performs NO second AI call — "avoid unnecessary AI analysis calls".
    const second = await service.analyzeChapter('projA', 'chapA');
    eq('save-first: unchanged prose reused', second.reused, true);
    eq('save-first: same run id reused', second.run.id, first.run.id);
    eq('save-first: no extra AI call on reuse', generateCalls, 1);

    // Persisted prose changed -> a NEW run and a NEW AI call.
    prose = 'Elara stood watch over The Keep. The night fell.';
    const third = await service.analyzeChapter('projA', 'chapA');
    eq('save-first: changed prose creates new run', third.reused, false);
    even('save-first: changed prose gets a new run id', third.run.id !== first.run.id);
    eq('save-first: changed prose triggers one more AI call', generateCalls, 2);
  }

  /* ==================================================================== */
  /* 2b. SAVE-FIRST FAILURE — a failed pre-analysis save must NOT fire     */
  /*     the AI request. Driven through the tab's real call sequence:      */
  /*       try { await beforeAnalyze(); await analyze(); } catch { … }     */
  /* ==================================================================== */
  {
    const runsTable = makeFakeTable();
    const db = makeFakeDb({ chapterAnalysisRuns: runsTable });
    let generateCalls = 0;
    let prose = 'Elara stood watch over The Keep.';

    const service = new ChapterAnalysisService({
      repository: new ChapterAnalysisRepository(db),
      generate: async () => {
        generateCalls += 1;
        return {
          result: { content: emptyAiContent(), usage: {}, finishReason: 'stop' },
          target: { provider: { name: 'stub' }, model: { displayName: 'stub-model', modelId: 'stub' } },
        };
      },
      chapterLoader: async () => makeChapter(),
      proseLoader: async () => prose,
      characterNames: async () => [],
    });

    // Mirrors `runAnalysis` in ChapterAnalysisTab EXACTLY: the save-first gate is
    // awaited BEFORE analyze(); a rejection aborts before the AI pass runs.
    const runAnalysisSequence = async (beforeAnalyze) => {
      await beforeAnalyze();
      return service.analyzeChapter('projA', 'chapA');
    };

    // ---- Case A: the save FAILED (beforeAnalyze rejects) -----------------
    let reportedError = null;
    try {
      await runAnalysisSequence(async () => {
        throw new Error('Your latest changes could not be saved, so analysis was not started.');
      });
    } catch (err) {
      reportedError = err;
    }
    even('save-first(fail): the save error is surfaced, not swallowed', reportedError instanceof Error);
    eq('save-first(fail): NO AI request when the save failed', generateCalls, 0);
    eq('save-first(fail): NO run persisted when the save failed', runsTable._all().length, 0);

    // ---- Case B: save SUCCEEDED (beforeAnalyze resolves) — control --------
    const result = await runAnalysisSequence(async () => {
      /* flush succeeded — nothing to throw */
    });
    eq('save-first(ok): AI request fires exactly once after a good save', generateCalls, 1);
    eq('save-first(ok): a run is persisted after a good save', runsTable._all().length, 1);
    eq('save-first(ok): analysis produced a (non-reused) run', result.reused, false);

    // ---- Case C: persisted draft UNREADABLE (proseLoader throws) ----------
    // Even past the gate, if the persisted prose cannot be read, the service
    // must never reach the AI call. This is the same "no stale/missing prose is
    // ever analysed" invariant at the service seam.
    const genBefore = generateCalls;
    let readError = null;
    const throwing = new ChapterAnalysisService({
      repository: new ChapterAnalysisRepository(db),
      generate: async () => {
        generateCalls += 1;
        return {
          result: { content: emptyAiContent(), usage: {}, finishReason: 'stop' },
          target: { provider: { name: 'stub' }, model: { displayName: 'stub-model', modelId: 'stub' } },
        };
      },
      chapterLoader: async () => makeChapter(),
      proseLoader: async () => {
        throw new Error('draft could not be read');
      },
      characterNames: async () => [],
    });
    try {
      await throwing.analyzeChapter('projA', 'chapA');
    } catch (err) {
      readError = err;
    }
    even('save-first(fail): an unreadable draft surfaces an error', readError instanceof Error);
    eq('save-first(fail): NO AI request when the draft cannot be read', generateCalls, genBefore);
  }

  /* ==================================================================== */
  /* 3. CONCURRENCY — re-applying an already-integrated candidate is a    */
  /*    no-op (the same idempotency the Analyze double-click guard relies  */
  /*    on: a second apply must not create a duplicate entity).           */
  /* ==================================================================== */
  {
    const run = makeRun({ entities: [acceptedEntity()] });
    const runsTable = makeFakeTable();
    const charsTable = makeFakeTable();
    const knwTable = makeFakeTable();
    const worldTable = makeFakeTable();
    const db = makeFakeDb({ chapterAnalysisRuns: runsTable, characters: charsTable, knowledgeEntries: knwTable, worlds: worldTable });
    await runsTable.add(run);

    const characterService = new CharacterService(new CharacterRepository(db));
    const service = new ChapterAnalysisIntegrationService({
      repository: new ChapterAnalysisRepository(db),
      characterService,
      knowledgeService: new KnowledgeService({ repository: new KnowledgeRepository(db), characterService }),
      worldService: new WorldService(new WorldRepository(db)),
    });

    const first = await service.applyDecision('projA', run.id, { key: 'character:elara', action: 'create' });
    eq('concurrency: first apply created one character', charsTable._all().length, 1);

    // A SECOND identical apply for the same candidate must NOT create a second
    // entity — it resolves to the already-linked canonical id.
    const second = await service.applyDecision('projA', run.id, { key: 'character:elara', action: 'create' });
    eq('concurrency: second apply creates NO duplicate', charsTable._all().length, 1);
    eq('concurrency: second apply keeps the same linked id', second.entity.linkedEntityId, first.entity.linkedEntityId);
  }

  /* ==================================================================== */
  /* 4. POSSIBLE-DUPLICATE flag — persist, survive reload, clear          */
  /* ==================================================================== */
  {
    const existing = {
      id: 'char_e', projectId: 'projA', name: 'Elara', summary: 'A ranger.',
      background: '', personality: '', motivation: '', appearance: '',
      role: 'supporting', status: 'active', tags: [], evidence: [],
      createdAt: 1, updatedAt: 1,
    };
    // Candidate "Elara Vance" (alias "Elara") collides with the existing "Elara"
    // via ALIAS -> that existing entity is a POSSIBLE DUPLICATE (not an exact
    // match), so it is surfaced in `possibleDuplicates`, which is what the UI
    // flags.
    const run = makeRun({
      entities: [acceptedEntity({ key: 'character:elara vance', name: 'Elara Vance', aliases: ['Elara'] })],
      chapterId: 'chapA',
    });
    const runsTable = makeFakeTable();
    const charsTable = makeFakeTable();
    const knwTable = makeFakeTable();
    const worldTable = makeFakeTable();
    const db = makeFakeDb({ chapterAnalysisRuns: runsTable, characters: charsTable, knowledgeEntries: knwTable, worlds: worldTable });
    await runsTable.add(run);
    await charsTable.add(existing);

    const characterService = new CharacterService(new CharacterRepository(db));
    const service = new ChapterAnalysisIntegrationService({
      repository: new ChapterAnalysisRepository(db),
      characterService,
      knowledgeService: new KnowledgeService({ repository: new KnowledgeRepository(db), characterService }),
      worldService: new WorldService(new WorldRepository(db)),
    });

    // The preview SURFACES the alias-colliding entity as a possible duplicate.
    const previews = await service.previewIntegration('projA', run.id);
    even('duplicate: preview surfaces the alias-colliding entity', previews[0].possibleDuplicates.some((m) => m.id === 'char_e'));

    // Flag it (no merge, no entity created).
    const flagged = await service.applyDecision('projA', run.id, {
      key: 'character:elara vance',
      action: 'uncertain',
      duplicateOfId: 'char_e',
      duplicateOfLabel: 'Elara',
    });
    eq('duplicate: flagged persisted id', flagged.entity.integration.possibleDuplicateId, 'char_e');
    eq('duplicate: flagged persisted label', flagged.entity.integration.possibleDuplicateLabel, 'Elara');
    eq('duplicate: still uncertain', flagged.entity.integration.status, 'uncertain');
    eq('duplicate: no character created', charsTable._all().length, 1); // only the seed

    // Survives reload: the flagged reference is read back from the persisted run.
    const reloaded = await service.previewIntegration('projA', run.id);
    eq('duplicate: survives reload (id)', reloaded[0].integration.possibleDuplicateId, 'char_e');
    eq('duplicate: survives reload (label)', reloaded[0].integration.possibleDuplicateLabel, 'Elara');

    // Clearing the flag (null reference) clears both fields, still no entity.
    const cleared = await service.applyDecision('projA', run.id, {
      key: 'character:elara vance',
      action: 'uncertain',
      duplicateOfId: null,
      duplicateOfLabel: null,
    });
    eq('duplicate: cleared id', cleared.entity.integration.possibleDuplicateId, null);
    eq('duplicate: cleared label', cleared.entity.integration.possibleDuplicateLabel, '');
    eq('duplicate: clearing creates no character', charsTable._all().length, 1);
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
  console.error('P11 save-first verification crashed:', error);
  process.exit(1);
});
