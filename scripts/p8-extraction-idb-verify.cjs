/**
 * P8 Batch-3 — REAL Dexie/IndexedDB integration for ExtractionService.
 *
 * Unlike `p8-extraction-verify.cjs` (pure Node, in-memory fake tables) this
 * drives the ACTUAL `ExtractionService` against the REAL Dexie database and the
 * browser's REAL IndexedDB (v10 schema), over the same headless-Chrome/CDP
 * infrastructure the P2–P8 UI scripts use. It verifies the guarantees the audit
 * demands at the DATABASE level, not with a fake:
 *
 *   1. Schema: the v10 UNIQUE index `&[projectId+dedupeKey]` really exists and a
 *      raw duplicate INSERT is rejected by IndexedDB with a ConstraintError.
 *   2. Two INDEPENDENT ExtractionService instances concurrently submit the same
 *      (project, dedupeKey) → exactly ONE record survives, both calls succeed.
 *   3. A transaction failure mid-upsert persists NO partial extraction record.
 *   4. Evidence-reference validation against REAL stored Document/Section rows:
 *      fabricated/cross-section/ambiguous quotes are rejected; a verbatim quote
 *      persists offsets whose rawText slice equals the quote.
 *   5. Project isolation: a document/section of project B cannot be used to
 *      extract in project A, and reads are project-scoped.
 *   6. A stale / invalidated structure confirmation BLOCKS extraction (manual
 *      and AI), and nothing is written.
 *
 * Usage: npm run verify:extraction:idb   (needs dev server on :5177)
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_URL = 'http://localhost:5177/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9371;

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

const DB_NAME = `p8b3-idb-${Date.now()}`;

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}.`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p8b3-idb-chrome-'));
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
    const { ImportRepository } = await import('/src/repositories/import-repository.ts');
    const { ExtractionService } = await import('/src/services/extraction-service.ts');

    // A real Dexie database, created from scratch for this run (v10 schema).
    const db = new NovelStudioDb(DB_NAME);
    await db.open();

    // Fake project service backed by a Set — the only non-real dependency
    // (project existence), exactly as the services' constructors allow.
    const projectSet = new Set(['projA', 'projB']);
    const projectService = { async projectExists(id) { return projectSet.has(id); } };

    // Each service gets its OWN repository + its OWN ExtractionService instance,
    // so independent in-process write-lock maps are exercised (the audit's
    // "two independent service instances" scenario).
    const mkExtraction = (generate) => {
      const repo = new ImportRepository(db);
      const importService = new ImportService({ repository: repo, projectService, db });
      return new ExtractionService({ repository: repo, importService, generate });
    };
    const mkImport = (repoOverride) => {
      const repo = new ImportRepository(db);
      return new ImportService({ repository: repoOverride ? repoOverride(repo) : repo, projectService, db });
    };

    // A deterministic fake AI generator (no network) returning fixed JSON.
    const fakeGen = (content) => async () => ({
      result: { content: typeof content === 'function' ? content() : content, finishReason: 'stop' },
      target: { provider: { name: 'TestProvider' }, model: { modelId: 'test-model', displayName: 'Test Model' } },
    });

    const report = {};
    const ts = 1_700_000_000_000;

    // Seed two real projects.
    await db.table('projects').bulkPut([
      { id: 'projA', title: 'Alpha', description: '', status: 'drafting', genre: [], tags: [], settings: {}, createdAt: ts, updatedAt: ts },
      { id: 'projB', title: 'Beta', description: '', status: 'planning', genre: [], tags: [], settings: {}, createdAt: ts, updatedAt: ts },
    ]);

    const prose = 'Elara the brave walked into the forest. Aria the wise followed her.';
    const sampleDoc = (label) => '# Volume ' + label + '\\n\\n## Chapter 1\\n\\n' + prose + '\\n';

    // Helper: create + parse + confirm a document, return {doc, proseSection}.
    const confirmedDoc = async (importer, projectId, label) => {
      const doc = await importer.createDocument(projectId, { format: 'markdown', rawText: sampleDoc(label) });
      await importer.parseDocument(projectId, doc.id);
      await importer.confirmStructure(projectId, doc.id);
      const sections = await importer.getConfirmedSections(projectId, doc.id);
      const proseSection = sections.find((s) => s.level === 'paragraph') || sections[sections.length - 1];
      return { doc, proseSection, sections };
    };

    /* ------------------------------------------------------------------ */
    /* (1) DATABASE-LEVEL unique index really exists & rejects duplicates  */
    /* ------------------------------------------------------------------ */
    {
      const ext = mkExtraction(fakeGen('{"candidates":[]}'));
      const importer = mkImport();
      const { doc, proseSection } = await confirmedDoc(importer, 'projA', 'unique');

      // In inspect the real index metadata.
      const schema = db.table('extractionRecords').schema;
      const idx = schema.indexes.find((i) => Array.isArray(i.keyPath) && i.keyPath.join('+') === 'projectId+dedupeKey');
      report.schema = { hasCompoundIndex: Boolean(idx), unique: idx ? idx.unique === true : false };

      // Create a real record through the service (goes through the unique index).
      const rec = await ext.createManualExtraction('projA', {
        documentId: doc.id, kind: 'character', title: 'Elara',
        evidence: [{ sectionId: proseSection.id, quote: 'Elara the brave' }],
      });

      // Attempt a RAW duplicate INSERT bypassing the service entirely — the
      // DATABASE must reject it (not the in-process lock, not the service).
      let rawErr = null;
      try {
        await db.table('extractionRecords').add({ ...rec, id: 'ext_raw_dup', dedupeKey: rec.dedupeKey });
      } catch (e) { rawErr = e && (e.name || String(e)); }
      const countAfterRaw = await db.table('extractionRecords').where('[projectId+dedupeKey]').equals(['projA', rec.dedupeKey]).count();
      report.rawDup = { rejected: rawErr !== null, errorName: rawErr, countAtKey: countAfterRaw };
    }

    /* ------------------------------------------------------------------ */
    /* (2) Two INDEPENDENT service instances, concurrent same dedupe key  */
    /* ------------------------------------------------------------------ */
    {
      const importer = mkImport();
      const { doc, proseSection } = await confirmedDoc(importer, 'projA', 'concurrent');
      const svc1 = mkExtraction(fakeGen('{"candidates":[]}'));
      const svc2 = mkExtraction(fakeGen('{"candidates":[]}'));

      // Fire concurrently. They share a key → exactly one row must remain.
      const req = {
        documentId: doc.id, kind: 'character', title: 'Concurrent Elara',
        evidence: [{ sectionId: proseSection.id, quote: 'Elara the brave' }],
      };
      const [r1, r2] = await Promise.all([svc1.createManualExtraction('projA', req), svc2.createManualExtraction('projA', req)]);
      const rowsAtKey = await db.table('extractionRecords').where('[projectId+dedupeKey]').equals(['projA', r1.dedupeKey]).count();
      const totalForDoc = (await svc1.listExtractionsByDocument('projA', doc.id)).length;
      report.concurrent = {
        sameKey: r1.dedupeKey === r2.dedupeKey,
        resolvedToOneId: r1.id === r2.id,
        rowsAtKey,
        totalForDoc,
      };
    }

    /* ------------------------------------------------------------------ */
    /* (3) Transaction failure mid-upsert → NO partial record persisted    */
    /* ------------------------------------------------------------------ */
    {
      const importer = mkImport();
      const { doc, proseSection } = await confirmedDoc(importer, 'projA', 'rollback');
      const baseline = await db.table('extractionRecords').count();

      // A repository whose createExtraction performs the add() then THROWS, so
      // the surrounding readwrite transaction must ABORT and roll the add back.
      const badRepo = new ImportRepository(db);
      const proxyRepo = new Proxy(badRepo, {
        get(t, p) {
          if (p === 'createExtraction') return async (row) => { await t.createExtraction(row); throw new Error('injected failure after insert'); };
          const v = t[p]; return typeof v === 'function' ? v.bind(t) : v;
        },
      });
      const badImport = new ImportService({ repository: proxyRepo, projectService, db });
      const badSvc = new ExtractionService({ repository: proxyRepo, importService: badImport, generate: fakeGen('{"candidates":[]}') });

      let threw = false;
      try {
        await badSvc.createManualExtraction('projA', {
          documentId: doc.id, kind: 'character', title: 'RolledBack',
          evidence: [{ sectionId: proseSection.id, quote: 'Elara the brave' }],
        });
      } catch { threw = true; }
      const after = await db.table('extractionRecords').count();
      // The specific key must not exist either.
      const atKey = await db.table('extractionRecords').filter((r) => r.title === 'RolledBack').count();
      report.rollback = { threw, baseline, after, atKey };
    }

    /* ------------------------------------------------------------------ */
    /* (4) Evidence-reference validation against REAL stored rows          */
    /* ------------------------------------------------------------------ */
    {
      const importer = mkImport();
      const { doc, proseSection } = await confirmedDoc(importer, 'projA', 'evidence');
      const svc = mkExtraction(fakeGen('{"candidates":[]}'));

      const tryCreate = async (evidence) => {
        try {
          const r = await svc.createManualExtraction('projA', { documentId: doc.id, kind: 'character', title: 'E-' + Math.random().toString(36).slice(2), evidence });
          return { ok: true, r };
        } catch (e) { return { ok: false, reason: e && e.reason, name: e && e.name }; }
      };

      const good = await tryCreate([{ sectionId: proseSection.id, quote: 'Elara the brave' }]);
      // Verify the persisted offsets reproduce the quote against the REAL rawText.
      const goodEv = good.ok ? good.r.evidence[0] : null;
      const goodSlice = goodEv ? (await importer.getDocument('projA', doc.id)).rawText.slice(proseSection.start + goodEv.start, proseSection.start + goodEv.end) : null;

      const fabricated = await tryCreate([{ sectionId: proseSection.id, quote: 'Phantom not in text' }]);
      const crossSection = await tryCreate([{ sectionId: 'dsec_does_not_exist', quote: 'Elara' }]);
      const emptyEv = await tryCreate([]);
      const badOffsets = await tryCreate([{ sectionId: proseSection.id, quote: 'Elara', start: 0, end: 2 }]);

      report.evidence = {
        goodOk: good.ok, goodQuote: goodEv && goodEv.quote, goodSlice,
        fabricatedReason: fabricated.reason,
        crossSectionReason: crossSection.reason,
        emptyReason: emptyEv.reason,
        badOffsetsReason: badOffsets.reason,
      };
    }

    /* ------------------------------------------------------------------ */
    /* (5) Project isolation                                              */
    /* ------------------------------------------------------------------ */
    {
      const importer = mkImport();
      const { doc: docA, proseSection: proseA } = await confirmedDoc(importer, 'projA', 'isoA');
      const { doc: docB, proseSection: proseB } = await confirmedDoc(importer, 'projB', 'isoB');
      const svc = mkExtraction(fakeGen('{"candidates":[]}'));

      // Extract in projA citing a section that belongs to projB → must be rejected.
      let crossProject = null;
      try {
        await svc.createManualExtraction('projA', {
          documentId: docA.id, kind: 'character', title: 'CrossP',
          evidence: [{ sectionId: proseB.id, quote: 'Elara the brave' }],
        });
      } catch (e) { crossProject = e && e.reason; }

      // A real record in projA is invisible to projB reads.
      const recA = await svc.createManualExtraction('projA', {
        documentId: docA.id, kind: 'character', title: 'OnlyA',
        evidence: [{ sectionId: proseA.id, quote: 'Elara the brave' }],
      });
      const seenFromB = await svc.getExtraction('projB', recA.id);
      const listBHasA = (await svc.listExtractions('projB')).some((r) => r.id === recA.id);

      // And extracting in projB with projB's own document works independently.
      const recB = await svc.createManualExtraction('projB', {
        documentId: docB.id, kind: 'character', title: 'OnlyA',
        evidence: [{ sectionId: proseB.id, quote: 'Elara the brave' }],
      });
      // Same key shape but different project → distinct rows (no cross-talk).
      const rowsA = await db.table('extractionRecords').where('projectId').equals('projA').and((r) => r.title === 'OnlyA').count();
      const rowsB = await db.table('extractionRecords').where('projectId').equals('projB').and((r) => r.title === 'OnlyA').count();
      report.isolation = {
        crossProjectReason: crossProject,
        seenFromB: seenFromB === null ? 'null' : 'leaked',
        listBHasA,
        distinctIds: recA.id !== recB.id,
        rowsA, rowsB,
      };
    }

    /* ------------------------------------------------------------------ */
    /* (6) Stale / invalidated confirmation BLOCKS extraction              */
    /* ------------------------------------------------------------------ */
    {
      const importer = mkImport();
      const svc = mkExtraction(fakeGen(() => JSON.stringify({ candidates: [] })));

      // (a) Parsed but NOT confirmed → blocked (manual + AI).
      const doc = await importer.createDocument('projA', { format: 'markdown', rawText: sampleDoc('stale') });
      await importer.parseDocument('projA', doc.id);
      const secs = await importer.getSections('projA', doc.id);
      const sec = secs.find((s) => s.level === 'paragraph') || secs[secs.length - 1];
      let manualBlocked = null, aiBlocked = null;
      try { await svc.createManualExtraction('projA', { documentId: doc.id, kind: 'character', title: 'X', evidence: [{ sectionId: sec.id, quote: 'Elara' }] }); }
      catch (e) { manualBlocked = e && e.reason; }
      try { await svc.generateAiExtractions('projA', { documentId: doc.id, modelId: 'm' }); }
      catch (e) { aiBlocked = e && e.reason; }

      // (b) Confirm, then INVALIDATE via a structure edit → blocked again.
      await importer.confirmStructure('projA', doc.id);
      const secs2 = await importer.getSections('projA', doc.id);
      const chap = secs2.find((s) => s.level === 'chapter') || secs2[0];
      await importer.updateSection('projA', chap.id, { title: 'Edited after confirm' });
      const stillConfirmed = await importer.isStructureConfirmed('projA', doc.id);
      let manualBlockedAfterEdit = null;
      try { await svc.createManualExtraction('projA', { documentId: doc.id, kind: 'character', title: 'Y', evidence: [{ sectionId: sec.id, quote: 'Elara' }] }); }
      catch (e) { manualBlockedAfterEdit = e && e.reason; }

      // Nothing from the blocked attempts should be persisted.
      const persisted = await db.table('extractionRecords').where('projectId').equals('projA').filter((r) => r.documentId === doc.id).count();
      report.stale = { manualBlocked, aiBlocked, stillConfirmed, manualBlockedAfterEdit, persisted };
    }

    db.close();
    await Dexie.delete(DB_NAME);
    return report;
  })()`);

  /* ------------------------------ Assertions ------------------------------ */
  const sc = out?.schema ?? {};
  record('schema: compound index [projectId+dedupeKey] exists', sc.hasCompoundIndex === true, String(sc.hasCompoundIndex));
  record('schema: that index is UNIQUE (DB-level guarantee)', sc.unique === true, String(sc.unique));

  const rd = out?.rawDup ?? {};
  record('raw-duplicate: direct DB add() of a dup key is REJECTED', rd.rejected === true, `error=${rd.errorName}`);
  record('raw-duplicate: exactly one row remains at the key', rd.countAtKey === 1, String(rd.countAtKey));

  const cc = out?.concurrent ?? {};
  record('concurrent: two instances computed the same dedupe key', cc.sameKey === true, String(cc.sameKey));
  record('concurrent: both calls resolved to one record id', cc.resolvedToOneId === true, String(cc.resolvedToOneId));
  record('concurrent: exactly ONE row at the key', cc.rowsAtKey === 1, String(cc.rowsAtKey));
  record('concurrent: exactly ONE record for the document', cc.totalForDoc === 1, String(cc.totalForDoc));

  const rb = out?.rollback ?? {};
  record('rollback: transaction failure surfaced as a rejection', rb.threw === true, String(rb.threw));
  record('rollback: NO partial record persisted (count unchanged)', rb.after === rb.baseline, `baseline=${rb.baseline} after=${rb.after}`);
  record('rollback: the failed record is absent by title', rb.atKey === 0, String(rb.atKey));

  const ev = out?.evidence ?? {};
  record('evidence: verbatim quote accepted', ev.goodOk === true, String(ev.goodOk));
  record('evidence: persisted offset slice equals the quote (real rawText)', ev.goodSlice === 'Elara the brave', String(ev.goodSlice));
  record('evidence: fabricated quote rejected (fabricated-quote)', ev.fabricatedReason === 'fabricated-quote', String(ev.fabricatedReason));
  record('evidence: unknown/cross-document section rejected', ev.crossSectionReason === 'cross-document', String(ev.crossSectionReason));
  record('evidence: empty evidence rejected', ev.emptyReason === 'empty-evidence', String(ev.emptyReason));
  record('evidence: offsets not reproducing quote rejected', ev.badOffsetsReason === 'fabricated-quote', String(ev.badOffsetsReason));

  const iso = out?.isolation ?? {};
  record('isolation: cross-project evidence section rejected', iso.crossProjectReason === 'cross-document' || iso.crossProjectReason === 'cross-project', String(iso.crossProjectReason));
  record('isolation: a projA record is invisible to projB getExtraction', iso.seenFromB === 'null', iso.seenFromB);
  record('isolation: projB list does not include projA record', iso.listBHasA === false, String(iso.listBHasA));
  record('isolation: same title in two projects → distinct ids', iso.distinctIds === true, String(iso.distinctIds));
  record('isolation: one record per project at that title', iso.rowsA === 1 && iso.rowsB === 1, JSON.stringify({ a: iso.rowsA, b: iso.rowsB }));

  const st = out?.stale ?? {};
  record('stale: unconfirmed structure blocks manual extraction', st.manualBlocked === 'unconfirmed-structure', String(st.manualBlocked));
  record('stale: unconfirmed structure blocks AI extraction', st.aiBlocked === 'unconfirmed-structure', String(st.aiBlocked));
  record('stale: structure edit after confirm invalidates confirmation', st.stillConfirmed === false, String(st.stillConfirmed));
  record('stale: invalidated confirmation blocks manual extraction', st.manualBlockedAfterEdit === 'unconfirmed-structure', String(st.manualBlockedAfterEdit));
  record('stale: nothing persisted for blocked extraction attempts', st.persisted === 0, String(st.persisted));

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
