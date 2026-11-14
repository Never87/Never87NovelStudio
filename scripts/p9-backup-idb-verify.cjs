/**
 * P9 Batch 4-1 — Project Backup: REAL Dexie/IndexedDB integration.
 *
 * Drives the ACTUAL `BackupService` (and the B1 TransferService it wraps)
 * against the REAL Dexie database and the browser's REAL IndexedDB, over the
 * headless-Chrome/CDP infrastructure the P2–P9 scripts use. Data is seeded
 * through the real application services.
 *
 * Guarantees checked:
 *   1. A real project exports to a file that re-parses and re-validates.
 *   2. All 19 collections present; nothing missing.
 *   3. Export is read-only (DB byte-for-byte unchanged, volatile cols aside).
 *   4. Project A's backup contains no data from project B.
 *   5. Empty collections preserved; P8 documents/evidence preserved.
 *   6. Secrets never enter the backup; user prose retained.
 *   7. Consecutive exports are stable and legal.
 *
 * Requires the dev server on http://localhost:5177/ (started by the caller).
 *
 * Usage: npm run verify:backup:idb
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_URL = 'http://localhost:5177/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9395;

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

const DB_NAME = `p9bk-idb-${Date.now()}`;

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}.`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9bk-idb-chrome-'));
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
  await cdp.eval(`(() => { window.__P9BK_DB_NAME = ${JSON.stringify(DB_NAME)}; return true; })()`);

  const driver = fs.readFileSync(path.join(__dirname, 'lib', 'p9-backup-idb-page.js'), 'utf8');
  let out;
  try {
    out = await cdp.eval(`(${driver})()`);
  } catch (error) {
    record('driver executed', false, error.message);
    teardown();
    finish();
    return;
  }

  /* (1) Export + parse + validate */
  const ex = out?.export ?? {};
  record('export: package kind is "project" with one entry', ex.isProject === true, String(ex.isProject));
  record('export: the file re-parses via TransferService.parse', ex.parses === true, String(ex.parses));
  record('export: the file re-validates clean', ex.validates === true, String(ex.validates));
  record('export: file name ends in .n87novel', typeof ex.fileName === 'string' && ex.fileName.endsWith('.n87novel'), String(ex.fileName));
  record('export: carries all 19 collections', ex.collectionCount === 19 && ex.allPresent === true, JSON.stringify({ n: ex.collectionCount, present: ex.allPresent }));
  record('export: reports a 64-hex integrity digest', ex.digestLen === 64, String(ex.digestLen));

  /* (2) Read-only */
  const ro = out?.readOnly ?? {};
  record('read-only: exporting never modifies ANY table', ro.unchanged === true, JSON.stringify(ro.changedTables));

  /* (3) Isolation */
  const iso = out?.isolation ?? {};
  record('isolation: A and B have distinct project ids', iso.distinct === true, String(iso.distinct));
  record('isolation: A backup contains no B ids', (iso.aLeaksB ?? []).length === 0, JSON.stringify(iso.aLeaksB));
  record('isolation: B backup contains no A ids', (iso.bLeaksA ?? []).length === 0, JSON.stringify(iso.bLeaksA));
  record('isolation: every A row is owned by A', iso.aAllOwnedByA === true, String(iso.aAllOwnedByA));

  /* (4) Empty */
  const em = out?.empty ?? {};
  record('empty: a bare project still has its one world', em.worlds === 1, String(em.worlds));
  record('empty: other collections export as []', em.othersEmpty === true, String(em.othersEmpty));
  record('empty: the empty export validates clean', em.validates === true, String(em.validates));

  /* (5) P8 preservation */
  const p8 = out?.p8 ?? {};
  record('p8: exactly one source document preserved', p8.singleDocument === true, String(p8.singleDocument));
  record('p8: section offsets reproduce rawText', p8.sectionsMatchRaw === true, String(p8.sectionsMatchRaw));
  record('p8: evidence quote matches its slice', p8.evidenceQuoteMatches === true, String(p8.evidenceQuoteMatches));
  record('p8: extraction.documentId matches its document', p8.extractionDocumentMatches === true, String(p8.extractionDocumentMatches));

  /* (6) Secrets */
  const sec = out?.secrets ?? {};
  record('secrets: a real API key IS in the DB (assertion is meaningful)', sec.dbHasSecret === true, String(sec.dbHasSecret));
  record('secrets: backup contains no AI credential material', (sec.leaks ?? []).length === 0, JSON.stringify(sec.leaks));
  record('secrets: backup never mentions aiProviders', sec.mentionsAiProviders === false, String(sec.mentionsAiProviders));
  record('secrets: backup never mentions an apiKey field', sec.mentionsApiKey === false, String(sec.mentionsApiKey));
  record('secrets: user prose retained (scan is meaningful)', sec.descriptionRetained === true, String(sec.descriptionRetained));

  /* (7) Consecutive */
  const cs = out?.consecutive ?? {};
  record('consecutive: every export stays valid', cs.allValid === true, String(cs.allValid));
  record('consecutive: file name is stable across exports', cs.sameName === true, String(cs.sameName));
  record('consecutive: payload (minus export timestamp) is stable', cs.stable === true, String(cs.stable));

  record('no uncaught page exceptions', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

  teardown();
  finish();
}

function finish() {
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
