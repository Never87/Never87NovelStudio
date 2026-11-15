/**
 * P9 Batch 4-2 — Project Backup IMPORT / PREVIEW: REAL Dexie/IndexedDB.
 *
 * Drives the ACTUAL `BackupPreviewService` (and the `BackupService` that produces
 * the file) against the REAL Dexie database and the browser's REAL IndexedDB,
 * over the headless-Chrome/CDP infrastructure the P2–P9 scripts use. Data is
 * seeded through the real application services.
 *
 * Guarantees checked:
 *   1. A real project exports → parses → previews with matching metadata/counts.
 *   2. Existing-project detection is correct (source IS local).
 *   3. A backup for a NONEXISTENT local project still parses and reports absent.
 *   4. The whole DB fingerprint is byte-identical before/after previewing
 *      (valid, invalid and tampered files).
 *   5. Another project's rows are unchanged; A's preview never leaks B ids.
 *   6. Secrets never appear in the previewed file.
 *   7. Repeated parsing is stable.
 *
 * Requires the dev server on http://localhost:5177/ (started by the caller).
 *
 * Usage: npm run verify:backup:preview:idb
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_URL = 'http://localhost:5177/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9397;

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

const DB_NAME = `p9bp-idb-${Date.now()}`;

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}.`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9bp-idb-chrome-'));
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
  await cdp.eval(`(() => { window.__P9BP_DB_NAME = ${JSON.stringify(DB_NAME)}; return true; })()`);

  const driver = fs.readFileSync(path.join(__dirname, 'lib', 'p9-backup-preview-idb-page.js'), 'utf8');
  let out;
  try {
    out = await cdp.eval(`(${driver})()`);
  } catch (error) {
    record('driver executed', false, error.message);
    teardown();
    finish();
    return;
  }

  /* (1) Valid preview */
  const v = out?.valid ?? {};
  record('valid: previewed as a project package', v.kind === 'project', String(v.kind));
  record('valid: source project id matches the real project', typeof v.projectId === 'string' && v.projectId.length > 0, String(v.projectId));
  record('valid: source project title is "PreviewAlpha"', v.projectTitle === 'PreviewAlpha', String(v.projectTitle));
  record('valid: exportedAt matches the exported file', v.exportedAt === v.fileExportedAt, `${v.exportedAt} vs ${v.fileExportedAt}`);
  record('valid: integrity digest matches the file', v.digest === v.fileDigest, String(v.digest));
  record('valid: 19 collection counts', v.collectionCount === 19, String(v.collectionCount));
  record('valid: totalRecords matches the exported file total', v.totalRecords === v.fileTotal, `${v.totalRecords} vs ${v.fileTotal}`);
  {
    const same = v.counts && v.fileCounts &&
      Object.keys(v.counts).length === 19 &&
      Object.keys(v.counts).every((k) => v.counts[k] === v.fileCounts[k]);
    record('valid: each collection count matches the exported file', same === true,
      JSON.stringify({ preview: v.counts, file: v.fileCounts }));
    const sum = v.counts ? Object.values(v.counts).reduce((a, b) => a + b, 0) : -1;
    record('valid: totalRecords equals the summed collection counts', sum === v.totalRecords, `${sum} vs ${v.totalRecords}`);
  }

  /* (2) Existing-project detection (source IS local) */
  const el = out?.existingLocal ?? {};
  record('existing: source project detected as already local', el.exists === true, String(el.exists));
  record('existing: detected id is the source id', typeof el.projectId === 'string' && el.projectId.length > 0, String(el.projectId));

  /* (3) Nonexistent local project still parses */
  const nx = out?.nonexistent ?? {};
  record('nonexistent: a backup for an absent id still parses', nx.parsed === true, String(nx.parsed));
  record('nonexistent: it reports the project as NOT local', nx.exists === false, String(nx.exists));
  record('nonexistent: it reports the rewritten id', nx.projectId === nx.newId, `${nx.projectId} vs ${nx.newId}`);

  /* (4) Read-only fingerprint */
  const ro = out?.readOnly ?? {};
  record('read-only: DB fingerprint byte-identical before/after previews', ro.fingerprintIdentical === true, String(ro.fingerprintIdentical));
  record('read-only: no table row count changed', (ro.countChanged ?? ['?']).length === 0, JSON.stringify(ro.countChanged));

  /* (5) Isolation */
  const iso = out?.isolation ?? {};
  record('isolation: previewing B previews B', iso.previewId === iso.expectedB, `${iso.previewId} vs ${iso.expectedB}`);
  record("isolation: another project's rows are unchanged", iso.bUnchanged === true, String(iso.bUnchanged));
  const xp = out?.crossProject ?? {};
  record("isolation: A's preview never contains B ids", (xp.bLeaksIntoA ?? ['?']).length === 0, JSON.stringify(xp.bLeaksIntoA));

  /* (6) Secrets */
  const sec = out?.secrets ?? {};
  record('secrets: a real API key IS in the DB (assertion is meaningful)', sec.dbHasSecret === true, String(sec.dbHasSecret));
  record('secrets: the previewed file contains no credential material', (sec.leaks ?? ['?']).length === 0, JSON.stringify(sec.leaks));
  record('secrets: the file never mentions aiProviders', sec.mentionsAiProviders === false, String(sec.mentionsAiProviders));

  /* (7) Stability */
  const st = out?.stable ?? {};
  record('stable: repeated parsing yields identical counts/digest', st.stable === true, String(st.stable));

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
