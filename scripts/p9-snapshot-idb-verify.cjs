/**
 * P9 Batch 3-1 — Project Snapshots: REAL IndexedDB integration.
 *
 * Drives the ACTUAL app modules served by Vite against the browser's REAL
 * IndexedDB, over the same headless-Chrome/CDP infrastructure the P2–P9 scripts
 * use. The in-page logic lives in `scripts/lib/p9-snapshot-idb-page.js`; this
 * file only launches Chrome, evaluates the driver, and turns its report into
 * PASS/FAIL lines.
 *
 * Two phases (see the driver for detail):
 *   A. REAL v12 → v13 migration: a v12 database is built with the app's own v12
 *      store strings, seeded, then upgraded by opening it with the real v13
 *      `NovelStudioDb`. Pre-existing rows must survive; the new store must exist
 *      and be empty, then writable.
 *   B. SnapshotRepository + ProjectService cascade on a real, isolated database:
 *      create/get, immutability, validation-before-write, newest-first scoped
 *      listing, scoped idempotent deletes, and cascade-on-project-delete.
 *
 * Usage: npm run verify:snapshot:idb   (start the dev server on :5177 first,
 * e.g. `npm run dev -- --port 5177 --strictPort`)
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_URL = 'http://localhost:5177/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9398;

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
      let detail = '';
      try {
        const ref = d.exception?.objectId;
        if (ref) {
          const props = await this.send('Runtime.getProperties', { objectId: ref, ownProperties: true });
          const pick = (name) => {
            const p = (props.result ?? []).find((x) => x.name === name);
            return p ? p.value : undefined;
          };
          const message = pick('message');
          if (message !== undefined) detail = '\n    msg=' + JSON.stringify(message);
        }
      } catch { /* best effort */ }
      throw new Error(`Page exception: ${d.exception?.description || d.text || JSON.stringify(d)}${detail}`);
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

