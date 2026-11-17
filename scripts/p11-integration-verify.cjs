/**
 * P11 Chapter Analysis — INTEGRATION layer verification.
 *
 * Runs in plain Node (bundled from source with the project's Vite/esbuild
 * pipeline, see `lib/p4-bundler.cjs`). Exercises `ChapterAnalysisIntegrationService`
 * end-to-end over an in-memory fake of the four stores it touches
 * (`chapterAnalysisRuns`, `characters`, `knowledgeEntries`, `worlds`), with the
 * REAL `CharacterService` / `KnowledgeService` / `WorldService` / repositories
 * wired in.
 *
 * Focus — the review→integration invariants a UI smoke test cannot see:
 *   - Only ACCEPTED candidates are integrable; proposed/dismissed are rejected.
 *   - "match" links an existing canonical entity (no duplicate written).
 *   - "create" writes exactly one new canonical entity of the right family,
 *     where location/faction/rule route to a canonical World SECTION (never a
 *     generic knowledge entry).
 *   - WorldSection persistence is idempotent by title (no duplicate sections).
 *   - "defer"/"dismiss"/"uncertain" write NO canonical entity.
 *   - Alias-aware matching (name + aliases vs name/tags); ambiguous matches are
 *     surfaced, not auto-merged.
 *   - Integration state is DISTINCT from review status (accepting ≠ integrating).
 *   - Accepted relationships link only when BOTH endpoints are integrated.
 *   - Knowledge + Character evidence is grounded to the source chapter; manual
 *     character evidence is never overwritten.
 *   - Evidence grounding: verbatim-only, exact offsets, ambiguous rejected.
 *   - Project isolation: a foreign run / foreign canonical id is rejected.
 *
 * Usage: npm run verify:chapter-analysis:integration
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
/* In-memory fake tables (the Dexie surface the repositories use)            */
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
  return table;
}

