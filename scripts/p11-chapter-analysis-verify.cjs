/**
 * P11 Chapter Analysis verification.
 *
 * Runs in plain Node (no browser, no network, no IndexedDB). Modules are bundled
 * from source with the project's own Vite/esbuild pipeline (see
 * `lib/p4-bundler.cjs`), so the code under test is exactly what ships. The
 * `ChapterAnalysisRepository` + `ChapterAnalysisService` are driven through an
 * in-memory fake of the `chapterAnalysisRuns` store and injected collaborators
 * (a fake AI generator, chapter loader, prose loader, character names), so the
 * service is exercised end-to-end without IndexedDB or any real AI provider.
 *
 * Focus — the invariants a UI smoke test cannot see and that must never regress:
 *   - Schema rejects malformed runs / candidates / dangling relationships.
 *   - Fingerprint IDEMPOTENCY: re-analysing unchanged prose returns the existing
 *     run and does NOT call the model twice or create a duplicate.
 *   - PROSE-CHANGED re-analysis creates a NEW run and KEEPS the old one (history).
 *   - STABLE-ID relationships: relations resolve by candidate key, and a
 *     relationship to a missing endpoint is dropped (never persisted dangling).
 *   - MANUAL-EDIT PROTECTION: a reviewed candidate is never overwritten by a
 *     re-analysis; accepted candidates carry forward; accepted/dismissed status
 *     is preserved.
 *   - Review actions (accept/dismiss/reopen) persist and mark `reviewed`.
 *   - Repository project isolation + cascade delete.
 *   - Migration: v16 data survives upgrade to v17 (schema superset check).
 *
 * Usage: npm run verify:chapter-analysis
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

/* -------------------------------------------------------------------------- */
/* In-memory fake table + db (only the Dexie surface the repo uses)          */
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

  const table = {
    _all: () => [...map.values()],
    _set: (id, row) => map.set(id, row),
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
      return {
        equals(value) { return sel((r) => matchesIndex(r, index, value)); },
      };
    },
  };
  return table;
}

