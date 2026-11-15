/**
 * P9 Batch 4-3 — Project Backup RESTORE: REAL Dexie/IndexedDB integration.
 *
 * Drives the ACTUAL `ProjectRestoreService` against the REAL Dexie database and
 * the browser's REAL IndexedDB, over the headless-Chrome/CDP infrastructure the
 * P2–P9 scripts use. Data is seeded through the real application services and
 * backed up with the REAL `BackupService`.
 *
 * Unlike the pure logic test (which uses a fake DB), this proves REAL IndexedDB
 * transaction atomicity: a mid-transaction failure rolls back EVERY write, the
 * pre-restore safety snapshot survives the rollback, and unrelated projects are
 * never touched.
 *
 * Requires the dev server on http://localhost:5177/ (started by the caller).
 *
 * Usage: npm run verify:backup:restore:idb
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_URL = 'http://localhost:5177/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9399;

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

const DB_NAME = `p9restore-idb-${Date.now()}`;

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}.`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9restore-idb-chrome-'));
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

  const driver = fs.readFileSync(path.join(__dirname, 'lib', 'p9-backup-restore-idb-page.js'), 'utf8');
  let out;
  try {
    out = await cdp.eval(`(${driver})()`);
  } catch (error) {
    record('driver executed', false, error.message);
    teardown();
    finish();
    return;
  }

  /* (1) Restore as new */
  const an = out?.asNew ?? {};
  record('as-new: mode reported as "new"', an.mode === 'new', String(an.mode));
  record('as-new: a fresh (distinct) project id is created', an.distinctId === true, String(an.distinctId));
  record('as-new: no safety snapshot for new mode', an.noSnapshot === true, String(an.noSnapshot));
  record('as-new: all 19 collections have the source counts', an.countsMatch === true, String(an.countsMatch));
  record('as-new: every restored row is owned by the new project', an.allOwnedByNew === true, String(an.allOwnedByNew));
  record('as-new: internal references point at the new project', an.chapterRefsOk === true, String(an.chapterRefsOk));
  record('as-new: source project unchanged', an.sourceUnchanged === true, String(an.sourceUnchanged));
  record('as-new: unrelated project B unchanged', an.projectBUnchanged === true, String(an.projectBUnchanged));

  /* (2) Replace existing */
  const rp = out?.replace ?? {};
  record('replace: mode reported as "replace"', rp.mode === 'replace', String(rp.mode));
  record('replace: project id equals the target id', rp.sameId === true, String(rp.sameId));
  record('replace: target createdAt preserved', rp.createdAtPreserved === true, String(rp.createdAtPreserved));
  record('replace: all 19 collections replaced to the backup counts', rp.countsMatch === true, String(rp.countsMatch));
  record('replace: chapters fully restored', rp.chaptersRestored === true, String(rp.chaptersRestored));
  record('replace: a safety snapshot is returned', rp.safetySnapshotReturned === true, String(rp.safetySnapshotReturned));
  record('replace: target snapshots survive (pre-existing + safety)', rp.snapshotsSurvived === true, String(rp.snapshotsSurvived));

  /* (3) Real rollback */
  const rb = out?.rollback ?? {};
  record('rollback: restore throws a ProjectRestoreError', rb.threw === true, String(rb.threw));
  record('rollback: failure is in the transaction phase', rb.phase === 'transaction', String(rb.phase));
  record('rollback: the injected fault actually fired', rb.fired === true, String(rb.fired));
  record('rollback: target data is byte-identical after rollback', rb.targetUnchanged === true, String(rb.targetUnchanged));
  record('rollback: the safety snapshot is kept', rb.safetySnapshotKept === true, String(rb.safetySnapshotKept));

  /* (4) Secrets */
  const sec = out?.secrets ?? {};
  record('secrets: the exported backup contains no credential', sec.sourceBackupHasNoSecret === true, String(sec.sourceBackupHasNoSecret));
  record('secrets: real AI credential still intact in the DB', sec.providerStillIntact === true, String(sec.providerStillIntact));
  record('secrets: all restored projects coexist', sec.projectsCoexist === true, String(sec.projectsCoexist));

  /* (5) Round-trip */
  const rt = out?.roundTrip ?? {};
  record('round-trip: a restored project re-exports to a valid package', rt.validates === true, String(rt.validates));

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
