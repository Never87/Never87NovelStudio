/**
 * P8 Batch-4 â€?REAL Dexie/IndexedDB integration for ReviewService.
 *
 * Unlike `p8-review-verify.cjs` (pure Node, in-memory fake tables) this drives
 * the ACTUAL `ReviewService` against the REAL Dexie database and the browser's
 * REAL IndexedDB, over the same headless-Chrome/CDP infrastructure the P2â€“P8 UI
 * scripts use. It verifies the review-lifecycle and merge guarantees the audit
 * demands at the DATABASE level, not with a fake:
 *
 *   1. Confirm / reject transitions persist to IndexedDB (and are idempotent).
 *   2. A pending-field EDIT persists and preserves evidence/provenance.
 *   3. Restore (rejected â†?pending) persists and preserves evidence.
 *   4. Merge folds source evidence into the target atomically; source becomes
 *      merged with a complete `merge` audit trail; target evidence is deduped.
 *   5. A duplicate merge request is an idempotent no-op (no double-append).
 *   6. Concurrent review operations on the SAME record converge to one state.
 *   7. A merge transaction that fails on the SECOND write rolls back BOTH rows.
 *   8. Project isolation: a record of project B is unreachable from project A.
 *   9. Evidence preservation across confirm/merge; stale evidence is reported
 *      invalid (never silently repaired); merge never writes a project entity.
 *
 * Usage: npm run verify:review:idb   (needs dev server on :5177)
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_URL = 'http://localhost:5177/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9372;

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
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
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

const DB_NAME = `p8b4-idb-${Date.now()}`;

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}.`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p8b4-idb-chrome-'));
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

  // Load the real app so modules + Dexie registration are live.
  await cdp.send('Page.navigate', { url: APP_URL });
  await sleep(2500);

  // All the work happens inside one page evaluation so DB handles are explicit.
  const out = await cdp.eval(`(async () => {
    const DB_NAME = ${JSON.stringify(DB_NAME)};
    const dbMod = await import('/src/db/index.ts');
    const { NovelStudioDb } = dbMod;
    const Dexie = Object.getPrototypeOf(NovelStudioDb);
    const { ImportService } = await import('/src/services/import-service.ts');
    const { ExtractionService } = await import('/src/services/extraction-service.ts');
    const { ReviewService } = await import('/src/services/review-service.ts');
    const { ImportRepository } = await import('/src/repositories/import-repository.ts');

    // A real Dexie database, created from scratch for this run (v11 schema).
    const db = new NovelStudioDb(DB_NAME);
    await db.open();

    const projectSet = new Set(['projA', 'projB']);
    const projectService = { async projectExists(id) { return projectSet.has(id); } };

    const mkImport = () => {
      const repo = new ImportRepository(db);
      return new ImportService({ repository: repo, projectService, db });
    };
    const mkReview = (repoOverride) => {
      const baseRepo = new ImportRepository(db);
      const repo = repoOverride ? repoOverride(baseRepo) : baseRepo;
      const importService = new ImportService({ repository: repo, projectService, db });
      const extractionService = new ExtractionService({ repository: repo, importService, generate: async () => { throw new Error('no AI in review idb test'); } });
      return new ReviewService({ repository: repo, importService, extractionService });
    };

    const report = {};
    const tsBase = 1_700_000_000_000;

    await db.table('projects').bulkPut([
      { id: 'projA', title: 'Alpha', description: '', status: 'drafting', genre: [], tags: [], settings: {}, createdAt: tsBase, updatedAt: tsBase },
      { id: 'projB', title: 'Beta', description: '', status: 'planning', genre: [], tags: [], settings: {}, createdAt: tsBase, updatedAt: tsBase },
    ]);

    const prose = 'Elara the brave walked into the forest. Aria the wise followed her.';
    const prose2 = 'Elara the brave lifted the sword. Aria the wise cheered loudly.';
    const sampleDoc = (label, body) => '# Volume ' + label + '\\n\\n## Chapter 1\\n\\n' + (body || prose) + '\\n';

    const confirmedDoc = async (importer, projectId, label, body) => {
      const doc = await importer.createDocument(projectId, { format: 'markdown', rawText: sampleDoc(label, body) });
      await importer.parseDocument(projectId, doc.id);
      await importer.confirmStructure(projectId, doc.id);
      const sections = await importer.getConfirmedSections(projectId, doc.id);
      const proseSection = sections.find((s) => s.level === 'paragraph') || sections[sections.length - 1];
      return { doc, proseSection, sections };
    };

    // Build a REAL pending extraction through the real ExtractionService.
    const makePending = async (extraction, importer, projectId, doc, section, quote, title) => {
      return await extraction.createManualExtraction(projectId, {
        documentId: doc.id, kind: 'character', title,
        evidence: [{ sectionId: section.id, quote }],
      });
    };

    /* ------------------------------------------------------------------ */
    /* (1) Confirm / reject persist + are idempotent                       */
    /* ------------------------------------------------------------------ */
    {
      const importer = mkImport();
      const extraction = new ExtractionService({ repository: new ImportRepository(db), importService: importer, generate: async () => { throw new Error('no ai'); } });
      const review = mkReview();
      const { doc, proseSection } = await confirmedDoc(importer, 'projA', 'confirm');

      const r1 = await makePending(extraction, importer, 'projA', doc, proseSection, 'Elara the brave', 'Confirm Elara');
      const conf = await review.confirmExtraction('projA', r1.id);
      const persistedConf = await db.table('extractionRecords').get(r1.id);
      const confAgain = await review.confirmExtraction('projA', r1.id);

      const r2 = await makePending(extraction, importer, 'projA', doc, proseSection, 'Aria the wise', 'Reject Aria');
      const rej = await review.rejectExtraction('projA', r2.id);
      const persistedRej = await db.table('extractionRecords').get(r2.id);
      const rejAgain = await review.rejectExtraction('projA', r2.id);

      // Confirmed record cannot be silently rejected.
      let rejectConfirmedReason = null;
      try { await review.rejectExtraction('projA', r1.id); }
      catch (e) { rejectConfirmedReason = e && e.reason; }

      report.confirmReject = {
        confStatus: conf.record.reviewStatus, confPersisted: persistedConf.reviewStatus, confIdempotent: confAgain.alreadyApplied === true,
        rejStatus: rej.record.reviewStatus, rejPersisted: persistedRej.reviewStatus, rejIdempotent: rejAgain.alreadyApplied === true,
        rejectConfirmedReason,
      };
    }

    /* ------------------------------------------------------------------ */
    /* (2) Pending EDIT persists + preserves evidence                      */
    /* ------------------------------------------------------------------ */
    {
      const importer = mkImport();
      const extraction = new ExtractionService({ repository: new ImportRepository(db), importService: importer, generate: async () => { throw new Error('no ai'); } });
      const review = mkReview();
      const { doc, proseSection } = await confirmedDoc(importer, 'projA', 'edit');
      const rec = await makePending(extraction, importer, 'projA', doc, proseSection, 'Elara the brave', 'Edit Me');
      const before = await db.table('extractionRecords').get(rec.id);

      const edited = await review.updatePendingExtraction('projA', rec.id, { title: 'Edited Title', summary: 'new summary' });
      const persisted = await db.table('extractionRecords').get(rec.id);

      // Editing a confirmed record is refused.
      await review.confirmExtraction('projA', rec.id);
      let editConfirmedReason = null;
      try { await review.updatePendingExtraction('projA', rec.id, { title: 'Nope' }); }
      catch (e) { editConfirmedReason = e && e.reason; }

      report.edit = {
        newTitle: persisted.title, newSummary: persisted.summary,
        evidencePreserved: JSON.stringify(before.evidence) === JSON.stringify(persisted.evidence),
        originPreserved: persisted.origin === before.origin,
        statusPreserved: persisted.reviewStatus === 'pending' /* was pending at edit time */,
        editConfirmedReason,
      };
    }

    /* ------------------------------------------------------------------ */
    /* (3) Restore rejected â†?pending persists, preserves evidence         */
    /* ------------------------------------------------------------------ */
    {
      const importer = mkImport();
      const extraction = new ExtractionService({ repository: new ImportRepository(db), importService: importer, generate: async () => { throw new Error('no ai'); } });
      const review = mkReview();
      const { doc, proseSection } = await confirmedDoc(importer, 'projA', 'restore');
      const rec = await makePending(extraction, importer, 'projA', doc, proseSection, 'Elara the brave', 'Restore Me');
      const origEvidence = JSON.stringify(rec.evidence);
      await review.rejectExtraction('projA', rec.id);
      const restored = await review.restoreRejectedExtraction('projA', rec.id);
      const persisted = await db.table('extractionRecords').get(rec.id);
      const restoreAgain = await review.restoreRejectedExtraction('projA', rec.id);

      report.restore = {
        status: persisted.reviewStatus,
        evidencePreserved: JSON.stringify(persisted.evidence) === origEvidence,
        idempotent: restoreAgain.alreadyApplied === true,
      };
    }

    /* ------------------------------------------------------------------ */
    /* (4) Merge folds evidence atomically + audit trail                   */
    /* ------------------------------------------------------------------ */
    {
      const importer = mkImport();
      const extraction = new ExtractionService({ repository: new ImportRepository(db), importService: importer, generate: async () => { throw new Error('no ai'); } });
      const review = mkReview();
      const { doc, proseSection } = await confirmedDoc(importer, 'projA', 'merge');
      const target = await makePending(extraction, importer, 'projA', doc, proseSection, 'Elara the brave', 'Merge Target');
      const source = await makePending(extraction, importer, 'projA', doc, proseSection, 'Aria the wise', 'Merge Source');

      const targetEvidenceBefore = target.evidence.length;
      const sourceEvidence = JSON.stringify(source.evidence);
      const res = await review.mergeExtractions('projA', source.id, target.id);

      const persistedSource = await db.table('extractionRecords').get(source.id);
      const persistedTarget = await db.table('extractionRecords').get(target.id);

      report.merge = {
        sourceStatus: persistedSource.reviewStatus,
        sourceMergePresent: Boolean(persistedSource.merge),
        mergeTargetId: persistedSource.merge && persistedSource.merge.targetId,
        mergeTargetMatches: persistedSource.merge && persistedSource.merge.targetId === target.id,
        sourceEvidencePreserved: JSON.stringify(persistedSource.evidence) === sourceEvidence,
        targetStatusUnchanged: persistedTarget.reviewStatus === 'pending',
        targetEvidenceGrew: persistedTarget.evidence.length > targetEvidenceBefore,
        alreadyApplied: res.alreadyApplied,
      };

      // Duplicate merge request â†?idempotent no-op (no double-append).
      const targetEvidenceAfterFirst = persistedTarget.evidence.length;
      const dup = await review.mergeExtractions('projA', source.id, target.id);
      const persistedTarget2 = await db.table('extractionRecords').get(target.id);
      report.dupMerge = {
        alreadyApplied: dup.alreadyApplied === true,
        evidenceNotDoubled: persistedTarget2.evidence.length === targetEvidenceAfterFirst,
      };
    }

    /* ------------------------------------------------------------------ */
    /* (5) Self-merge & ineligible target rejected                         */
    /* ------------------------------------------------------------------ */
    {
      const importer = mkImport();
      const extraction = new ExtractionService({ repository: new ImportRepository(db), importService: importer, generate: async () => { throw new Error('no ai'); } });
      const review = mkReview();
      const { doc, proseSection } = await confirmedDoc(importer, 'projA', 'mergeguards');
      const a = await makePending(extraction, importer, 'projA', doc, proseSection, 'Elara the brave', 'Guard A');
      const b = await makePending(extraction, importer, 'projA', doc, proseSection, 'Aria the wise', 'Guard B');

      let selfReason = null;
      try { await review.mergeExtractions('projA', a.id, a.id); } catch (e) { selfReason = e && e.reason; }

      // Reject the target â†?merge target ineligible.
      await review.rejectExtraction('projA', b.id);
      let targetReason = null;
      try { await review.mergeExtractions('projA', a.id, b.id); } catch (e) { targetReason = e && e.reason; }

      // Source that is no longer pending cannot merge.
      await review.confirmExtraction('projA', a.id);
      const c = await makePending(extraction, importer, 'projA', doc, proseSection, 'walked into', 'Guard C').catch(() => null);
      let sourceReason = null;
      if (c) {
        try { await review.mergeExtractions('projA', a.id, c.id); } catch (e) { sourceReason = e && e.reason; }
      }

      report.mergeGuards = { selfReason, targetReason, sourceReason };
    }

    /* ------------------------------------------------------------------ */
    /* (6) Concurrent review operations on the SAME record                 */
    /* ------------------------------------------------------------------ */
    {
      const importer = mkImport();
      const extraction = new ExtractionService({ repository: new ImportRepository(db), importService: importer, generate: async () => { throw new Error('no ai'); } });
      const review = mkReview();
      const { doc, proseSection } = await confirmedDoc(importer, 'projA', 'concurrent');
      const rec = await makePending(extraction, importer, 'projA', doc, proseSection, 'Elara the brave', 'Race Me');

      // Fire confirm and reject concurrently â€?exactly ONE terminal state must win,
      // and the persisted row must match a consistent winner.
      const settled = await Promise.allSettled([
        review.confirmExtraction('projA', rec.id),
        review.rejectExtraction('projA', rec.id),
      ]);
      const persisted = await db.table('extractionRecords').get(rec.id);
      const okCount = settled.filter((s) => s.status === 'fulfilled' && s.value.alreadyApplied === false).length;
      report.concurrent = {
        fulfilled: settled.filter((s) => s.status === 'fulfilled').length,
        rejected: settled.filter((s) => s.status === 'rejected').length,
        winnerCount: okCount,
        finalStatus: persisted.reviewStatus,
        finalIsTerminal: persisted.reviewStatus === 'confirmed' || persisted.reviewStatus === 'rejected',
      };
    }

    /* ------------------------------------------------------------------ */
    /* (7) Merge transaction fails on 2nd write â†?BOTH rows roll back      */
    /* ------------------------------------------------------------------ */
    {
      const importer = mkImport();
      const baseRepo = new ImportRepository(db);
      const extraction = new ExtractionService({ repository: baseRepo, importService: importer, generate: async () => { throw new Error('no ai'); } });
      const { doc, proseSection } = await confirmedDoc(importer, 'projA', 'rollback');
      const target = await makePending(extraction, importer, 'projA', doc, proseSection, 'Elara the brave', 'RB Target');
      const source = await makePending(extraction, importer, 'projA', doc, proseSection, 'Aria the wise', 'RB Source');
      const srcBefore = await db.table('extractionRecords').get(source.id);
      const tgtBefore = await db.table('extractionRecords').get(target.id);

      // A repository whose SECOND updateExtraction call throws, so the two-row
      // merge must abort the whole transaction and roll BOTH rows back.
      let updateCalls = 0;
      const failingRepo = new Proxy(new ImportRepository(db), {
        get(t, p) {
          if (p === 'updateExtraction') {
            return async (row) => {
              updateCalls += 1;
              if (updateCalls === 2) throw new Error('injected failure on 2nd merge write');
              return t.updateExtraction(row);
            };
          }
          const v = t[p];
          return typeof v === 'function' ? v.bind(t) : v;
        },
      });
      const failingImport = new ImportService({ repository: failingRepo, projectService, db });
      const failingExtraction = new ExtractionService({ repository: failingRepo, importService: failingImport, generate: async () => { throw new Error('no ai'); } });
      const failingReview = new ReviewService({ repository: failingRepo, importService: failingImport, extractionService: failingExtraction });

      let threw = false;
      try { await failingReview.mergeExtractions('projA', source.id, target.id); } catch (e) { threw = true; }

      const srcAfter = await db.table('extractionRecords').get(source.id);
      const tgtAfter = await db.table('extractionRecords').get(target.id);
      report.mergeRollback = {
        threw,
        sourceUnchanged: JSON.stringify(srcAfter) === JSON.stringify(srcBefore),
        targetUnchanged: JSON.stringify(tgtAfter) === JSON.stringify(tgtBefore),
        sourceStillPending: srcAfter.reviewStatus === 'pending',
        targetHasNoMergeIncursion: tgtAfter.evidence.length === tgtBefore.evidence.length,
      };
    }

    /* ------------------------------------------------------------------ */
    /* (8) Project isolation                                              */
    /* ------------------------------------------------------------------ */
    {
      const importerA = mkImport();
      const extractionA = new ExtractionService({ repository: new ImportRepository(db), importService: importerA, generate: async () => { throw new Error('no ai'); } });
      const reviewA = mkReview();
      const { doc: docA, proseSection: proseA } = await confirmedDoc(importerA, 'projA', 'isoA');
      const recA = await makePending(extractionA, importerA, 'projA', docA, proseA, 'Elara the brave', 'ProjA Record');

      // Project B tries to reach a project A record.
      let detailFromB = null, confirmFromB = null;
      try { await reviewA.getReviewDetail('projB', recA.id); }
      catch (e) { detailFromB = e && e.name; }
      try { await reviewA.confirmExtraction('projB', recA.id); }
      catch (e) { confirmFromB = e && e.name; }
      const persistedStatus = (await db.table('extractionRecords').get(recA.id)).reviewStatus;
      const queueB = await reviewA.getReviewQueue('projB');

      // Merge across projects: target from projB referenced from projA â†?cross-project.
      const importerB = mkImport();
      const extractionB = new ExtractionService({ repository: new ImportRepository(db), importService: importerB, generate: async () => { throw new Error('no ai'); } });
      const { doc: docB, proseSection: proseB } = await confirmedDoc(importerB, 'projB', 'isoB');
      const recB = await makePending(extractionB, importerB, 'projB', docB, proseB, 'Elara the brave', 'ProjB Record');
      let crossMergeReason = null;
      try { await reviewA.mergeExtractions('projA', recA.id, recB.id); }
      catch (e) { crossMergeReason = e && e.reason; }

      report.isolation = {
        detailFromB, confirmFromB,
        statusUnchanged: persistedStatus === 'pending',
        queueBHasA: queueB.some((q) => q.record.id === recA.id),
        crossMergeReason,
      };
    }

    /* ------------------------------------------------------------------ */
    /* (9) Evidence integrity: stale reported invalid, no repair; no       */
    /*     project-entity writes on merge                                  */
    /* ------------------------------------------------------------------ */
    {
      const importer = mkImport();
      const extraction = new ExtractionService({ repository: new ImportRepository(db), importService: importer, generate: async () => { throw new Error('no ai'); } });
      const review = mkReview();
      const { doc, proseSection } = await confirmedDoc(importer, 'projA', 'evidence', prose);
      const rec = await makePending(extraction, importer, 'projA', doc, proseSection, 'Elara the brave', 'Evidence Rec');

      // Valid evidence first.
      const goodDetail = await review.getReviewDetail('projA', rec.id);

      // Mutate the stored COPY of the cited section out-of-band (same length) so
      // evidence no longer resolves; the DETAIL view must REPORT it invalid,
      // never repair it. We do NOT touch the document rawText: that would break
      // the rawText<->section invariant every writer re-checks.
      const sectionRow = await db.table('documentSections').get(proseSection.id);
      await db.table('documentSections').put({
        ...sectionRow,
        text: sectionRow.text.replace('Elara the brave', 'Zzzzz the brave'),
      });
      const staleDetail = await review.getReviewDetail('projA', rec.id);
      const storedEvidenceAfter = await db.table('extractionRecords').get(rec.id);
      const evidenceUnchanged = JSON.stringify(storedEvidenceAfter.evidence) === JSON.stringify(rec.evidence);

      // Restore the faithful section for the independent merge assertion below.
      await db.table('documentSections').put(sectionRow);

      // Snapshot every project entity table before a merge to prove no writes.
      const entityTables = ['worlds', 'characters', 'narrativePlans', 'volumes', 'chapters', 'scenes', 'knowledgeEntries', 'continuityFacts', 'analysisFindings'];
      const beforeCounts = {};
      for (const t of entityTables) beforeCounts[t] = await db.table(t).count();

      // Merge two FRESH records in a fresh document so the check is independent of
      // the stale-evidence scenario above.
      const { doc: mergeDoc, proseSection: mergeSection } = await confirmedDoc(importer, 'projA', 'evidence-merge', prose);
      const t2 = await makePending(extraction, importer, 'projA', mergeDoc, mergeSection, 'Aria the wise', 'NoEntity Target');
      const s2 = await makePending(extraction, importer, 'projA', mergeDoc, mergeSection, 'walked into', 'NoEntity Source');
      const merged = await review.mergeExtractions('projA', s2.id, t2.id);
      const afterCounts = {};
      for (const t of entityTables) afterCounts[t] = await db.table(t).count();
      const noEntityWrites = entityTables.every((t) => beforeCounts[t] === afterCounts[t]);

      report.evidence = {
        goodValid: goodDetail.evidenceValid,
        staleValid: staleDetail.evidenceValid,
        staleReportedInvalid: staleDetail.evidence.length > 0 && staleDetail.evidence.every((e) => e.valid === false),
        storedEvidenceUnchanged: evidenceUnchanged,
        mergeOk: merged.source.reviewStatus === 'merged',
        noEntityWrites,
      };
    }

    // Final assertion that NO formal project entity was ever written by review.
    db.close();
    await Dexie.delete(DB_NAME);
    return report;
  })()`);

  /* ------------------------------ Assertions ------------------------------ */
  const cr = out?.confirmReject ?? {};
  record('confirm: status persisted as "confirmed"', cr.confPersisted === 'confirmed', cr.confPersisted);
  record('confirm: repeat is idempotent (alreadyApplied)', cr.confIdempotent === true, String(cr.confIdempotent));
  record('reject: status persisted as "rejected"', cr.rejPersisted === 'rejected', cr.rejPersisted);
  record('reject: repeat is idempotent (alreadyApplied)', cr.rejIdempotent === true, String(cr.rejIdempotent));
  record('confirmed record cannot be rejected (not-pending)', cr.rejectConfirmedReason === 'not-pending', cr.rejectConfirmedReason);

  const ed = out?.edit ?? {};
  record('edit: title persisted', ed.newTitle === 'Edited Title', ed.newTitle);
  record('edit: summary persisted', ed.newSummary === 'new summary', ed.newSummary);
  record('edit: evidence preserved (not discarded)', ed.evidencePreserved === true, String(ed.evidencePreserved));
  record('edit: origin preserved', ed.originPreserved === true, String(ed.originPreserved));
  record('edit: confirmed record cannot be edited (not-pending)', ed.editConfirmedReason === 'not-pending', ed.editConfirmedReason);

  const rs = out?.restore ?? {};
  record('restore: rejected â†?pending persisted', rs.status === 'pending', rs.status);
  record('restore: evidence preserved', rs.evidencePreserved === true, String(rs.evidencePreserved));
  record('restore: repeat is idempotent', rs.idempotent === true, String(rs.idempotent));

  const mg = out?.merge ?? {};
  record('merge: source status persisted as "merged"', mg.sourceStatus === 'merged', mg.sourceStatus);
  record('merge: source carries a merge audit trail', mg.sourceMergePresent === true, String(mg.sourceMergePresent));
  record('merge: audit targetId equals the supplied target', mg.mergeTargetMatches === true, mg.mergeTargetId);
  record('merge: source keeps its OWN evidence (provenance)', mg.sourceEvidencePreserved === true, String(mg.sourceEvidencePreserved));
  record('merge: target status unchanged (one-way)', mg.targetStatusUnchanged === true, String(mg.targetStatusUnchanged));
  record('merge: target evidence grew (source evidence folded in)', mg.targetEvidenceGrew === true, String(mg.targetEvidenceGrew));

  const dm = out?.dupMerge ?? {};
  record('dup-merge: duplicate request is idempotent', dm.alreadyApplied === true, String(dm.alreadyApplied));
  record('dup-merge: evidence NOT doubled on repeat', dm.evidenceNotDoubled === true, String(dm.evidenceNotDoubled));

  const mgg = out?.mergeGuards ?? {};
  record('merge-guard: self-merge rejected (merge-self)', mgg.selfReason === 'merge-self', mgg.selfReason);
  record('merge-guard: rejected target ineligible (merge-target-status)', mgg.targetReason === 'merge-target-status', mgg.targetReason);
  record('merge-guard: non-pending source rejected (not-pending)', mgg.sourceReason === 'not-pending', mgg.sourceReason);

  const co = out?.concurrent ?? {};
  record('concurrent: exactly one terminal transition wins', co.winnerCount === 1, String(co.winnerCount));
  record('concurrent: final state is terminal (confirmed|rejected)', co.finalIsTerminal === true, co.finalStatus);

  const mrb = out?.mergeRollback ?? {};
  record('merge-rollback: 2nd-write failure surfaced as rejection', mrb.threw === true, String(mrb.threw));
  record('merge-rollback: source row rolled back byte-identical', mrb.sourceUnchanged === true, String(mrb.sourceUnchanged));
  record('merge-rollback: target row rolled back byte-identical', mrb.targetUnchanged === true, String(mrb.targetUnchanged));
  record('merge-rollback: source remains pending', mrb.sourceStillPending === true, String(mrb.sourceStillPending));
  record('merge-rollback: target received no evidence incursion', mrb.targetHasNoMergeIncursion === true, String(mrb.targetHasNoMergeIncursion));

  const iso = out?.isolation ?? {};
  record('isolation: cross-project detail is not-found', iso.detailFromB === 'ReviewNotFoundError', iso.detailFromB);
  record('isolation: cross-project confirm is not-found', iso.confirmFromB === 'ReviewNotFoundError', iso.confirmFromB);
  record('isolation: foreign record status unchanged', iso.statusUnchanged === true, String(iso.statusUnchanged));
  record('isolation: projB queue excludes projA record', iso.queueBHasA === false, String(iso.queueBHasA));
  record('isolation: cross-project merge rejected (cross-project)', iso.crossMergeReason === 'cross-project', iso.crossMergeReason);

  const ev = out?.evidence ?? {};
  record('evidence: valid record reported valid', ev.goodValid === true, String(ev.goodValid));
  record('evidence: stale record reported INVALID (not repaired)', ev.staleValid === false && ev.staleReportedInvalid === true, JSON.stringify({ valid: ev.staleValid, allInvalid: ev.staleReportedInvalid }));
  record('evidence: stored evidence UNchanged by detail (no repair)', ev.storedEvidenceUnchanged === true, String(ev.storedEvidenceUnchanged));
  record('scope: merge still works after stale check', ev.mergeOk === true, String(ev.mergeOk));
  record('scope: merge wrote NO formal project entity', ev.noEntityWrites === true, String(ev.noEntityWrites));

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
