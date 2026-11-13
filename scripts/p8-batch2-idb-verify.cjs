/**
 * P8 Batch-2 — REAL Dexie/IndexedDB integration for ImportService.
 *
 * Unlike `p8-batch2-verify.cjs` (pure Node, in-memory fake tables) this drives
 * the ACTUAL `ImportService` against the REAL Dexie database and the browser's
 * REAL IndexedDB, over the same headless-Chrome/CDP infrastructure the P2–P8 UI
 * scripts use. Every assertion calls ImportService methods — it never inspects
 * table structure directly, so it verifies the real transactional behaviour:
 *
 *   1. Parse failure MID-TRANSACTION rolls back document status, sections,
 *      parsedTextHash and parsedAt (IndexedDB abort, not a fake).
 *   2. Two concurrent parseDocument calls on one document produce no duplicate
 *      sections and a complete, coherent final state.
 *   3. ExtractionRecord reference protection: a refused re-parse leaves the
 *      original sections AND extraction records byte-identical.
 *   4. deleteDocument removes document + sections + extraction records
 *      consistently (and nothing of the neighbouring project).
 *   5. After a failed parse, a subsequent parse succeeds with no residual lock
 *      or half-completed state.
 *
 * Usage: npm run verify:import:batch2:ui   (needs dev server on :5177)
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

const DB_NAME = `p8b2-idb-${Date.now()}`;

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}.`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p8b2-idb-chrome-'));
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
    const { ImportService, ImportConflictError, ImportNotFoundError } = await import('/src/services/import-service.ts');
    const { ImportRepository } = await import('/src/repositories/import-repository.ts');
    const { hashRawText } = await import('/src/utils/text-hash.ts');

    // A real Dexie database, created from scratch for this run.
    const db = new NovelStudioDb(DB_NAME);
    await db.open();

    // A fake project service backed by a Set — the only non-real dependency
    // (project existence), exactly as ImportService's constructor allows.
    const projectSet = new Set(['projA', 'projB']);
    const projectService = { async projectExists(id) { return projectSet.has(id); } };

    const mkService = (repoOverride) => {
      const repo = new ImportRepository(db);
      return new ImportService({ repository: repoOverride ? repoOverride(repo) : repo, projectService, db });
    };

    const report = {};
    const md = (t) => t;

    // Seed two P1 projects (import only needs them to exist, but writing real
    // project rows keeps the DB realistic).
    const ts = 1_700_000_000_000;
    await db.table('projects').bulkPut([
      { id: 'projA', title: 'Alpha', description: '', status: 'drafting', genre: [], tags: [], settings: {}, createdAt: ts, updatedAt: ts },
      { id: 'projB', title: 'Beta', description: '', status: 'planning', genre: [], tags: [], settings: {}, createdAt: ts, updatedAt: ts },
    ]);

    const sampleDoc = (label) => md('# Volume '+label+'\\n\\n## Chapter 1\\n\\nFirst paragraph body.\\n\\n## Chapter 2\\n\\nSecond paragraph body.\\n');

    /* ------------------------------------------------------------------ */
    /* (1) Parse failure MID-TRANSACTION → full rollback                  */
    /* ------------------------------------------------------------------ */
    {
      const good = mkService();
      const doc = await good.createDocument('projA', { format: 'markdown', rawText: sampleDoc('Rollback') });
      // Capture pre-parse invariants.
      const before = await good.getDocument('projA', doc.id);

      // A repo wrapper that lets the transaction do its deletions + section
      // insert, then THROWS on updateDocument (the last write) — so the abort
      // must roll back the already-performed section writes and section deletes.
      const failing = mkService((repo) => new Proxy(repo, {
        get(t, p) {
          if (p === 'updateDocument') return async () => { throw new Error('injected failure on final update (mid-transaction)'); };
          const v = t[p];
          return typeof v === 'function' ? v.bind(t) : v;
        },
      }));

      let threw = false;
      try { await failing.parseDocument('projA', doc.id); } catch (e) { threw = true; }

      const after = await good.getDocument('projA', doc.id);
      const sectionsAfter = await good.getSections('projA', doc.id);
      report.rollback = {
        threw,
        statusBefore: before.status,
        statusAfter: after.status,
        parsedAtAfter: after.parsedAt ?? null,
        hashAfter: after.parsedTextHash ?? null,
        sectionCount: sectionsAfter.length,
      };
    }

    /* ------------------------------------------------------------------ */
    /* (2) Two CONCURRENT parseDocument → no duplicate sections           */
    /* ------------------------------------------------------------------ */
    {
      const svc = mkService();
      const doc = await svc.createDocument('projA', { format: 'markdown', rawText: sampleDoc('Concurrent') });
      const [r1, r2] = await Promise.all([
        svc.parseDocument('projA', doc.id),
        svc.parseDocument('projA', doc.id),
      ]);
      const stored = await svc.getSections('projA', doc.id);
      const docAfter = await svc.getDocument('projA', doc.id);
      // Invariant: stored slice == rawText slice for every section.
      const aligned = stored.every((s) => docAfter.rawText.slice(s.start, s.end) === s.text);
      // No duplicate order positions.
      const orders = stored.map((s) => s.order);
      const uniqueOrders = new Set(orders).size === orders.length;
      report.concurrent = {
        r1Len: r1.sections.length,
        r2Len: r2.sections.length,
        storedLen: stored.length,
        uniqueOrders,
        aligned,
        docStatus: docAfter.status,
        hashMatches: docAfter.parsedTextHash === hashRawText(docAfter.rawText),
      };
    }

    /* ------------------------------------------------------------------ */
    /* (3) ExtractionRecord reference protection                          */
    /* ------------------------------------------------------------------ */
    {
      const svc = mkService();
      const doc = await svc.createDocument('projA', { format: 'markdown', rawText: sampleDoc('Ref') });
      await svc.parseDocument('projA', doc.id);
      const secs = await svc.getSections('projA', doc.id);
      const sec = secs[0];
      // Insert a REAL extraction record referencing that section.
      await db.table('extractionRecords').put({
        id: 'ext_real', projectId: 'projA', documentId: doc.id, kind: 'character',
        title: 'Elara', summary: '', body: '', tags: [], origin: 'fact', confidence: null,
        evidence: [{ documentId: doc.id, sectionId: sec.id, start: 0, end: Math.min(4, sec.text.length), quote: sec.text.slice(0, Math.min(4, sec.text.length)) }],
        dedupeKey: 'doc|character|elara|'+sec.id, reviewStatus: 'pending', relatedIds: [], integration: { status: 'not-applied' },
        createdAt: ts, updatedAt: ts,
      });
      const sectionsBefore = JSON.stringify(await svc.getSections('projA', doc.id));
      const extractionsBefore = JSON.stringify(await db.table('extractionRecords').toArray());

      // Change rawText out-of-band (simulating external write), then try re-parse.
      const row = await db.table('sourceDocuments').get(doc.id);
      await db.table('sourceDocuments').put({ ...row, rawText: sampleDoc('Ref-CHANGED'), characterCount: sampleDoc('Ref-CHANGED').length });

      let refused = false;
      let reason = null;
      try { await svc.reparseDocument('projA', doc.id, { force: true }); }
      catch (e) { refused = true; reason = e && (e.reason || (e instanceof ImportConflictError ? 'conflict' : e.name)); }

      const sectionsAfter = JSON.stringify(await svc.getSections('projA', doc.id));
      const extractionsAfter = JSON.stringify(await db.table('extractionRecords').toArray());
      report.refProtection = {
        refused, reason,
        sectionsUnchanged: sectionsBefore === sectionsAfter,
        extractionsUnchanged: extractionsBefore === extractionsAfter,
      };
    }

    /* ------------------------------------------------------------------ */
    /* (4) deleteDocument → consistent removal                            */
    /* ------------------------------------------------------------------ */
    {
      const svc = mkService();
      const docA = await svc.createDocument('projA', { format: 'markdown', rawText: sampleDoc('DelA') });
      await svc.parseDocument('projA', docA.id);
      const sec = (await svc.getSections('projA', docA.id))[0];
      await db.table('extractionRecords').put({
        id: 'ext_del', projectId: 'projA', documentId: docA.id, kind: 'character',
        title: 'T', summary: '', body: '', tags: [], origin: 'fact', confidence: null,
        evidence: [{ documentId: docA.id, sectionId: sec.id, start: 0, end: Math.min(2, sec.text.length) }],
        dedupeKey: 'del|character|t|'+sec.id, reviewStatus: 'pending', relatedIds: [], integration: { status: 'not-applied' },
        createdAt: ts, updatedAt: ts,
      });
      // Neighbour project doc that must survive.
      const docB = await svc.createDocument('projB', { format: 'markdown', rawText: sampleDoc('DelB') });
      await svc.parseDocument('projB', docB.id);

      await svc.deleteDocument('projA', docA.id);

      report.delete = {
        docRemoved: (await svc.getDocument('projA', docA.id)) === null,
        sectionsRemoved: (await db.table('documentSections').where('projectId').equals('projA').and((s) => s.documentId === docA.id).count()) === 0,
        extractionsRemoved: (await db.table('extractionRecords').where('projectId').equals('projA').and((e) => e.documentId === docA.id).count()) === 0,
        otherDocIntact: (await svc.getDocument('projB', docB.id)) !== null,
        otherSectionsIntact: (await svc.getSections('projB', docB.id)).length > 0,
      };
    }

    /* ------------------------------------------------------------------ */
    /* (5) After a failure, re-parse SUCCEEDS (no residual lock/state)    */
    /* ------------------------------------------------------------------ */
    {
      const good = mkService();
      const doc = await good.createDocument('projA', { format: 'markdown', rawText: sampleDoc('Retry') });
      // First: a failing parse (throw on updateDocument).
      const failing = mkService((repo) => new Proxy(repo, {
        get(t, p) {
          if (p === 'updateDocument') return async () => { throw new Error('injected failure (retry test)'); };
          const v = t[p]; return typeof v === 'function' ? v.bind(t) : v;
        },
      }));
      let firstFailed = false;
      try { await failing.parseDocument('projA', doc.id); } catch { firstFailed = true; }

      // Then: a normal service must be able to parse it cleanly.
      let secondOk = false;
      let secondLen = 0;
      try {
        const r = await good.parseDocument('projA', doc.id);
        secondOk = r.parsed === true;
        secondLen = r.sections.length;
      } catch (e) { secondOk = false; }
      const after = await good.getDocument('projA', doc.id);
      const stored = await good.getSections('projA', doc.id);
      const aligned = stored.every((s) => after.rawText.slice(s.start, s.end) === s.text);
      report.retry = {
        firstFailed,
        secondOk,
        secondLen,
        status: after.status,
        storedLen: stored.length,
        aligned,
        hashMatches: after.parsedTextHash === hashRawText(after.rawText),
      };
    }

    db.close();
    await Dexie.delete(DB_NAME);
    return report;
  })()`);

  /* ------------------------------ Assertions ------------------------------ */
  const rb = out?.rollback ?? {};
  record('rollback: parse failure surfaced as rejection', rb.threw === true, String(rb.threw));
  record('rollback: document status stays "imported"', rb.statusAfter === 'imported', rb.statusAfter);
  record('rollback: zero sections persisted', rb.sectionCount === 0, String(rb.sectionCount));
  record('rollback: parsedTextHash NOT set', rb.hashAfter === null, String(rb.hashAfter));
  record('rollback: parsedAt NOT set', rb.parsedAtAfter === null, String(rb.parsedAtAfter));

  const cc = out?.concurrent ?? {};
  record('concurrent: no duplicate sections (stored == one set)', cc.storedLen === cc.r1Len && cc.storedLen === cc.r2Len, JSON.stringify({ stored: cc.storedLen, r1: cc.r1Len, r2: cc.r2Len }));
  record('concurrent: each section order is unique', cc.uniqueOrders === true, String(cc.uniqueOrders));
  record('concurrent: every section aligned to rawText', cc.aligned === true, String(cc.aligned));
  record('concurrent: document finalised as "parsed"', cc.docStatus === 'parsed', cc.docStatus);
  record('concurrent: stored hash matches rawText', cc.hashMatches === true, String(cc.hashMatches));

  const rp = out?.refProtection ?? {};
  record('ref-protection: re-parse refused when sections are referenced', rp.refused === true, `reason=${rp.reason}`);
  record('ref-protection: sections unchanged after refusal', rp.sectionsUnchanged === true, String(rp.sectionsUnchanged));
  record('ref-protection: extraction records unchanged after refusal', rp.extractionsUnchanged === true, String(rp.extractionsUnchanged));

  const dl = out?.delete ?? {};
  record('delete: document removed', dl.docRemoved === true, String(dl.docRemoved));
  record('delete: sections removed', dl.sectionsRemoved === true, String(dl.sectionsRemoved));
  record('delete: extraction records removed', dl.extractionsRemoved === true, String(dl.extractionsRemoved));
  record('delete: neighbouring project document intact', dl.otherDocIntact === true, String(dl.otherDocIntact));
  record('delete: neighbouring project sections intact', dl.otherSectionsIntact === true, String(dl.otherSectionsIntact));

  const rt = out?.retry ?? {};
  record('retry: first parse failed', rt.firstFailed === true, String(rt.firstFailed));
  record('retry: subsequent parse succeeds (no residual lock)', rt.secondOk === true, `parsed=${rt.secondOk}`);
  record('retry: document finalised as "parsed" after retry', rt.status === 'parsed', rt.status);
  record('retry: coherent section set after retry', rt.storedLen === rt.secondLen && rt.secondLen > 0 && rt.aligned === true, JSON.stringify({ stored: rt.storedLen, reported: rt.secondLen, aligned: rt.aligned }));
  record('retry: hash matches rawText after retry', rt.hashMatches === true, String(rt.hashMatches));

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
