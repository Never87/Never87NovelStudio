// P8 Batch-5 verification — Project Integration (IntegrationService).
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
    const ok = predicate ? predicate(error) : true;
    record(name, ok, ok ? undefined : `threw ${error && error.name}(${error && error.reason}): ${error && error.message}`);
  }
}

/* ---- fake tables / db (same strategy as p8-review) ---------------------- */

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
    _snapshot: () => new Map([...map].map(([k, v]) => [k, clone(v)])),
    _restore: (snap) => {
      map.clear();
      for (const [k, v] of snap) map.set(k, v);
    },
    async get(id) {
      return map.has(id) ? clone(map.get(id)) : undefined;
    },
    async add(row) {
      if (map.has(row.id)) {
        const err = new Error('ConstraintError');
        err.name = 'ConstraintError';
        throw err;
      }
      map.set(row.id, clone(row));
    },
    async bulkAdd(rows) {
      for (const r of rows) {
        if (map.has(r.id)) {
          const err = new Error('ConstraintError');
          err.name = 'ConstraintError';
          throw err;
        }
      }
      for (const r of rows) map.set(r.id, clone(r));
    },
    async put(row) {
      map.set(row.id, clone(row));
    },
    async delete(id) {
      map.delete(id);
    },
    where(index) {
      const list = () => [...map.values()];
      const sel = (predicate) => ({
        async toArray() {
          return list().filter(predicate).map(clone);
        },
        async first() {
          const r = list().find(predicate);
          return r ? clone(r) : undefined;
        },
        async delete() {
          let n = 0;
          for (const r of list())
            if (predicate(r)) {
              map.delete(r.id);
              n += 1;
            }
          return n;
        },
        async count() {
          return list().filter(predicate).length;
        },
      });
      return {
        equals(value) {
          return sel((r) => matchesIndex(r, index, value));
        },
        between(lower, upper) {
          return sel((r) => r.documentId === lower[0] && r.order >= lower[1] && r.order <= upper[1]);
        },
      };
    },
  };
  return table;
}

function makeStores() {
  const tables = {
    documents: makeFakeTable(),
    sections: makeFakeTable(),
    extractions: makeFakeTable(),
    characters: makeFakeTable(),
    worlds: makeFakeTable(),
    knowledge: makeFakeTable(),
  };
  const db = {
    sourceDocuments: tables.documents,
    documentSections: tables.sections,
    extractionRecords: tables.extractions,
    characters: tables.characters,
    worlds: tables.worlds,
    knowledgeEntries: tables.knowledge,
    async transaction(_mode, ...args) {
      const fn = args[args.length - 1];
      // Snapshot EVERY table so an entity write is rolled back together with the
      // extraction stamp (proves the shared-transaction atomicity).
      const snaps = Object.values(tables).map((t) => t._snapshot());
      try {
        return await fn();
      } catch (error) {
        Object.values(tables).forEach((t, i) => t._restore(snaps[i]));
        throw error;
      }
    },
  };
  for (const t of Object.values(tables)) t.db = db;
  return { db, tables };
}

function makeFakeProjectService(ids) {
  const set = new Set(ids);
  return {
    async projectExists(id) {
      return set.has(id);
    },
  };
}

/** Wires the full P8 stack + P5/P7 repositories against the fake db. */
function makeServices(mod, { projects = ['projA', 'projB'] } = {}) {
  const { db, tables } = makeStores();
  const projectService = makeFakeProjectService(projects);
  const repository = new mod.ImportRepository(db);
  const importService = new mod.ImportService({ repository, projectService, db });
  const extractionService = new mod.ExtractionService({
    repository,
    importService,
    generate: async () => ({ result: { content: '{"candidates":[]}', finishReason: 'stop' } }),
  });
  const reviewService = new mod.ReviewService({ repository, importService, extractionService });
  const knowledgeRepository = new mod.KnowledgeRepository(db);
  const characterRepository = new mod.CharacterRepository(db);
  const worldRepository = new mod.WorldRepository(db);
  const integrationService = new mod.IntegrationService({
    repository,
    importService,
    knowledgeRepository,
    characterRepository,
    worldRepository,
  });
  return {
    db,
    tables,
    repository,
    importService,
    extractionService,
    reviewService,
    knowledgeRepository,
    characterRepository,
    worldRepository,
    integrationService,
  };
}