const DB_NAME = `p9-snap-idb-${Date.now()}`;

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}.`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-snap-chrome-'));
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

  // Load the real app so the module graph + Dexie registration are live, then
  // point the isolated-database driver at this run's name.
  await cdp.send('Page.navigate', { url: APP_URL });
  await sleep(2500);
  await cdp.eval(`(() => { window.__P9SNAP_DB_NAME = ${JSON.stringify(DB_NAME)}; return true; })()`);

  const driver = fs.readFileSync(path.join(__dirname, 'lib', 'p9-snapshot-idb-page.js'), 'utf8');
  const out = await cdp.eval(`(${driver})()`);

  /* ------------------------ PHASE A — migration ----------------------- */
  const mig = out?.migration ?? {};
  record('migration: driver completed', mig.ok === true, mig.reason || '');
  if (mig.ok) {
    record('migration: started at schema v12', mig.versionBefore === 12, String(mig.versionBefore));
    record('migration: upgraded to schema v13', mig.versionAfter === 13, String(mig.versionAfter));
    record('migration: no projectSnapshots store existed at v12', mig.hadSnapshotsTableAtV12 === false, String(mig.hadSnapshotsTableAtV12));
    record('migration: projectSnapshots store exists after upgrade', mig.hasSnapshotsStore === true, String(mig.hasSnapshotsStore));
    record('migration: new store starts empty after upgrade', mig.snapshotsEmptyAfterUpgrade === true, String(mig.snapshotsEmptyAfterUpgrade));
    record('migration: existing project row survives byte-for-byte', mig.projectSurvived === true, String(mig.projectSurvived));
    record('migration: existing chapter row survives byte-for-byte', mig.chapterSurvived === true, String(mig.chapterSurvived));
    record('migration: project row is intact (not mutated by upgrade)', mig.projectIntact === true, String(mig.projectIntact));
    record('migration: the new store is writable after upgrade', mig.snapshotWritableAfterUpgrade === true, String(mig.snapshotWritableAfterUpgrade));
  }

  /* --------------------- PHASE B — repository ------------------------- */
  const cg = out?.createGet ?? {};
  record('repo: create then getById round-trips the whole record', cg.roundTripOk === true, String(cg.roundTripOk));
  record('repo: getById returns null for a missing id', cg.missingReturnsNull === true, String(cg.missingReturnsNull));

  const im = out?.immutability ?? {};
  record('repo: add() of a duplicate id fails loudly (immutable snapshots)', im.duplicateAddThrew === true, String(im.duplicateAddThrew));
  record('repo: a failed duplicate add leaves the original untouched', im.originalUnchanged === true, String(im.originalUnchanged));

  const va = out?.validation ?? {};
  record('repo: an invalid snapshot is rejected before any write', va.invalidRejectedBeforeWrite === true, String(va.invalidRejectedBeforeWrite));
  record('repo: the rejected snapshot is never stored', va.invalidNotStored === true, String(va.invalidNotStored));

  const ls = out?.list ?? {};
  record('repo: listByProject returns only the requested project', ls.aOnlyA === true && ls.bOnlyB === true, JSON.stringify({ aOnlyA: ls.aOnlyA, bOnlyB: ls.bOnlyB }));
  record('repo: listByProject is strictly project-scoped (counts)', ls.aCount === 3 && ls.bCount === 2, JSON.stringify({ aCount: ls.aCount, bCount: ls.bCount }));
  record('repo: listByProject is ordered newest-first', ls.aOrderedDesc === true, String(ls.aOrderedDesc));
  record('repo: listByProject order matches createdAt desc exactly', ls.aOrderMatches === true, JSON.stringify(ls.aIds));
  record('repo: countByProject matches the list length', ls.countA === ls.aCount, JSON.stringify({ countA: ls.countA, aCount: ls.aCount }));

  const di = out?.deleteById ?? {};
  record('repo: deleteById removes exactly the target snapshot', di.removed === true, String(di.removed));
  record('repo: deleteById is idempotent (missing id is a no-op)', di.idempotent === true, String(di.idempotent));
  record('repo: deleteById never touches project data', di.projectDataUntouched === true, String(di.projectDataUntouched));
  record('repo: deleteById never touches another project\'s snapshots', di.otherProjectSnapshotsUntouched === true, String(di.otherProjectSnapshotsUntouched));

  const dp = out?.deleteByProjectId ?? {};
  record('repo: deleteByProjectId removes only that project\'s snapshots', dp.aAfter === 0 && dp.bStillTwo === true, JSON.stringify({ aAfter: dp.aAfter, bStillTwo: dp.bStillTwo }));
  record('repo: deleteByProjectId returns the number removed', dp.removed === dp.aCountBefore, JSON.stringify({ removed: dp.removed, before: dp.aCountBefore }));
  record('repo: deleting snapshots does NOT delete the project row', dp.projectRowStillExists === true, String(dp.projectRowStillExists));

  const ca = out?.cascade ?? {};
  record('cascade: deleteProject removes the project row', ca.bProjectGone === true, String(ca.bProjectGone));
  record('cascade: deleteProject removes the project\'s snapshots', ca.bSnapsGone === true, String(ca.bSnapsGone));
  record('cascade: the project\'s snapshots are physically gone from the table', ca.bSnapsPhysical === true, String(ca.bSnapsPhysical));
  record('cascade: the project\'s other children are removed too (world)', ca.bWorldGone === true, String(ca.bWorldGone));
  record('cascade: an unrelated project is NOT deleted', ca.aProjectStillThere === true, String(ca.aProjectStillThere));
  record('cascade: an unrelated project\'s world is intact', ca.aWorldStillThere === true, String(ca.aWorldStillThere));
  record('cascade: an unrelated project\'s snapshots are intact', ca.aSnapsUnchanged === true, JSON.stringify({ before: ca.aSnapsBefore, after: ca.aSnapsAfter }));

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