function makeFakeDb(table) {
  const db = {
    chapterAnalysisRuns: table,
    async transaction(_mode, ...args) {
      const fn = args[args.length - 1];
      return fn();
    },
  };
  table.db = db;
  return db;
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function makeChapter(overrides = {}) {
  return {
    id: 'chapA',
    volumeId: 'volA',
    projectId: 'projA',
    title: 'The Beginning',
    order: 0,
    summary: '',
    goal: '',
    keyEvents: '',
    endingHook: '',
    status: 'drafting',
    characterIds: [],
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

/** A model response JSON string with two entities + one relationship. */
function aiResponseJson({ elaraName = 'Elara', includeRel = true } = {}) {
  return JSON.stringify({
    entities: [
      { kind: 'character', name: elaraName, summary: 'A keeper', detail: 'Tall and quiet.', tags: ['protagonist'], confidence: 0.9 },
      { kind: 'location', name: 'The Keep', summary: 'A fortress', detail: '', tags: [], confidence: 0.7 },
    ],
    relationships: includeRel
      ? [{ relation: 'guards', fromKind: 'character', fromName: elaraName, toKind: 'location', toName: 'The Keep', summary: 'She watches it.', confidence: 0.6 }]
      : [],
  });
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  const path = require('node:path');
  const alias = { '@': path.resolve(__dirname, '..', 'src') };
  const mod = await importBundled('scripts/lib/p11-entry.ts', 'p11', { alias });
  const {
    ChapterAnalysisRunSchema,
    ChapterAnalysisEntitySchema,
    ChapterAnalysisRelationshipSchema,
    AnalysisEntityStatusSchema,
    ANALYSIS_ENTITY_KINDS,
    buildEntityKey,
    normalizeCandidateName,
    buildChapterAnalysisMessages,
    parseAnalysisResponse,
    ChapterAnalysisRepository,
    ChapterAnalysisService,
    ChapterAnalysisNotFoundError,
    ChapterAnalysisValidationError,
    ProjectRepositoryError,
    hashRawText,
  } = mod;

  // Shared factory inside main so it can close over `mod`.
  function makeService(options = {}) {
    const chapter = options.chapter ?? makeChapter();
    const state = {
      callCount: 0,
      prose: options.prose ?? 'Elara stood watch over The Keep. The night was long and cold.',
      responses: options.responses ?? [aiResponseJson()],
      characterNames: options.characterNames ?? ['Elara'],
    };
    const table = makeFakeTable();
    const db = makeFakeDb(table);
    const repository = new ChapterAnalysisRepository(db);
    const service = new ChapterAnalysisService({
      repository,
      generate: async () => {
        const content = state.responses[Math.min(state.callCount, state.responses.length - 1)];
        state.callCount += 1;
        return {
          result: { content },
          target: {
            provider: { name: 'TestProvider' },
            model: { displayName: 'TestModel', modelId: 'test-model' },
            source: 'task',
          },
        };
      },
      chapterLoader: async (projectId, chapterId) =>
        chapter.id === chapterId && chapter.projectId === projectId ? chapter : null,
      proseLoader: async (projectId, chapterId) =>
        chapter.id === chapterId && chapter.projectId === projectId ? state.prose : '',
      characterNames: async () => state.characterNames,
    });
    return { service, repository, table, state, chapter };
  }

  /* ==================================================================== */
  /* 1. Schema — run / candidate / relationship                           */
  /* ==================================================================== */
  {
    const goodEntity = {
      key: buildEntityKey('character', 'Elara'),
      kind: 'character',
      name: 'Elara',
      summary: '',
      detail: '',
      tags: [],
      status: 'proposed',
      linkedEntityId: null,
      evidence: [],
      reviewed: false,
      confidence: null,
    };
    eq('schema: valid entity accepted', ChapterAnalysisEntitySchema.safeParse(goodEntity).success, true);
    eq('schema: unknown kind rejected', ChapterAnalysisEntitySchema.safeParse({ ...goodEntity, kind: 'planet' }).success, false);
    eq('schema: empty name rejected', ChapterAnalysisEntitySchema.safeParse({ ...goodEntity, name: '' }).success, false);
    eq('schema: unknown status rejected', ChapterAnalysisEntitySchema.safeParse({ ...goodEntity, status: 'maybe' }).success, false);

    const goodRel = {
      key: 'rel:0:x',
      relation: 'guards',
      fromKey: goodEntity.key,
      toKey: buildEntityKey('location', 'The Keep'),
      summary: '',
      status: 'proposed',
      linkedFromEntityId: null,
      linkedToEntityId: null,
      evidence: [],
      reviewed: false,
      confidence: null,
    };
    eq('schema: valid relationship accepted', ChapterAnalysisRelationshipSchema.safeParse(goodRel).success, true);
    eq('schema: empty relation label rejected', ChapterAnalysisRelationshipSchema.safeParse({ ...goodRel, relation: '  ' }).success, false);

    const goodRun = {
      id: 'canls_1',
      projectId: 'projA',
      chapterId: 'chapA',
      contentFingerprint: hashRawText('hello'),
      origin: 'ai',
      modelTarget: { providerName: 'P', modelName: 'M', modelId: 'm' },
      entities: [goodEntity, { ...goodEntity, key: buildEntityKey('location', 'The Keep'), kind: 'location', name: 'The Keep' }],
      relationships: [{ ...goodRel, toKey: buildEntityKey('location', 'The Keep') }],
      createdAt: 1,
      updatedAt: 1,
    };
    eq('schema: valid run accepted', ChapterAnalysisRunSchema.safeParse(goodRun).success, true);
    eq('schema: run with dangling relationship rejected', ChapterAnalysisRunSchema.safeParse({ ...goodRun, entities: [goodEntity] }).success, false);
    eq('schema: run updatedAt < createdAt rejected', ChapterAnalysisRunSchema.safeParse({ ...goodRun, createdAt: 5, updatedAt: 1 }).success, false);

    even('schema: kinds include character & location', ANALYSIS_ENTITY_KINDS.includes('character') && ANALYSIS_ENTITY_KINDS.includes('location'));
    eq('schema: statuses', ANALYSIS_ENTITY_STATUSES_LIST(AnalysisEntityStatusSchema), ['proposed', 'accepted', 'dismissed']);
  }

  /* ==================================================================== */
  /* 2. Helpers — key normalization & message building                    */
  /* ==================================================================== */
  {
    eq('key: normalizes case/space', buildEntityKey('character', '  ELARA '), 'character:elara');
    eq('key: stable across cosmetic differences', normalizeCandidateName('Elara'), normalizeCandidateName('elara'));
    const messages = buildChapterAnalysisMessages({ chapterTitle: 'Ch', prose: 'Some prose.', knownNames: ['Elara'] });
    even('messages: system + user present', messages.length === 2 && messages[0].role === 'system' && messages[1].role === 'user');
    even('messages: prose embedded in user', messages[1].content.includes('Some prose.'));
    even('messages: system lists allowed kinds', messages[0].content.includes('character'));
  }

  /* ==================================================================== */
  /* 3. parseAnalysisResponse — strict parsing                            */
  /* ==================================================================== */
  {
    const parsed = parseAnalysisResponse(aiResponseJson());
    eq('parse: two entities', parsed.entities.length, 2);
    eq('parse: one relationship', parsed.relationships.length, 1);

    // Unknown kinds dropped.
    const withJunk = JSON.stringify({
      entities: [{ kind: 'planet', name: 'Mars' }, { kind: 'character', name: 'Bob' }],
      relationships: [],
    });
    eq('parse: unknown kind dropped', parseAnalysisResponse(withJunk).entities.length, 1);

    // Dangling relationship dropped.
    const dangling = JSON.stringify({
      entities: [{ kind: 'character', name: 'Bob' }],
      relationships: [{ relation: 'knows', fromKind: 'character', fromName: 'Bob', toKind: 'location', toName: 'Nowhere' }],
    });
    eq('parse: dangling relationship dropped', parseAnalysisResponse(dangling).relationships.length, 0);

    // Fenced JSON tolerated.
    const fenced = '```json\n' + aiResponseJson() + '\n```';
    eq('parse: fenced json tolerated', parseAnalysisResponse(fenced).entities.length, 2);

    await rejectsWith('parse: invalid json rejected', () => parseAnalysisResponse('not json'), (e) => e.name === 'ChapterAnalysisParseError');
    await rejectsWith('parse: wrong shape rejected', () => parseAnalysisResponse('{"entities":"no"}'), (e) => e.name === 'ChapterAnalysisParseError');
  }

  /* ==================================================================== */
  /* 4. analyzeChapter — first run                                        */
  /* ==================================================================== */
  {
    const { service, state } = makeService();
    const result = await service.analyzeChapter('projA', 'chapA');
    eq('analyze: not reused on first run', result.reused, false);
    eq('analyze: model called once', state.callCount, 1);
    eq('analyze: run has 2 entities', result.run.entities.length, 2);
    eq('analyze: run has 1 relationship', result.run.relationships.length, 1);
    eq('analyze: fingerprint matches prose', result.run.contentFingerprint, hashRawText(state.prose));
    even('analyze: modelTarget captured', result.run.modelTarget && result.run.modelTarget.modelId === 'test-model');
    even('analyze: candidates start proposed', result.run.entities.every((e) => e.status === 'proposed' && e.reviewed === false));
  }

  /* ==================================================================== */
  /* 5. IDEMPOTENCY — unchanged prose returns existing run                */
  /* ==================================================================== */
  {
    const { service, state } = makeService();
    const first = await service.analyzeChapter('projA', 'chapA');
    const second = await service.analyzeChapter('projA', 'chapA');
    eq('idempotent: second run reused', second.reused, true);
    eq('idempotent: same run id', second.run.id, first.run.id);
    eq('idempotent: model still called once', state.callCount, 1);

    const history = await service.getHistory('projA', 'chapA');
    eq('idempotent: only ONE run stored', history.length, 1);

    // reuseExisting:false forces a fresh run even for unchanged prose.
    const forced = await service.analyzeChapter('projA', 'chapA', { reuseExisting: false });
    eq('idempotent: forced rerun not reused', forced.reused, false);
    eq('idempotent: forced rerun calls model again', state.callCount, 2);
  }

  /* ==================================================================== */
  /* 6. PROSE CHANGED — new run created, old kept as history              */
  /* ==================================================================== */
  {
    const { service, state } = makeService({
      responses: [
        aiResponseJson({ elaraName: 'Elara' }),
        aiResponseJson({ elaraName: 'Elara', includeRel: false }),
      ],
    });
    const first = await service.analyzeChapter('projA', 'chapA');
    // Change the prose → fingerprint changes → new run allowed.
    state.prose = 'Elara climbed The Keep at dawn, alone.';
    const second = await service.analyzeChapter('projA', 'chapA');

    eq('prose-changed: new run id differs', second.run.id !== first.run.id, true);
    eq('prose-changed: new fingerprint', second.run.contentFingerprint !== first.run.contentFingerprint, true);

    const history = await service.getHistory('projA', 'chapA');
    eq('prose-changed: two runs kept as history', history.length, 2);
    eq('prose-changed: newest first', history[0].id, second.run.id);
  }

  /* ==================================================================== */
  /* 7. MANUAL-EDIT PROTECTION — review survives re-analysis             */
  /* ==================================================================== */
  {
    const { service, state } = makeService({
      responses: [aiResponseJson(), aiResponseJson()],
    });
    const first = await service.analyzeChapter('projA', 'chapA');
    const elaraKey = buildEntityKey('character', 'elara');

    // Author edits + accepts Elara.
    const edited = await service.updateCandidate('projA', first.run.id, elaraKey, {
      name: 'Elara Vance',
      summary: 'Author rewrite',
      status: 'accepted',
    });
    const elara = edited.entities.find((e) => e.key === elaraKey);
    eq('review: edited name persisted', elara.name, 'Elara Vance');
    eq('review: status accepted', elara.status, 'accepted');
    eq('review: reviewed flag set', elara.reviewed, true);

    // Change prose so a new run is produced, model returns the SAME entity set.
    state.prose = 'Elara Vance stood guard again over The Keep.';
    const second = await service.analyzeChapter('projA', 'chapA');
    const carried = second.run.entities.find((e) => e.key === elaraKey);
    even('review: reviewed candidate carried forward into new run', Boolean(carried));
    eq('review: carried edit preserved (name)', carried.name, 'Elara Vance');
    eq('review: carried status preserved (accepted)', carried.status, 'accepted');
    eq('review: carried reviewed flag preserved', carried.reviewed, true);
    // The fresh AI "Elara" (unedited model name) must NOT overwrite the edit.
    even('review: fresh AI name did not overwrite author edit', second.run.entities.filter((e) => e.key === elaraKey).length === 1);
  }

  /* ==================================================================== */
  /* 8. Review actions — dismiss/reopen                                   */
  /* ==================================================================== */
  {
    const { service } = makeService();
    const run = (await service.analyzeChapter('projA', 'chapA')).run;
    const keepKey = buildEntityKey('location', 'the keep');

    const dismissed = await service.setCandidateStatus('projA', run.id, keepKey, 'dismissed');
    eq('review: dismiss persists', dismissed.entities.find((e) => e.key === keepKey).status, 'dismissed');
    eq('review: dismiss marks reviewed', dismissed.entities.find((e) => e.key === keepKey).reviewed, true);

    const reopened = await service.setCandidateStatus('projA', run.id, keepKey, 'proposed');
    eq('review: reopen persists', reopened.entities.find((e) => e.key === keepKey).status, 'proposed');

    await rejectsWith(
      'review: unknown candidate key rejected',
      () => service.setCandidateStatus('projA', run.id, 'nope', 'accepted'),
      (e) => e instanceof ChapterAnalysisValidationError && e.reason === 'not-in-run',
    );
  }

  /* ==================================================================== */
  /* 9. Relationships reference stable keys                                */
  /* ==================================================================== */
  {
    const { service } = makeService();
    const run = (await service.analyzeChapter('projA', 'chapA')).run;
    const rel = run.relationships[0];
    const entityKeys = new Set(run.entities.map((e) => e.key));
    even('relationships: fromKey resolves to an entity', entityKeys.has(rel.fromKey));
    even('relationships: toKey resolves to an entity', entityKeys.has(rel.toKey));
    even('relationships: NOT indexed by array position', !rel.fromKey.includes('[0]') && rel.fromKey.startsWith('character:'));

    // Accept a relationship.
    const updated = await service.updateRelationship('projA', run.id, rel.key, { status: 'accepted' });
    eq('relationships: accept persists', updated.relationships.find((r) => r.key === rel.key).status, 'accepted');
    eq('relationships: accept marks reviewed', updated.relationships.find((r) => r.key === rel.key).reviewed, true);
  }

  /* ==================================================================== */
  /* 10. Empty prose rejected; unknown chapter/run rejected              */
  /* ==================================================================== */
  {
    const { service } = makeService({ prose: '   ' });
    await rejectsWith(
      'validation: empty prose rejected',
      () => service.analyzeChapter('projA', 'chapA'),
      (e) => e instanceof ChapterAnalysisValidationError && e.reason === 'empty-prose',
    );

    const good = makeService();
    await rejectsWith(
      'not-found: unknown chapter rejected',
      () => good.service.analyzeChapter('projA', 'nope'),
      (e) => e instanceof ChapterAnalysisNotFoundError,
    );
    await rejectsWith(
      'not-found: foreign project chapter rejected',
      () => good.service.analyzeChapter('projB', 'chapA'),
      (e) => e instanceof ChapterAnalysisNotFoundError,
    );
    await rejectsWith(
      'not-found: unknown run rejected',
      () => good.service.deleteRun('projA', 'nope'),
      (e) => e instanceof ChapterAnalysisNotFoundError,
    );
  }

  /* ==================================================================== */
  /* 11. Invalid AI output → validation error, nothing persisted          */
  /* ==================================================================== */
  {
    const { service, table } = makeService({ responses: ['this is not json'] });
    await rejectsWith(
      'invalid-ai: malformed output rejected',
      () => service.analyzeChapter('projA', 'chapA'),
      (e) => e instanceof ChapterAnalysisValidationError && e.reason === 'invalid-ai-output',
    );
    eq('invalid-ai: nothing persisted', table._all().length, 0);
  }

  /* ==================================================================== */
  /* 12. Repository isolation + cascade delete                           */
  /* ==================================================================== */
  {
    const table = makeFakeTable();
    const db = makeFakeDb(table);
    const repo = new ChapterAnalysisRepository(db);
    const baseRun = (over = {}) => ({
      id: over.id ?? 'canls_x',
      projectId: over.projectId ?? 'projA',
      chapterId: over.chapterId ?? 'chapA',
      contentFingerprint: hashRawText('x' + Math.random()),
      origin: 'ai',
      modelTarget: null,
      entities: [],
      relationships: [],
      createdAt: 1,
      updatedAt: 1,
      ...over,
    });

    await repo.create(baseRun({ id: 'rA1', projectId: 'projA' }));
    await repo.create(baseRun({ id: 'rA2', projectId: 'projA', chapterId: 'chapB' }));
    await repo.create(baseRun({ id: 'rB1', projectId: 'projB' }));

    eq('repo: listByProject scopes to projA', (await repo.listByProject('projA')).map((r) => r.id).sort(), ['rA1', 'rA2']);
    eq('repo: listByChapter scopes to chapter', (await repo.listByChapter('projA', 'chapB')).map((r) => r.id), ['rA2']);

    const removed = await repo.deleteByProjectId('projA');
    eq('repo: cascade removed projA runs', removed, 2);
    eq('repo: projA runs gone', (await repo.listByProject('projA')).length, 0);
    eq('repo: projB runs intact', (await repo.listByProject('projB')).length, 1);

    // Fingerprint lookup isolation.
    const fp = hashRawText('shared');
    await repo.create(baseRun({ id: 'fA', projectId: 'projA', contentFingerprint: fp }));
    await repo.create(baseRun({ id: 'fB', projectId: 'projB', contentFingerprint: fp }));
    eq('repo: fingerprint lookup scoped to project', (await repo.findByFingerprint('projA', 'chapA', fp)).id, 'fA');
    eq('repo: fingerprint lookup other project', (await repo.findByFingerprint('projB', 'chapA', fp)).id, 'fB');
  }

  /* ==================================================================== */
  /* 13. Migration — v16 → v17 keeps data, adds one store                 */
  /* ==================================================================== */
  {
    const dexieMod = await importBundled('src/db/database.ts', 'p11-db', { alias });
    const { NovelStudioDb } = dexieMod;
    const db = new NovelStudioDb(`p11-migration-${Date.now()}`);

    const versions = db._versions || [];
    const v16 = versions.find((v) => v._cfg && v._cfg.version === 16);
    const v17 = versions.find((v) => v._cfg && v._cfg.version === 17);

    even('migration: v16 version block present', Boolean(v16));
    even('migration: v17 version block present', Boolean(v17));

    if (v16 && v17) {
      const s16 = v16._cfg.storesSource;
      const s17 = v17._cfg.storesSource;
      let sameSchema = true;
      const diffs = [];
      for (const name of Object.keys(s16)) {
        if (s17[name] !== s16[name]) { sameSchema = false; diffs.push(name); }
      }
      even('migration: every v16 store restated byte-identically in v17', sameSchema, diffs.join(','));
      const added = Object.keys(s17).filter((n) => !(n in s16)).sort();
      eq('migration: exactly one store added', added, ['chapterAnalysisRuns']);
      eq('migration: chapterAnalysisRuns schema', s17.chapterAnalysisRuns, '&id, projectId, [projectId+chapterId], [projectId+chapterId+contentFingerprint], updatedAt');
    }

    even('migration: chapterAnalysisRuns table exists', Boolean(db.chapterAnalysisRuns));
    try { db.close(); } catch { /* not open */ }
  }

  cleanupTemp();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length > 0) {
    console.error(`\n${failed.length} check(s) failed: ${failed.map((f) => f.name).join(', ')}`);
    process.exit(1);
  }
}

/** Helper to read a z.enum's options without importing the constant list. */
function ANALYSIS_ENTITY_STATUSES_LIST(schema) {
  return schema.options;
}

main().catch((error) => {
  console.error('P11 verification crashed:', error);
  process.exit(1);
});
