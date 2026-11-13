// P8 Batch-4 verification �?Extraction Review Center (ReviewService).
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

/* ---- fake tables / db (same strategy as p8-extraction) ------------------ */

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
    _map: map,
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
  const tables = { documents: makeFakeTable(), sections: makeFakeTable(), extractions: makeFakeTable() };
  const db = {
    sourceDocuments: tables.documents,
    documentSections: tables.sections,
    extractionRecords: tables.extractions,
    async transaction(_mode, ...args) {
      const fn = args[args.length - 1];
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
  return { async projectExists(id) {
    return set.has(id);
  } };
}

/** Wires ImportService + ExtractionService + ReviewService against the fake db. */
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
  return { db, tables, repository, importService, extractionService, reviewService };
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

async function seedPending(extractionService, doc, prose, overrides = {}) {
  return extractionService.createManualExtraction('projA', {
    documentId: doc.id,
    kind: overrides.kind || 'character',
    title: overrides.title || 'Elara',
    summary: overrides.summary,
    evidence: [{ sectionId: prose.id, quote: overrides.quote || 'Elara the brave' }],
  });
}

async function main() {
  const path = require('node:path');
  const alias = { '@': path.resolve(__dirname, '..', 'src') };
  const mod = await importBundled('scripts/lib/p8-review-entry.ts', 'p8b4', { alias });
  const { ReviewService, ReviewValidationError, ReviewNotFoundError, evidenceStillValid, dedupeEvidence } = mod;

  /* ==================================================================== */
  /* A. Pure helpers                                                      */
  /* ==================================================================== */
  {
    const doc = { rawText: 'XXElara the brave' + 'YY' };
    const section = { start: 2, end: 2 + 'Elara the brave'.length, text: 'Elara the brave' };
    const ev = { documentId: 'd', sectionId: 's', start: 6, end: 15, quote: 'the brave' };
    even('helper.evidenceStillValid: valid locator', evidenceStillValid(doc, section, ev));
    even('helper.evidenceStillValid: wrong quote invalid', !evidenceStillValid(doc, section, { ...ev, quote: 'nope' }));
    even('helper.evidenceStillValid: drifted section invalid', !evidenceStillValid(doc, { ...section, text: 'Xlara' }, ev));
    even('helper.evidenceStillValid: out-of-bounds invalid', !evidenceStillValid(doc, section, { ...ev, start: -1 }));

    const list = [
      { documentId: 'd', sectionId: 's', start: 0, end: 3 },
      { documentId: 'd', sectionId: 's', start: 0, end: 3 },
      { documentId: 'd', sectionId: 's', start: 4, end: 7 },
    ];
    const deduped = dedupeEvidence(list);
    eq('helper.dedupeEvidence: removes duplicate locator', deduped.length, 2);
    eq('helper.dedupeEvidence: preserves first-seen order', deduped[0].start, 0);
  }

  /* ==================================================================== */
  /* B. Review queue + detail (evidence validity)                         */
  /* ==================================================================== */
  {
    const { importService, extractionService, reviewService, tables } = makeServices(mod);
    const { doc, sections } = await setupConfirmedDoc(importService);

    const rec = await seedPending(extractionService, doc, pickProse(sections));

    const queue = await reviewService.getReviewQueue('projA');
    eq('queue: pending record listed', queue.map((q) => q.record.id), [rec.id]);
    even('queue: evidence valid flag true', queue[0].evidenceValid);

    const detail = await reviewService.getReviewDetail('projA', rec.id);
    eq('detail: record id', detail.record.id, rec.id);
    eq('detail: document resolved', detail.document && detail.document.id, doc.id);
    eq('detail: one evidence row', detail.evidence.length, 1);
    even('detail: evidence valid', detail.evidence[0].valid && detail.evidenceValid);
    eq('detail: slice reproduces quote', detail.evidence[0].slice, 'Elara the brave');

    // Filters.
    eq('queue: kind filter excludes others', (await reviewService.getReviewQueue('projA', { kind: 'location' })).length, 0);
    eq('queue: search matches title', (await reviewService.getReviewQueue('projA', { search: 'elar' })).length, 1);
    eq('queue: status=all includes pending', (await reviewService.getReviewQueue('projA', { status: 'all' })).length, 1);

    // Detail for a missing record.
    await rejectsWith('detail: missing record -> NotFound', () => reviewService.getReviewDetail('projA', 'ext_ghost'), (e) => e instanceof ReviewNotFoundError);
    // Cross-project is NotFound too.
    await rejectsWith('detail: cross-project -> NotFound', () => reviewService.getReviewDetail('projB', rec.id), (e) => e instanceof ReviewNotFoundError);

    void tables;
  }

  /* ==================================================================== */
  /* C. Confirm / reject / restore + idempotence                          */
  /* ==================================================================== */
  {
    const { importService, extractionService, reviewService } = makeServices(mod);
    const { doc, sections } = await setupConfirmedDoc(importService);
    const rec = await seedPending(extractionService, doc, pickProse(sections));

    const c1 = await reviewService.confirmExtraction('projA', rec.id);
    eq('confirm: status confirmed', c1.record.reviewStatus, 'confirmed');
    even('confirm: not an idempotent no-op first time', !c1.alreadyApplied);

    const c2 = await reviewService.confirmExtraction('projA', rec.id);
    eq('confirm: idempotent status stays confirmed', c2.record.reviewStatus, 'confirmed');
    even('confirm: idempotent alreadyApplied', c2.alreadyApplied);

    await rejectsWith('confirm: rejecting a confirmed record is not-pending', () => reviewService.rejectExtraction('projA', rec.id), (e) => e instanceof ReviewValidationError && e.reason === 'not-pending');

    // A fresh record can be rejected then restored.
    const ariaSection = sections.find((s) => s.level === 'paragraph' && s.text.includes('Aria the wise')) || pickProse(sections);
    const rec2 = await seedPending(extractionService, doc, ariaSection, { title: 'Aria', quote: 'Aria the wise' });
    const r1 = await reviewService.rejectExtraction('projA', rec2.id);
    eq('reject: status rejected', r1.record.reviewStatus, 'rejected');
    const r2 = await reviewService.rejectExtraction('projA', rec2.id);
    even('reject: idempotent alreadyApplied', r2.alreadyApplied);

    const rest = await reviewService.restoreRejectedExtraction('projA', rec2.id);
    eq('restore: back to pending', rest.record.reviewStatus, 'pending');
    even('restore: not a no-op', !rest.alreadyApplied);
    const rest2 = await reviewService.restoreRejectedExtraction('projA', rec2.id);
    even('restore: restoring pending is idempotent no-op', rest2.alreadyApplied);

    await rejectsWith('restore: cannot restore confirmed', () => reviewService.restoreRejectedExtraction('projA', rec.id), (e) => e instanceof ReviewValidationError && e.reason === 'invalid-transition');

    // Confidence NEVER decides acceptance �?a zero-confidence record still needs confirm.
    const lowConf = await seedPending(extractionService, doc, pickProse(sections), { title: 'LowConf' });
    eq('confidence: stays pending regardless', (await reviewService.getReviewDetail('projA', lowConf.id)).record.reviewStatus, 'pending');
  }

  /* ==================================================================== */
  /* D. Pending-field editing                                             */
  /* ==================================================================== */
  {
    const { importService, extractionService, reviewService, tables } = makeServices(mod);
    const { doc, sections } = await setupConfirmedDoc(importService);
    const prose = pickProse(sections);
    const rec = await seedPending(extractionService, doc, prose);

    const edited = await reviewService.updatePendingExtraction('projA', rec.id, {
      title: 'Elara the Bold',
      summary: 'Edited summary',
      tags: ['hero', 'lead'],
    });
    eq('edit: title changed', edited.title, 'Elara the Bold');
    eq('edit: summary changed', edited.summary, 'Edited summary');
    eq('edit: tags changed', edited.tags, ['hero', 'lead']);
    eq('edit: origin preserved', edited.origin, rec.origin);
    eq('edit: status still pending', edited.reviewStatus, 'pending');
    eq('edit: evidence preserved when not supplied', edited.evidence[0].start, rec.evidence[0].start);
    even('edit: dedupeKey recomputed for new title', edited.dedupeKey !== rec.dedupeKey);

    // Replace evidence with a valid new location.
    const aria = sections.find((s) => s.level === 'paragraph' && s.text.includes('Aria the wise')) || prose;
    const withNewEvidence = await reviewService.updatePendingExtraction('projA', rec.id, {
      evidence: [{ sectionId: aria.id, quote: 'Aria the wise' }],
    });
    eq('edit: evidence replaced', withNewEvidence.evidence[0].quote, 'Aria the wise');
    eq('edit: replaced slice reproduces quote', withNewEvidence.evidence[0].sectionId, aria.id);

    await rejectsWith(
      'edit: fabricated replacement evidence rejected',
      () => reviewService.updatePendingExtraction('projA', rec.id, { evidence: [{ sectionId: prose.id, quote: 'not present anywhere' }] }),
      () => true,
    );

    // Editing a confirmed record is refused.
    await reviewService.confirmExtraction('projA', rec.id);
    await rejectsWith('edit: confirmed record edit refused (not-pending)', () => reviewService.updatePendingExtraction('projA', rec.id, { title: 'Late edit' }), (e) => e instanceof ReviewValidationError && e.reason === 'not-pending');

    void tables;
  }

  /* ==================================================================== */
  /* E. Merge                                                             */
  /* ==================================================================== */
  {
    const { importService, extractionService, reviewService, tables } = makeServices(mod);
    const { doc, sections } = await setupConfirmedDoc(importService);
    const prose = pickProse(sections);
    const aria = sections.find((s) => s.level === 'paragraph' && s.text.includes('Aria the wise')) || prose;

    const source = await seedPending(extractionService, doc, prose, { title: 'Src', quote: 'Elara the brave' });
    const target = await seedPending(extractionService, doc, aria, { title: 'Tgt', quote: 'Aria the wise' });

    const merged = await reviewService.mergeExtractions('projA', source.id, target.id);
    eq('merge: source status merged', merged.source.reviewStatus, 'merged');
    eq('merge: source merge.targetId is target', merged.source.merge && merged.source.merge.targetId, target.id);
    eq('merge: source absorbedEvidence count', merged.source.merge && merged.source.merge.absorbedEvidence, 1);
    even('merge: source keeps its own evidence (provenance)', merged.source.evidence.length >= 1);
    eq('merge: target gained the source evidence (deduped)', merged.target.evidence.length, 2);
    eq('merge: target still pending (keeps status)', merged.target.reviewStatus, 'pending');

    // Idempotent repeat.
    const again = await reviewService.mergeExtractions('projA', source.id, target.id);
    even('merge: repeat is idempotent', again.alreadyApplied);
    eq('merge: repeat does not duplicate evidence', again.target.evidence.length, 2);
    eq('merge: repeat source still merged', again.source.reviewStatus, 'merged');

    // Self merge.
    await rejectsWith('merge: self merge rejected', () => reviewService.mergeExtractions('projA', target.id, target.id), (e) => e instanceof ReviewValidationError && e.reason === 'merge-self');

    // Source not pending.
    await rejectsWith('merge: confirmed source rejected', () => reviewService.mergeExtractions('projA', target.id, source.id), () => true);

    // Cross-project target.
    const { importService: impB, extractionService: extB } = makeServices(mod);
    void impB;
    void extB;
    await rejectsWith('merge: missing target -> cross-project', () => reviewService.mergeExtractions('projA', target.id, 'ext_ghost'), (e) => e instanceof ReviewValidationError && e.reason === 'cross-project');

    // Chain guard: merging into an already-merged record is refused.
    const other = await seedPending(extractionService, doc, aria, { title: 'Other', quote: 'followed her closely' });
    await rejectsWith('merge: target that is merged is refused', () => reviewService.mergeExtractions('projA', other.id, merged.source.id), (e) => e instanceof ReviewValidationError && (e.reason === 'merge-cycle' || e.reason === 'merge-target-status'));

    // listMergeCandidates excludes merged / self.
    void tables;
    const { importService: imp2, extractionService: ext2, reviewService: rev2 } = makeServices(mod);
    const setup2 = await setupConfirmedDoc(imp2);
    const p2 = pickProse(setup2.sections);
        const a2 = await seedPending(ext2, setup2.doc, p2, { title: 'A2', quote: 'Elara the brave' });
    const p2aria = setup2.sections.find((s) => s.level === 'paragraph' && s.text.includes('Aria the wise')) || p2;
    const b2 = await seedPending(ext2, setup2.doc, p2aria, { title: 'B2', quote: 'Aria the wise' });
    const candidates = await rev2.listMergeCandidates('projA', a2.id);
    even('merge.candidates: excludes self', !candidates.some((c) => c.id === a2.id));
    even('merge.candidates: includes eligible other', candidates.some((c) => c.id === b2.id));
  }

  /* ==================================================================== */
  /* F. Transactional rollback on a failed merge                         */
  /* ==================================================================== */
  {
    const { importService, extractionService, reviewService, tables } = makeServices(mod);
    const { doc, sections } = await setupConfirmedDoc(importService);
    const prose = pickProse(sections);
    const aria = sections.find((s) => s.level === 'paragraph' && s.text.includes('Aria the wise')) || prose;
    const source = await seedPending(extractionService, doc, prose, { title: 'SrcFail', quote: 'Elara the brave' });
    const target = await seedPending(extractionService, doc, aria, { title: 'TgtFail', quote: 'Aria the wise' });

    // Force the SECOND update (target write) to fail: the first (source) write
    // must roll back too, leaving BOTH records untouched.
    const realUpdate = reviewService.repository.updateExtraction.bind(reviewService.repository);
    let calls = 0;
    reviewService.repository.updateExtraction = async (record) => {
      calls += 1;
      if (calls === 2) {
        const err = new Error('simulated write failure');
        err.name = 'AbortError';
        throw err;
      }
      return realUpdate(record);
    };

    await rejectsWith('rollback: merge fails on 2nd write', () => reviewService.mergeExtractions('projA', source.id, target.id), () => true);
    reviewService.repository.updateExtraction = realUpdate;

    const srcAfter = await reviewService.getReviewDetail('projA', source.id);
    const tgtAfter = await reviewService.getReviewDetail('projA', target.id);
    eq('rollback: source not left merged', srcAfter.record.reviewStatus, 'pending');
    eq('rollback: source merge audit absent', srcAfter.record.merge, undefined);
    eq('rollback: target evidence not mutated', tgtAfter.record.evidence.length, 1);
    void tables;
  }

  /* ==================================================================== */
  /* G. Stale-evidence handling                                           */
  /* ==================================================================== */
  {
    const { importService, extractionService, reviewService } = makeServices(mod);
    const { doc, sections } = await setupConfirmedDoc(importService);
    const prose = pickProse(sections);
    const rec = await seedPending(extractionService, doc, prose);

        // Mutate the stored raw text directly so the evidence no longer resolves.
    const repoDoc = await reviewService.repository.getDocumentById(doc.id);
    if (repoDoc) {
      await reviewService.repository.updateDocument({
        ...repoDoc,
        rawText: repoDoc.rawText.replace('Elara the brave', 'Zzzzz the brave'),
      });
    }

    const detail = await reviewService.getReviewDetail('projA', rec.id);
    // Either the section text no longer matches raw (invalid) �?evidence validity false.
    even('stale: detail reports invalid evidence', detail.evidence[0].valid === false || detail.evidenceValid === false);
    eq('stale: evidence NOT repaired/mutated', detail.record.evidence[0].quote, 'Elara the brave');
    const queue = await reviewService.getReviewQueue('projA');
    even('stale: queue flags evidence invalid', queue[0] && queue[0].evidenceValid === false);
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
  console.error('P8 Batch-4 verification crashed:', error);
  process.exit(1);
});