function makeFakeDb(tables) {
  const db = { ...tables };
  db.transaction = async (_mode, ...args) => {
    // Dexie passes either (mode, table1, table2, ..., fn) or (mode, [tables], fn).
    const fn = args[args.length - 1];
    return fn();
  };
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

function makeCharacter(overrides = {}) {
  const ts = 1;
  return {
    id: overrides.id ?? 'char_1',
    projectId: overrides.projectId ?? 'projA',
    name: overrides.name ?? 'Elara',
    summary: '',
    background: '',
    personality: '',
    motivation: '',
    appearance: '',
    role: 'supporting',
    status: 'active',
    tags: overrides.tags ?? [],
    evidence: overrides.evidence ?? [],
    createdAt: ts,
    updatedAt: ts,
  };
}

function makeKnowledge(overrides = {}) {
  const ts = 1;
  return {
    id: overrides.id ?? 'knw_1',
    projectId: overrides.projectId ?? 'projA',
    kind: overrides.kind ?? 'location',
    title: overrides.title ?? 'The Keep',
    summary: '',
    body: '',
    tags: overrides.tags ?? [],
    source: 'manual',
    sourceRef: { entityType: 'manual', entityId: null, key: null },
    sourceKey: null,
    evidence: overrides.evidence ?? [],
    searchText: '',
    createdAt: ts,
    updatedAt: ts,
  };
}

function makeWorld(overrides = {}) {
  const ts = 1;
  return {
    id: overrides.id ?? 'world_1',
    projectId: overrides.projectId ?? 'projA',
    title: overrides.title ?? 'World of the story',
    overview: '',
    sections: overrides.sections ?? [],
    themes: [],
    settings: {},
    createdAt: ts,
    updatedAt: ts,
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

function acceptedRelationship(overrides = {}) {
  return {
    key: overrides.key ?? 'rel:0:a->b',
    relation: overrides.relation ?? 'guards',
    fromKey: overrides.fromKey ?? 'character:elara',
    toKey: overrides.toKey ?? 'location:the keep',
    summary: '',
    status: overrides.status ?? 'accepted',
    linkedFromEntityId: null,
    linkedToEntityId: null,
    evidence: [],
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
    confidence: 0.6,
  };
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  const path = require('node:path');
  const alias = { '@': path.resolve(__dirname, '..', 'src') };
  const mod = await importBundled('scripts/lib/p11-entry.ts', 'p11-integration', { alias });
  const {
    ChapterAnalysisRepository,
    ChapterAnalysisIntegrationService,
    ChapterAnalysisIntegrationValidationError,
    CharacterService,
    CharacterRepository,
    KnowledgeService,
    KnowledgeRepository,
    WorldService,
    WorldRepository,
    groundChapterEvidence,
    groundChapterQuotes,
    chapterEvidenceValid,
    canonicalTypeForKind,
    INTEGRATION_ACTIONS,
  } = mod;

  /** Builds a fully-wired integration service over fresh fake tables. */
  function makeHarness({ run = makeRun(), characters = [], knowledge = [], world } = {}) {
    const runsTable = makeFakeTable();
    const charsTable = makeFakeTable();
    const knwTable = makeFakeTable();
    const worldTable = makeFakeTable();
    const db = makeFakeDb({
      chapterAnalysisRuns: runsTable,
      characters: charsTable,
      knowledgeEntries: knwTable,
      worlds: worldTable,
    });
    // Seed.
    runsTable.add(run);
    for (const c of characters) charsTable.add(c);
    for (const k of knowledge) knwTable.add(k);
    if (world) worldTable.add(world);

    const repository = new ChapterAnalysisRepository(db);
    const characterService = new CharacterService(new CharacterRepository(db));
    const knowledgeService = new KnowledgeService({
      repository: new KnowledgeRepository(db),
      characterService,
    });
    const worldService = new WorldService(new WorldRepository(db));
    const service = new ChapterAnalysisIntegrationService({ repository, characterService, knowledgeService, worldService });

    return { service, runsTable, charsTable, knwTable, worldTable, characterService, knowledgeService, worldService };
  }

  /* ==================================================================== */
  /* 0. Constants / kind mapping                                          */
  /* ==================================================================== */
  {
    eq('actions: fixed set', [...INTEGRATION_ACTIONS].sort(), ['create', 'defer', 'dismiss', 'match', 'uncertain']);
    eq('kind map: character -> character', canonicalTypeForKind('character'), 'character');
    // P11 routes world-building kinds to a canonical World SECTION (shared with P8),
    // NOT into a generic knowledge entry.
    eq('kind map: location -> world-section', canonicalTypeForKind('location'), 'world-section');
    eq('kind map: faction -> world-section', canonicalTypeForKind('faction'), 'world-section');
    eq('kind map: rule -> world-section', canonicalTypeForKind('rule'), 'world-section');
    eq('kind map: concept -> knowledge-entry', canonicalTypeForKind('concept'), 'knowledge-entry');
    eq('kind map: event -> knowledge-entry', canonicalTypeForKind('event'), 'knowledge-entry');
  }

  /* ==================================================================== */
  /* 1. Evidence grounding — verbatim-only, exact offsets                 */
  /* ==================================================================== */
  {
    const prose = 'Elara stood watch over The Keep. The night was long.';
    const ok = groundChapterEvidence(prose, 'stood watch');
    eq('ground: found verbatim', ok.ok, true);
    eq('ground: exact start offset', ok.evidence.start, 6);
    eq('ground: exact end offset', ok.evidence.end, 17);
    eq('ground: slice reproduces quote', prose.slice(ok.evidence.start, ok.evidence.end), 'stood watch');

    const missing = groundChapterEvidence(prose, 'danced wildly');
    eq('ground: paraphrase not found', missing.ok, false);
    eq('ground: reason not-found', missing.reason, 'not-found');

    const empty = groundChapterEvidence(prose, '');
    eq('ground: empty quote rejected', empty.reason, 'empty-quote');

    // Ambiguity without a hint.
    const amb = groundChapterEvidence('a b a b', 'a');
    eq('ground: ambiguous without hint', amb.ok, false);
    eq('ground: reason ambiguous', amb.reason, 'ambiguous');
    // Disambiguated by a hint: 'a' occurs at 0 and 4; hint 5 picks the nearest (4).
    const hinted = groundChapterEvidence('a b a b', 'a', { expectedStart: 5 });
    eq('ground: hint disambiguates', hinted.ok && hinted.evidence.start, 4);

    // Multiple quotes: unsupported dropped.
    const list = groundChapterQuotes(prose, ['stood watch', 'not here', 'The night']);
    eq('ground: only supported quotes kept', list.length, 2);

    // Validity re-check.
    even('ground: valid span passes recheck', chapterEvidenceValid(prose, ok.evidence));
    even('ground: tampered span fails recheck', !chapterEvidenceValid(prose, { start: 6, end: 12, quote: 'stood watch' }));
  }

  /* ==================================================================== */
  /* 2. applyDecision requires ACCEPTED (review before integration)       */
  /* ==================================================================== */
  {
    const run = makeRun({ entities: [acceptedEntity({ status: 'proposed' })] });
    const { service } = makeHarness({ run });
    await rejectsWith(
      'gate: proposed candidate cannot be integrated',
      () => service.applyDecision('projA', run.id, { key: 'character:elara', action: 'create' }),
      (e) => e instanceof ChapterAnalysisIntegrationValidationError && e.reason === 'not-accepted',
    );

    const dismissedRun = makeRun({ entities: [acceptedEntity({ status: 'dismissed' })] });
    const h2 = makeHarness({ run: dismissedRun });
    await rejectsWith(
      'gate: dismissed candidate cannot be integrated',
      () => h2.service.applyDecision('projA', dismissedRun.id, { key: 'character:elara', action: 'create' }),
      (e) => e instanceof ChapterAnalysisIntegrationValidationError,
    );

    // Unknown key rejected.
    const h3 = makeHarness({ run: makeRun({ entities: [acceptedEntity()] }) });
    await rejectsWith(
      'gate: unknown candidate key rejected',
      () => h3.service.applyDecision('projA', 'canls_1', { key: 'nope', action: 'create' }),
      (e) => e instanceof ChapterAnalysisIntegrationValidationError && e.reason === 'not-found',
    );
  }

  /* ==================================================================== */
  /* 3. CREATE writes exactly one canonical entity                        */
  /* ==================================================================== */
  {
    // Character.
    const run = makeRun({ entities: [acceptedEntity()] });
    const h = makeHarness({ run });
    const res = await h.service.applyDecision('projA', run.id, { key: 'character:elara', action: 'create' });
    eq('create: outcome created', res.outcome, 'created');
    eq('create: one character row', h.charsTable._all().length, 1);
    const char = h.charsTable._all()[0];
    eq('create: character named Elara', char.name, 'Elara');
    even('create: alias/tag preserved on created character', char.tags.includes('protagonist'));
    eq('create: run entity linked to new id', res.entity.linkedEntityId, char.id);
    eq('create: integration status created', res.entity.integration.status, 'created');
    eq('create: integration matchedBy created', res.entity.integration.matchedBy, 'created');
    eq('create: integration canonicalType character', res.entity.integration.canonicalType, 'character');
    even('create: integration decidedAt stamped', typeof res.entity.integration.decidedAt === 'number');

    // Character evidence provenance: grounded evidence carried onto the CHARACTER.
    const charEv = groundChapterEvidence('Elara stood watch over The Keep.', 'Elara');
    const charEvidenceRun = makeRun({
      entities: [
        acceptedEntity({
          evidence: [{ quote: charEv.evidence.quote, offset: charEv.evidence.start, start: charEv.evidence.start, end: charEv.evidence.end, grounded: true, note: '' }],
        }),
      ],
    });
    const hc = makeHarness({ run: charEvidenceRun });
    await hc.service.applyDecision('projA', charEvidenceRun.id, { key: 'character:elara', action: 'create' });
    const createdChar = hc.charsTable._all()[0];
    eq('create: character evidence chapterId', createdChar.evidence[0].chapterId, 'chapA');
    eq('create: character evidence quote', createdChar.evidence[0].quote, 'Elara');
    eq('create: character evidence offset', createdChar.evidence[0].offset, charEv.evidence.start);

    // Location -> canonical WORLD SECTION (never a knowledge entry), idempotent.
    const ev = groundChapterEvidence('Elara stood watch over The Keep.', 'The Keep');
    const locRun = makeRun({
      entities: [
        acceptedEntity({
          key: 'location:the keep',
          kind: 'location',
          name: 'The Keep',
          evidence: [{ quote: ev.evidence.quote, offset: ev.evidence.start, start: ev.evidence.start, end: ev.evidence.end, grounded: true, note: '' }],
        }),
      ],
    });
    const h2 = makeHarness({ run: locRun });
    const res2 = await h2.service.applyDecision('projA', locRun.id, { key: 'location:the keep', action: 'create' });
    eq('create: NO knowledge entry for location', h2.knwTable._all().length, 0);
    eq('create: a world was created', h2.worldTable._all().length, 1);
    const world = h2.worldTable._all()[0];
    eq('create: world has exactly one section', world.sections.length, 1);
    eq('create: world section title', world.sections[0].title, 'The Keep');
    eq('create: integration canonicalType world-section', res2.entity.integration.canonicalType, 'world-section');
    eq('create: linked to the created section id', res2.entity.linkedEntityId, world.sections[0].id);

    // Idempotent by title: re-creating the SAME location appends NOTHING.
    const again = await h2.service.applyDecision('projA', locRun.id, { key: 'location:the keep', action: 'create' });
    const worldAfter = h2.worldTable._all()[0];
    eq('create: idempotent - still one world', h2.worldTable._all().length, 1);
    eq('create: idempotent - still one section', worldAfter.sections.length, 1);
    eq('create: idempotent - same section id', again.entity.linkedEntityId, worldAfter.sections[0].id);
  }

  /* ==================================================================== */
  /* 4. MATCH links existing, does NOT duplicate                          */
  /* ==================================================================== */
  {
    const existing = makeCharacter({ id: 'char_existing', name: 'Elara' });
    const run = makeRun({ entities: [acceptedEntity()] });
    const h = makeHarness({ run, characters: [existing] });
    const res = await h.service.applyDecision('projA', run.id, { key: 'character:elara', action: 'match', matchId: 'char_existing' });
    eq('match: outcome matched', res.outcome, 'matched');
    eq('match: NO new character written', h.charsTable._all().length, 1);
    eq('match: linked to existing id', res.entity.linkedEntityId, 'char_existing');
    eq('match: matchedBy exact', res.entity.integration.matchedBy, 'exact');
    eq('match: integration status matched', res.entity.integration.status, 'matched');

    // Matching a foreign / missing id is rejected.
    await rejectsWith(
      'match: foreign canonical id rejected',
      () => h.service.applyDecision('projA', run.id, { key: 'character:elara', action: 'match', matchId: 'nope' }),
      (e) => e instanceof ChapterAnalysisIntegrationValidationError && e.reason === 'not-found',
    );
  }

  /* ==================================================================== */
  /* 5. DEFER / DISMISS / UNCERTAIN write nothing                         */
  /* ==================================================================== */
  {
    for (const action of ['defer', 'dismiss', 'uncertain']) {
      const run = makeRun({ entities: [acceptedEntity()] });
      const h = makeHarness({ run });
      const res = await h.service.applyDecision('projA', run.id, { key: 'character:elara', action });
      eq(`${action}: outcome ${action === 'defer' ? 'deferred' : action === 'dismiss' ? 'dismissed' : 'uncertain'}`, res.outcome, action === 'defer' ? 'deferred' : action === 'dismiss' ? 'dismissed' : 'uncertain');
      eq(`${action}: no character written`, h.charsTable._all().length, 0);
      eq(`${action}: no knowledge written`, h.knwTable._all().length, 0);
      eq(`${action}: no canonical id`, res.entity.linkedEntityId, null);
    }
  }

  /* ==================================================================== */
  /* 6. Alias-aware matching (never auto-merge)                           */
  /* ==================================================================== */
  {
    // Candidate named "Elara Vance" with alias "Elara"; existing char named "Elara".
    const existing = makeCharacter({ id: 'char_e', name: 'Elara' });
    const run = makeRun({
      entities: [acceptedEntity({ key: 'character:elara vance', name: 'Elara Vance', aliases: ['Elara'] })],
    });
    const h = makeHarness({ run, characters: [existing] });
    const previews = await h.service.previewIntegration('projA', run.id);
    eq('matching: one preview for accepted candidate', previews.length, 1);
    eq('matching: alias matched existing character', previews[0].matches.length, 1);
    eq('matching: matched by alias', previews[0].matches[0].matchedBy, 'alias');
    eq('matching: not ambiguous', previews[0].ambiguous, false);

    // Two exact same-name characters -> ambiguous (possible duplicate).
    const dupA = makeCharacter({ id: 'char_a', name: 'Elara' });
    const dupB = makeCharacter({ id: 'char_b', name: 'Elara' });
    const run2 = makeRun({ entities: [acceptedEntity({ key: 'character:elara', name: 'Elara' })] });
    const h2 = makeHarness({ run: run2, characters: [dupA, dupB] });
    const previews2 = await h2.service.previewIntegration('projA', run2.id);
    eq('matching: two exact matches flagged ambiguous', previews2[0].ambiguous, true);
    eq('matching: both matches returned', previews2[0].matches.length, 2);

    // Location matching resolves against canonical WORLD SECTIONS (not knowledge).
    const world = makeWorld({
      id: 'world_x',
      sections: [
        { id: 'sec_keep', title: 'The Keep', content: 'A stone fortress on the ridge.' },
        { id: 'sec_mill', title: 'The Mill', content: 'A water mill.' },
      ],
    });
    const run3 = makeRun({ entities: [acceptedEntity({ key: 'location:the keep', kind: 'location', name: 'The Keep' })] });
    const h3 = makeHarness({ run: run3, world });
    const previews3 = await h3.service.previewIntegration('projA', run3.id);
    eq('matching: location matched against world section', previews3[0].matches.map((m) => m.id), ['sec_keep']);
    eq('matching: location target canonicalType world-section', previews3[0].targetCanonicalType, 'world-section');

    // Knowledge matching restricted to same kind.
    const knwSameKind = makeKnowledge({ id: 'k_concept', kind: 'concept', title: 'The Prophecy' });
    const knwOtherKind = makeKnowledge({ id: 'k_item', kind: 'item', title: 'The Prophecy' });
    const run4 = makeRun({ entities: [acceptedEntity({ key: 'concept:the prophecy', kind: 'concept', name: 'The Prophecy' })] });
    const h4 = makeHarness({ run: run4, knowledge: [knwSameKind, knwOtherKind] });
    const previews4 = await h4.service.previewIntegration('projA', run4.id);
    eq('matching: knowledge restricted to same kind', previews4[0].matches.map((m) => m.id), ['k_concept']);
  }

  /* ==================================================================== */
  /* 7. Review status DISTINCT from integration status                    */
  /* ==================================================================== */
  {
    const run = makeRun({ entities: [acceptedEntity()] });
    const h = makeHarness({ run });
    // Accepted but NOT integrated yet: review=accepted, integration=unreviewed.
    const before = (await h.service.previewIntegration('projA', run.id))[0];
    eq('separation: review accepted', run.entities[0].status, 'accepted');
    eq('separation: integration initially unreviewed', before.integration.status, 'unreviewed');

    const res = await h.service.applyDecision('projA', run.id, { key: 'character:elara', action: 'create' });
    eq('separation: integration advances to created', res.entity.integration.status, 'created');
    // Review status UNCHANGED by integration.
    eq('separation: review status unchanged by integration', res.entity.status, 'accepted');
  }

  /* ==================================================================== */
  /* 8. Relationships link only when BOTH endpoints integrated            */
  /* ==================================================================== */
  {
    const run = makeRun({
      entities: [
        acceptedEntity({ key: 'character:elara', name: 'Elara', kind: 'character' }),
        acceptedEntity({ key: 'location:the keep', name: 'The Keep', kind: 'location' }),
      ],
      relationships: [acceptedRelationship({ fromKey: 'character:elara', toKey: 'location:the keep' })],
    });
    const h = makeHarness({ run });

    // Integrate ONLY the character.
    await h.service.applyDecision('projA', run.id, { key: 'character:elara', action: 'create' });
    let linked = await h.service.linkRelationships('projA', run.id);
    let rel = linked.run.relationships[0];
    eq('relationships: not linked while target not integrated', rel.linkedFromEntityId, null);
    eq('relationships: target id still null', rel.linkedToEntityId, null);

    // Now integrate the location too, and re-link.
    await h.service.applyDecision('projA', run.id, { key: 'location:the keep', action: 'create' });
    linked = await h.service.linkRelationships('projA', run.id);
    rel = linked.run.relationships[0];
    even('relationships: from id now set', typeof rel.linkedFromEntityId === 'string' && rel.linkedFromEntityId.length > 0);
    even('relationships: to id now set', typeof rel.linkedToEntityId === 'string' && rel.linkedToEntityId.length > 0);
    eq('relationships: integration status matched', rel.integration.status, 'matched');

    // A relationship that is NOT accepted is never linked.
    const run2 = makeRun({
      entities: [
        acceptedEntity({ key: 'character:elara' }),
        acceptedEntity({ key: 'location:the keep', kind: 'location', name: 'The Keep' }),
      ],
      relationships: [acceptedRelationship({ status: 'proposed' })],
    });
    const h2 = makeHarness({ run: run2 });
    await h2.service.integrateAccepted('projA', run2.id);
    const rel2 = (await h2.service.previewIntegration('projA', run2.id), run2.relationships[0]);
    eq('relationships: proposed relationship not linked', rel2.linkedFromEntityId, null);
  }

  /* ==================================================================== */
  /* 9. integrateAccepted — one-click policy                              */
  /* ==================================================================== */
  {
    // Existing "Elara" character -> should MATCH, not duplicate; "The Keep" -> CREATE.
    const existingChar = makeCharacter({ id: 'char_e', name: 'Elara' });
    const run = makeRun({
      entities: [
        acceptedEntity({ key: 'character:elara', name: 'Elara', kind: 'character' }),
        acceptedEntity({ key: 'location:the keep', name: 'The Keep', kind: 'location' }),
      ],
    });
    const h = makeHarness({ run, characters: [existingChar] });
    const res = await h.service.integrateAccepted('projA', run.id);
    eq('integrate-all: matched existing character (no dup)', h.charsTable._all().length, 1);
    eq('integrate-all: created one world (for the location)', h.worldTable._all().length, 1);
    eq('integrate-all: NO knowledge entry created', h.knwTable._all().length, 0);
    const elara = res.run.entities.find((e) => e.key === 'character:elara');
    eq('integrate-all: character matched', elara.integration.status, 'matched');
    eq('integrate-all: character linked to existing', elara.linkedEntityId, 'char_e');
    const keep = res.run.entities.find((e) => e.key === 'location:the keep');
    eq('integrate-all: location created', keep.integration.status, 'created');
    eq('integrate-all: location canonicalType world-section', keep.integration.canonicalType, 'world-section');
  }

  /* ==================================================================== */
  /* 10. Project isolation                                                */
  /* ==================================================================== */
  {
    const run = makeRun({ projectId: 'projA', entities: [acceptedEntity()] });
    const h = makeHarness({ run });
    await rejectsWith(
      'isolation: foreign project run rejected (preview)',
      () => h.service.previewIntegration('projB', run.id),
      (e) => e instanceof ChapterAnalysisIntegrationValidationError && e.reason === 'not-found',
    );
    await rejectsWith(
      'isolation: foreign project run rejected (apply)',
      () => h.service.applyDecision('projB', run.id, { key: 'character:elara', action: 'create' }),
      (e) => e instanceof ChapterAnalysisIntegrationValidationError,
    );
  }

  /* ==================================================================== */
  /* 11. BATCH atomicity — a bad decision aborts the whole batch          */
  /* ==================================================================== */
  {
    const run = makeRun({
      entities: [
        acceptedEntity({ key: 'character:elara', kind: 'character', name: 'Elara' }),
        acceptedEntity({ key: 'location:the keep', kind: 'location', name: 'The Keep' }),
      ],
    });
    const h = makeHarness({ run });
    await rejectsWith(
      'batch: invalid decision aborts whole batch',
      () =>
        h.service.applyDecisions('projA', run.id, [
          { key: 'character:elara', action: 'create' },
          { key: 'nope', action: 'create' },
        ]),
      (e) => e instanceof ChapterAnalysisIntegrationValidationError,
    );
    // Validation happens before ANY write -> nothing created.
    eq('batch: no character written when batch invalid', h.charsTable._all().length, 0);
    eq('batch: no knowledge written when batch invalid', h.knwTable._all().length, 0);
  }

  /* ==================================================================== */
  /* 12. Persistence — integration state survives reload                  */
  /* ==================================================================== */
  {
    const run = makeRun({ entities: [acceptedEntity()] });
    const h = makeHarness({ run });
    const res = await h.service.applyDecision('projA', run.id, { key: 'character:elara', action: 'create' });
    // Reload from the store.
    const reloaded = await h.service.previewIntegration('projA', run.id);
    eq('persist: integration state reloaded', reloaded[0].integration.status, 'created');
    eq('persist: canonical id persisted', reloaded[0].integration.canonicalEntityId, res.entity.linkedEntityId);
  }

  /* ==================================================================== */
  /* 13. WorldSection integration — faction/rule + MATCH existing section */
  /* ==================================================================== */
  {
    // Faction and rule both route to world sections and append distinct sections.
    const run = makeRun({
      entities: [
        acceptedEntity({ key: 'faction:the order', kind: 'faction', name: 'The Order', summary: 'A knightly order.' }),
        acceptedEntity({ key: 'rule:magic cost', kind: 'rule', name: 'Magic Cost', summary: 'Spells drain life.' }),
      ],
    });
    const h = makeHarness({ run });
    await h.service.applyDecision('projA', run.id, { key: 'faction:the order', action: 'create' });
    await h.service.applyDecision('projA', run.id, { key: 'rule:magic cost', action: 'create' });
    eq('world: one world after faction + rule', h.worldTable._all().length, 1);
    const world = h.worldTable._all()[0];
    eq('world: two sections (faction + rule)', world.sections.length, 2);
    eq('world: faction section title', world.sections.find((s) => s.title === 'The Order') ? 'The Order' : null, 'The Order');
    eq('world: rule section title', world.sections.find((s) => s.title === 'Magic Cost') ? 'Magic Cost' : null, 'Magic Cost');
    even('world: faction content begins with summary', world.sections.find((s) => s.title === 'The Order').content.startsWith('A knightly order.'));

    // MATCH an existing world section: no new section, links to the existing id.
    const seededWorld = makeWorld({ id: 'world_seed', sections: [{ id: 'sec_keep', title: 'The Keep', content: 'A fortress.' }] });
    const matchRun = makeRun({ entities: [acceptedEntity({ key: 'location:the keep', kind: 'location', name: 'The Keep' })] });
    const hm = makeHarness({ run: matchRun, world: seededWorld });
    const res = await hm.service.applyDecision('projA', matchRun.id, { key: 'location:the keep', action: 'match', matchId: 'sec_keep' });
    eq('world match: outcome matched', res.outcome, 'matched');
    eq('world match: NO new section', hm.worldTable._all()[0].sections.length, 1);
    eq('world match: linked to existing section', res.entity.linkedEntityId, 'sec_keep');
    eq('world match: canonicalType world-section', res.entity.integration.canonicalType, 'world-section');

    // Matching a foreign/missing section id is rejected.
    await rejectsWith(
      'world match: missing section rejected',
      () => hm.service.applyDecision('projA', matchRun.id, { key: 'location:the keep', action: 'match', matchId: 'nope' }),
      (e) => e instanceof ChapterAnalysisIntegrationValidationError && e.reason === 'not-found',
    );
  }

  /* ==================================================================== */
  /* 14. Possible duplicate review + identity confirmation                */
  /* ==================================================================== */
  {
    // Preview exposes identity context (summary) on each canonical match.
    const existing = makeCharacter({ id: 'char_e', name: 'Elara' });
    existing.summary = 'A ranger of the northern woods.';
    const run = makeRun({ entities: [acceptedEntity({ key: 'character:elara', name: 'Elara' })] });
    const h = makeHarness({ run, characters: [existing] });
    const previews = await h.service.previewIntegration('projA', run.id);
    eq('identity: match carries a summary for verification', previews[0].matches[0].summary, 'A ranger of the northern woods.');

    // Explicit possible-duplicate decision persists the referenced id (no merge).
    const flagged = await h.service.applyDecision('projA', run.id, {
      key: 'character:elara',
      action: 'uncertain',
      duplicateOfId: 'char_e',
      duplicateOfLabel: 'Elara',
    });
    eq('duplicate: outcome uncertain', flagged.outcome, 'uncertain');
    eq('duplicate: no character written', h.charsTable._all().length, 1); // only the seeded one
    eq('duplicate: referenced id persisted', flagged.entity.integration.possibleDuplicateId, 'char_e');
    eq('duplicate: referenced label persisted', flagged.entity.integration.possibleDuplicateLabel, 'Elara');
    eq('duplicate: still uncertain status', flagged.entity.integration.status, 'uncertain');
    // Durable across reload (persisted on the run).
    const reloaded = await h.service.previewIntegration('projA', run.id);
    eq('duplicate: durable across reload', reloaded[0].integration.possibleDuplicateId, 'char_e');

    // Cross-run duplicate detection: same-name candidate in ANOTHER run of the chapter.
    const otherRun = makeRun({
      id: 'canls_prev',
      chapterId: 'chapA',
      contentFingerprint: 'sha256:old',
      entities: [acceptedEntity({ key: 'character:elara', name: 'Elara' })],
    });
    const currentRun = makeRun({ id: 'canls_now', chapterId: 'chapA', contentFingerprint: 'sha256:new', entities: [acceptedEntity({ key: 'character:elara', name: 'Elara' })] });
    const runsTable = makeFakeTable();
    const charsTable = makeFakeTable();
    const knwTable = makeFakeTable();
    const worldTable = makeFakeTable();
    const db = makeFakeDb({ chapterAnalysisRuns: runsTable, characters: charsTable, knowledgeEntries: knwTable, worlds: worldTable });
    await runsTable.add(otherRun);
    await runsTable.add(currentRun);
    const service = new ChapterAnalysisIntegrationService({
      repository: new ChapterAnalysisRepository(db),
      characterService: new CharacterService(new CharacterRepository(db)),
      knowledgeService: new KnowledgeService({ repository: new KnowledgeRepository(db), characterService: new CharacterService(new CharacterRepository(db)) }),
      worldService: new WorldService(new WorldRepository(db)),
    });
    const crossPreviews = await service.previewIntegration('projA', currentRun.id);
    eq('duplicate: cross-run proposal surfaced', crossPreviews[0].possibleDuplicates.length, 1);
    even('duplicate: cross-run reference is a run-scoped id', crossPreviews[0].possibleDuplicates[0].id.startsWith('run:canls_prev'));
  }

  /* ==================================================================== */
  /* 15. Character evidence provenance — never overwrites manual evidence */
  /* ==================================================================== */
  {
    // A character that ALREADY has manual evidence must NOT be overwritten on match.
    const manualEvidence = [{ chapterId: 'chapManual', sceneId: null, quote: 'Manually recorded quote.', offset: null, note: 'hand-entered' }];
    const existing = makeCharacter({ id: 'char_manual', name: 'Elara', tags: [] });
    existing.evidence = manualEvidence;
    const ev = groundChapterEvidence('Elara stood watch over The Keep.', 'Elara');
    const run = makeRun({
      entities: [
        acceptedEntity({
          key: 'character:elara',
          evidence: [{ quote: ev.evidence.quote, offset: ev.evidence.start, start: ev.evidence.start, end: ev.evidence.end, grounded: true, note: '' }],
        }),
      ],
    });
    const h = makeHarness({ run, characters: [existing] });
    const res = await h.service.applyDecision('projA', run.id, { key: 'character:elara', action: 'match', matchId: 'char_manual' });
    eq('evidence: match outcome matched', res.outcome, 'matched');
    const after = h.charsTable._all()[0];
    eq('evidence: manual evidence preserved (count)', after.evidence.length, 1);
    eq('evidence: manual quote preserved', after.evidence[0].quote, 'Manually recorded quote.');
    eq('evidence: manual note preserved', after.evidence[0].note, 'hand-entered');
    eq('evidence: manual evidence NOT overwritten', after.evidence[0].chapterId, 'chapManual');

    // A character with NO evidence gets the candidate's evidence back-filled on match.
    const empty = makeCharacter({ id: 'char_empty', name: 'Elara', tags: [] });
    const run2 = makeRun({
      entities: [
        acceptedEntity({
          key: 'character:elara',
          evidence: [{ quote: ev.evidence.quote, offset: ev.evidence.start, start: ev.evidence.start, end: ev.evidence.end, grounded: true, note: '' }],
        }),
      ],
    });
    const h2 = makeHarness({ run: run2, characters: [empty] });
    await h2.service.applyDecision('projA', run2.id, { key: 'character:elara', action: 'match', matchId: 'char_empty' });
    const filled = h2.charsTable._all()[0];
    eq('evidence: empty character back-filled on match', filled.evidence.length, 1);
    eq('evidence: back-filled chapterId', filled.evidence[0].chapterId, 'chapA');
    eq('evidence: back-filled quote', filled.evidence[0].quote, 'Elara');
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
  console.error('P11 integration verification crashed:', error);
  process.exit(1);
});