/** Sets up a confirmed document with deterministic structure. */
async function setupConfirmedDoc(importService, opts = {}) {
  const projectId = opts.projectId || 'projA';
  const rawText =
    opts.rawText ||
    '# Volume One\n\n## Chapter 1\n\nElara the brave walked into the forest.\n\nAria the wise followed her closely.\n';
  const doc = await importService.createDocument(projectId, { format: 'markdown', rawText });
  await importService.parseDocument(projectId, doc.id);
  await importService.confirmStructure(projectId, doc.id);
  const sections = await importService.getConfirmedSections(projectId, doc.id);
  return { doc, sections };
}

function pickProse(sections) {
  return sections.find((s) => s.level === 'paragraph') || sections[sections.length - 1];
}

/** Seeds a record via the extraction service, then CONFIRMS it (integration gate). */
async function seedConfirmed(extractionService, reviewService, doc, prose, overrides = {}) {
  const rec = await extractionService.createManualExtraction('projA', {
    documentId: doc.id,
    kind: overrides.kind || 'character',
    title: overrides.title || 'Elara',
    summary: overrides.summary,
    body: overrides.body,
    tags: overrides.tags,
    evidence: [{ sectionId: prose.id, quote: overrides.quote || 'Elara the brave' }],
  });
  await reviewService.confirmExtraction('projA', rec.id);
  return rec;
}

async function main() {
  const path = require('node:path');
  const alias = { '@': path.resolve(__dirname, '..', 'src') };
  const mod = await importBundled('scripts/lib/p8-integration-entry.ts', 'p8b5', { alias });
  const {
    IntegrationValidationError,
    IntegrationNotFoundError,
    KnowledgeEntrySchema,
    EvidenceSchema,
    CharacterSchema,
    WorldSchema,
  } = mod;

  /* ==================================================================== */
  /* A. Schema: additive evidence provenance is backward-compatible       */
  /* ==================================================================== */
  {
    // Pre-existing evidence (chapter/scene only) still validates unchanged.
    const legacy = EvidenceSchema.safeParse({
      chapterId: 'chap_1',
      sceneId: null,
      quote: 'hi',
      offset: null,
      note: '',
    });
    even('schema.evidence: legacy chapter evidence still valid', legacy.success);

    // Import-provenance evidence (no chapter/scene) validates only WITH `source`.
    const sourceOnly = EvidenceSchema.safeParse({
      chapterId: null,
      sceneId: null,
      quote: 'hi',
      offset: null,
      note: '',
      source: { documentId: 'd', sectionId: 's', start: 0, end: 2 },
    });
    even('schema.evidence: document-source evidence valid', sourceOnly.success);

    const noLocator = EvidenceSchema.safeParse({
      chapterId: null,
      sceneId: null,
      quote: 'hi',
      offset: null,
      note: '',
    });
    even('schema.evidence: no locator at all is rejected', !noLocator.success);

    const badRange = EvidenceSchema.safeParse({
      chapterId: null,
      sceneId: null,
      quote: '',
      offset: null,
      note: '',
      source: { documentId: 'd', sectionId: 's', start: 5, end: 2 },
    });
    even('schema.evidence: source end<start is rejected', !badRange.success);
  }

  /* ==================================================================== */
  /* B. The gate: only CONFIRMED records integrate                        */
  /* ==================================================================== */
  {
    const { importService, extractionService, reviewService, integrationService } = makeServices(mod);
    const { doc, sections } = await setupConfirmedDoc(importService);
    const prose = pickProse(sections);

    const pending = await extractionService.createManualExtraction('projA', {
      documentId: doc.id,
      kind: 'character',
      title: 'Elara',
      evidence: [{ sectionId: prose.id, quote: 'Elara the brave' }],
    });

    await rejectsWith(
      'gate: pending record refused (not-confirmed)',
      () => integrationService.integrateExtraction('projA', pending.id),
      (e) => e instanceof IntegrationValidationError && e.reason === 'not-confirmed',
    );

    const confirmed = await seedConfirmed(extractionService, reviewService, doc, prose);
    const item = await integrationService.integrateExtraction('projA', confirmed.id);
    eq('gate: confirmed record integrates', item.record.integration.status, 'applied');
    eq('gate: record integration target type', item.record.integration.appliedEntityType, 'character');
    eq('gate: applied flag', item.applied, 'created');

    await rejectsWith(
      'gate: missing record -> NotFound',
      () => integrationService.integrateExtraction('projA', 'ext_ghost'),
      (e) => e instanceof IntegrationNotFoundError,
    );
    await rejectsWith(
      'gate: cross-project -> NotFound',
      () => integrationService.integrateExtraction('projB', confirmed.id),
      (e) => e instanceof IntegrationNotFoundError,
    );
  }

  /* ==================================================================== */
  /* C. Routing to a Character (idempotent + no silent overwrite)         */
  /* ==================================================================== */
  {
    const { importService, extractionService, reviewService, integrationService, characterRepository } =
      makeServices(mod);
    const { doc, sections } = await setupConfirmedDoc(importService);
    const prose = pickProse(sections);

    const rec = await seedConfirmed(extractionService, reviewService, doc, prose, {
      title: 'Elara',
      summary: 'A brave ranger.',
      body: 'Elara leads the vanguard.',
      tags: ['hero'],
    });
    const first = await integrationService.integrateExtraction('projA', rec.id);
    eq('character: created', first.applied, 'created');
    eq('character: target type', first.target.type, 'character');

    const characters = await characterRepository.getByProjectId('projA');
    eq('character: exactly one written', characters.length, 1);
    eq('character: name from title', characters[0].name, 'Elara');
    eq('character: summary carried', characters[0].summary, 'A brave ranger.');
    eq('character: background from body', characters[0].background, 'Elara leads the vanguard.');
    eq('character: tags carried', characters[0].tags, ['hero']);
    const parsed = CharacterSchema.safeParse(characters[0]);
    even('character: stored record is schema-valid', parsed.success);

    // Re-running the SAME integration is an idempotent no-op.
    const again = await integrationService.integrateExtraction('projA', rec.id);
    eq('character: re-integrate is idempotent (updated)', again.applied, 'updated');
    eq('character: still exactly one character', (await characterRepository.getByProjectId('projA')).length, 1);
    eq('character: same target id', again.target.id, first.target.id);

    // A DIFFERENT record with the same name must NOT overwrite hand-authored data.
    // First, simulate a user edit to the created character.
    const existing = (await characterRepository.getByProjectId('projA'))[0];
    await characterRepository.update({ ...existing, summary: 'User-authored summary.' });
    // A second, distinct extraction for the same character name + a changed
    // summary (a different primary section avoids the (title, section) dedupe).
    const ariaSection =
      sections.find((s) => s.level === 'paragraph' && s.text.includes('Aria the wise')) || prose;
    const rec2 = await seedConfirmed(extractionService, reviewService, doc, ariaSection, {
      title: 'Elara',
      summary: 'A different summary from a later import.',
      quote: 'Aria the wise',
    });
    const merged = await integrationService.integrateExtraction('projA', rec2.id);
    eq('character: matched by exact name (updated)', merged.applied, 'updated');
    eq('character: still one character after match', (await characterRepository.getByProjectId('projA')).length, 1);
    const after = (await characterRepository.getByProjectId('projA'))[0];
    eq('character: existing summary preserved (no silent overwrite)', after.summary, 'User-authored summary.');
    even(
      'character: conflict reported instead of overwrite',
      merged.conflicts.some((c) => c.field === 'summary'),
    );
  }

  /* ==================================================================== */
  /* D. Routing to a World section                                        */
  /* ==================================================================== */
  {
    const { importService, extractionService, reviewService, integrationService, worldRepository } =
      makeServices(mod);
    const { doc, sections } = await setupConfirmedDoc(importService);
    const prose = pickProse(sections);

    const rec = await seedConfirmed(extractionService, reviewService, doc, prose, {
      kind: 'location',
      title: 'Whispering Forest',
      summary: 'A dense, ancient wood.',
      body: 'The forest is said to be haunted.',
      quote: 'walked into the forest',
    });
    const item = await integrationService.integrateExtraction('projA', rec.id);
    eq('world: target type', item.target.type, 'world-section');
    eq('world: created', item.applied, 'created');

    const world = await worldRepository.getByProjectId('projA');
    even('world: a world row was created', Boolean(world));
    eq('world: one section', world.sections.length, 1);
    eq('world: section title', world.sections[0].title, 'Whispering Forest');
    even('world: section content carried', world.sections[0].content.includes('haunted'));
    const parsed = WorldSchema.safeParse(world);
    even('world: stored world is schema-valid', parsed.success);

    // Re-integrate is idempotent, and a second location appends.
    await integrationService.integrateExtraction('projA', rec.id);
    eq('world: re-integrate keeps one section', (await worldRepository.getByProjectId('projA')).sections.length, 1);

    const rec2 = await seedConfirmed(extractionService, reviewService, doc, prose, {
      kind: 'faction',
      title: 'Forest Wardens',
      summary: 'Guardians of the wood.',
      quote: 'walked into the forest',
    });
    await integrationService.integrateExtraction('projA', rec2.id);
    eq('world: second location appends a section', (await worldRepository.getByProjectId('projA')).sections.length, 2);
  }

  /* ==================================================================== */
  /* E. Routing to a Knowledge entry (evidence provenance)                */
  /* ==================================================================== */
  {
    const { importService, extractionService, reviewService, integrationService, knowledgeRepository } =
      makeServices(mod);
    const { doc, sections } = await setupConfirmedDoc(importService);
    const prose = pickProse(sections);

    const rec = await seedConfirmed(extractionService, reviewService, doc, prose, {
      kind: 'event',
      title: 'The First Hunt',
      summary: 'The day the forest changed.',
      body: 'On that day, the trees wept.',
    });
    const item = await integrationService.integrateExtraction('projA', rec.id);
    eq('knowledge: target type', item.target.type, 'knowledge-entry');
    eq('knowledge: applied created', item.applied, 'created');

    const entries = await knowledgeRepository.getByProjectId('projA');
    eq('knowledge: exactly one entry', entries.length, 1);
    const entry = entries[0];
    eq('knowledge: kind mapped from event', entry.kind, 'event');
    eq('knowledge: title carried', entry.title, 'The First Hunt');
    eq('knowledge: source is manual index', entry.source, 'manual');
    even('knowledge: traced to extraction via sourceKey', Boolean(entry.sourceKey));
    eq('knowledge: evidence carries document provenance', entry.evidence[0].source.documentId, doc.id);
    eq('knowledge: evidence section matches', entry.evidence[0].source.sectionId, prose.id);
    even('knowledge: evidence quote preserved', entry.evidence[0].quote === 'Elara the brave');
    const parsedEntry = KnowledgeEntrySchema.safeParse(entry);
    even('knowledge: stored entry is schema-valid', parsedEntry.success);

    // Idempotent: one entry per extraction even across re-runs.
    await integrationService.integrateExtraction('projA', rec.id);
    eq('knowledge: re-integrate keeps one entry', (await knowledgeRepository.getByProjectId('projA')).length, 1);

    // relationship / style are folded into a concept entry.
    const rel = await seedConfirmed(extractionService, reviewService, doc, prose, {
      kind: 'relationship',
      title: 'Elara & Aria',
      summary: 'Bound by oath.',
    });
    await integrationService.integrateExtraction('projA', rel.id);
    const all = await knowledgeRepository.getByProjectId('projA');
    const relEntry = all.find((e) => e.title === 'Elara & Aria');
    even('knowledge: relationship folded into concept entry', relEntry && relEntry.kind === 'concept');
  }

  /* ==================================================================== */
  /* F. Grounding: stale evidence is refused                              */
  /* ==================================================================== */
  {
    const { importService, extractionService, reviewService, integrationService, tables } = makeServices(mod);
    const { doc, sections } = await setupConfirmedDoc(importService);
    const prose = pickProse(sections);
    const rec = await seedConfirmed(extractionService, reviewService, doc, prose);

    // Mutate the stored raw text so the evidence no longer resolves.
    const repoDoc = await integrationService.repository.getDocumentById(doc.id);
    await integrationService.repository.updateDocument({
      ...repoDoc,
      rawText: repoDoc.rawText.replace('Elara the brave', 'Zzzzz the brave'),
    });

    await rejectsWith(
      'grounding: stale evidence refused (invalid-evidence)',
      () => integrationService.integrateExtraction('projA', rec.id),
      (e) => e instanceof IntegrationValidationError && e.reason === 'invalid-evidence',
    );
    // Nothing was written as a side-effect.
    eq('grounding: no character written on refusal', (await tables.characters._all()).length, 0);
    const after = await integrationService.repository.getExtractionById(rec.id);
    eq('grounding: record stays not-applied', after.integration.status, 'not-applied');
  }

  /* ==================================================================== */
  /* G. Batch integration + pending list                                  */
  /* ==================================================================== */
  {
    const { importService, extractionService, reviewService, integrationService, characterRepository } =
      makeServices(mod);
    const { doc, sections } = await setupConfirmedDoc(importService);
    const prose = pickProse(sections);

    const a = await seedConfirmed(extractionService, reviewService, doc, prose, { title: 'Alpha', quote: 'walked into the forest' });
    const b = await seedConfirmed(extractionService, reviewService, doc, prose, {
      title: 'Beta',
      quote: 'walked into the forest',
    });
    // A still-pending record must be skipped, not integrated.
    const pending = await extractionService.createManualExtraction('projA', {
      documentId: doc.id,
      kind: 'character',
      title: 'Gamma',
      evidence: [{ sectionId: prose.id, quote: 'Elara the brave' }],
    });

    const before = await integrationService.listPendingIntegration('projA');
    eq('batch: pending list has both confirmed records', before.map((r) => r.id).sort(), [a.id, b.id].sort());

    const result = await integrationService.integrateMany('projA', [a.id, b.id, pending.id]);
    eq('batch: two integrated', result.integrated, 2);
    eq('batch: one skipped (pending)', result.skipped, 1);
    eq('batch: two characters written', (await characterRepository.getByProjectId('projA')).length, 2);

    const remaining = await integrationService.listPendingIntegration('projA');
    eq('batch: pending list now empty', remaining.length, 0);

    // Re-running the batch skips already-applied records.
    const rerun = await integrationService.integrateMany('projA', [a.id, b.id]);
    eq('batch: re-run integrates nothing', rerun.integrated, 0);
    eq('batch: re-run skips both', rerun.skipped, 2);
  }

  /* ==================================================================== */
  /* H. Atomicity: a failing entity write rolls back the extraction stamp */
  /* ==================================================================== */
  {
    const { importService, extractionService, reviewService, integrationService, characterRepository, tables } =
      makeServices(mod);
    const { doc, sections } = await setupConfirmedDoc(importService);
    const prose = pickProse(sections);
    const rec = await seedConfirmed(extractionService, reviewService, doc, prose, { title: 'Rollback Hero' });

    // Fail the extraction-update step AFTER the character was created. The
    // shared transaction must restore the character table to its prior state.
    const realUpdate = integrationService.repository.updateExtraction.bind(integrationService.repository);
    integrationService.repository.updateExtraction = async () => {
      const err = new Error('simulated write failure');
      err.name = 'AbortError';
      throw err;
    };

    await rejectsWith('atomicity: integration fails on stamp write', () => integrationService.integrateExtraction('projA', rec.id), () => true);
    integrationService.repository.updateExtraction = realUpdate;

    eq('atomicity: character creation rolled back', (await tables.characters._all()).length, 0);
    const after = await integrationService.repository.getExtractionById(rec.id);
    eq('atomicity: record not stamped applied', after.integration.status, 'not-applied');
    void characterRepository;
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
  console.error('P8 Batch-5 verification crashed:', error);
  process.exit(1);
});
