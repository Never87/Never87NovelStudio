/**
 * P9 Batch 3-3 — Project Snapshots UI: REAL browser + REAL IndexedDB verify.
 *
 * Uses the SAME infrastructure as the P2–P9 UI/IDB scripts (headless Chrome over
 * the DevTools Protocol; real app modules from `/src/...`; the real IndexedDB
 * the app uses). The page is driven ENTIRELY through the rendered DOM. The
 * create / delete / restore actions go through the actual buttons and dialogs —
 * the SnapshotService is NOT mocked. Effects are verified by reading IndexedDB
 * directly. A REAL AutosaveEngine (module) is bound after restore to prove the
 * editor stays safe.
 *
 * Covers: route + sidebar; empty state; create; list; details-from-real-data;
 * delete confirm/cancel/delete; restore confirm CANCEL = no write; restore
 * CONFIRM = real service call, pre-restore safety snapshot, success notice;
 * project isolation; post-restore reload; post-restore editor safety; failure
 * path leaves the page usable.
 *
 * Requires the dev server on http://localhost:5177/ (started by the caller).
 *
 * Usage: npm run verify:snapshots:ui
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_URL = 'http://localhost:5177/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9394;

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
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
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
  sendBounded(method, params = {}, ms = 20_000) {
    let timer = null;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${method} timed out in ${ms}ms.`)), ms);
    });
    const call = this.send(method, params);
    call.catch(() => {});
    return Promise.race([call, deadline]).finally(() => clearTimeout(timer));
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
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
  try {
    activeWs?.close();
  } catch {
    /* closed */
  }
  try {
    activeChrome?.kill();
  } catch {
    /* gone */
  }
  try {
    if (activeProfileDir) fs.rmSync(activeProfileDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.on('SIGINT', () => {
  teardown();
  process.exit(130);
});
process.on('SIGTERM', () => {
  teardown();
  process.exit(143);
});

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}.`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9snap-chrome-'));
  activeProfileDir = userDataDir;
  const chrome = spawn(
    CHROME,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--window-size=1400,1000',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  activeChrome = chrome;

  let target = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch {
      /* starting */
    }
    await sleep(250);
  }
  if (!target) throw new Error('Chrome DevTools endpoint never became ready.');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  activeWs = ws;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP WebSocket never opened within 10s.')), 10_000);
    const settle = (fn) => (value) => {
      clearTimeout(timer);
      fn(value);
    };
    ws.addEventListener('open', settle(resolve), { once: true });
    ws.addEventListener('error', settle(reject), { once: true });
  });

  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.sendBounded('Page.navigate', { url: 'about:blank' }, 10_000);

  const pageErrors = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params?.exceptionDetails?.exception?.description ?? 'unknown');
    }
  });

  // Load the app once (its modules are needed to seed), seed the projects + data
  // DIRECTLY through the services, then NAVIGATE to the snapshots route so the
  // page mounts with the seeded projects already present (useProjects loads them
  // on mount). The driver then drives the real UI — it does not re-seed.
  await cdp.send('Page.navigate', { url: APP_URL });
  await sleep(3000);

  const seed = await cdp.eval(`(async () => {
    const dbMod = await import('/src/db/index.ts');
    const svc = await import('/src/services/index.ts');
    await dbMod.initDatabase();
    const { projectService, outlineService, sceneService, manuscriptService } = svc;
    for (const p of await projectService.listProjects()) await projectService.deleteProject(p.id);
    const A = await projectService.createProject({ title: 'P9 Snapshots Alpha' });
    const B = await projectService.createProject({ title: 'P9 Snapshots Beta' });
    const volA = await outlineService.createVolume(A.id, { title: 'Alpha Volume' });
    const chA = await outlineService.createChapter(A.id, volA.id, { title: 'Alpha Chapter' });
    const scA = await sceneService.createScene(A.id, chA.id, { title: 'Alpha Scene' });
    await manuscriptService.saveChapterDraft(A.id, chA.id, { content: 'Alpha ORIGINAL snapshot content.' });
    const volB = await outlineService.createVolume(B.id, { title: 'Beta Volume' });
    const chB = await outlineService.createChapter(B.id, volB.id, { title: 'Beta Chapter' });
    await manuscriptService.saveChapterDraft(B.id, chB.id, { content: 'Beta untouched content.' });
    window.__P9SEED = { projA: A.id, projB: B.id, chA: chA.id, scA: scA.id, chB: chB.id };
    return window.__P9SEED;
  })()`);
  if (!seed || !seed.projA) throw new Error('Seed failed: ' + JSON.stringify(seed));

  // Navigate to the snapshots route so the page mounts with the seeded projects.
  await cdp.send('Page.navigate', { url: `${APP_URL.replace(/\/$/, '')}/data/snapshots` });
  await sleep(3000);

  // Drive the whole scenario in-page and capture the report.
  const driver = fs.readFileSync(path.join(__dirname, 'lib', 'p9-snapshots-ui-page.js'), 'utf8');
  let report = null;
  try {
    report = await cdp.eval(`(${driver})()`);
  } catch (error) {
    record('driver executed', false, error.message);
    teardown();
    const failed = results.filter((r) => !r.ok);
    console.log('\n================ SUMMARY ================');
    console.log(`TOTAL ${results.length}  PASS ${results.length - failed.length}  FAIL ${failed.length}`);
    process.exit(1);
  }

  const r = report || {};

  if (r.crash) {
    record('driver ran without crashing', false, r.crashMessage || r.crash);
  }

  /* ROUTE & NAV */
  const route = r.route || {};
  record('route /data/snapshots renders the Project Snapshots heading', /Project Snapshots/i.test(route.heading || ''), JSON.stringify(route.heading));
  record('snapshots page is NOT a placeholder', route.isPlaceholder === false, String(route.isPlaceholder));
  record('snapshots page has a project picker', route.hasPicker === true, String(route.hasPicker));
  record('snapshots page has a Create Snapshot button', route.hasCreateButton === true, String(route.hasCreateButton));
  record('sidebar exposes + highlights the Project Snapshots link', route.hasNavLink === true && route.navActive === true, JSON.stringify({ nav: route.hasNavLink, active: route.navActive }));

  /* EMPTY */
  const empty = r.empty || {};
  record('empty state: no snapshots shows the empty prompt + create CTA', empty.showsNoSnapshots === true && empty.hasCreateCta === true, JSON.stringify(empty));

  /* CREATE */
  const create = r.create || {};
  record('create: clicking Create Snapshot stores exactly one snapshot in IndexedDB', create.beforeCount === 0 && create.afterCount === 1, JSON.stringify(create));
  record('create: the new snapshot row renders and success is shown', create.rowRendered === true && create.showsSuccess === true, JSON.stringify({ row: create.rowRendered, success: create.showsSuccess }));

  /* LIST */
  const list = r.list || {};
  record('list: row shows real reason / record count / integrity / project / id', list.showsManualReason === true && list.showsIntegrityVerified === true && list.showsRecordCount === true && list.showsShortId === true && list.mentionsProject === true, JSON.stringify(list));

  /* DETAILS-from-real-data */
  const details = r.details || {};
  record('details: dialog opens from real data', details.open === true, String(details.open));
  record('details: shows the FULL snapshot id + full-precision digest', details.hasFullId === true && details.hasShortDigest === true, JSON.stringify({ id: details.hasFullId, digest: details.hasShortDigest }));
  record('details: shows reason, schema/format versions, and project id', details.hasReason === true && details.hasSchemaFormat === true && details.hasProjectId === true, JSON.stringify(details));
  record('details: renders a 19-collection record table derived from the registry', details.collectionRows === 19, String(details.collectionRows));
  record('details: offers copy controls for id + digest', details.hasCopyControls === true, String(details.hasCopyControls));

  /* DELETE */
  const del = r.delete || {};
  record('delete: requires a confirmation dialog (states project data unaffected)', del.dialogShown === true && del.mentionsProjectUnaffected === true, JSON.stringify(del));
  record('delete: Cancel writes nothing', del.cancelLeftIntact === true, String(del.cancelLeftIntact));
  record('delete: confirming removes exactly one snapshot and leaves project data intact', del.actuallyDeleted === true && del.projectDataIntact === true, JSON.stringify(del));

  /* RESTORE CANCEL */
  const rc = r.restoreCancel || {};
  record('restore: clicking Restore demands confirmation', rc.dialogShown === true, String(rc.dialogShown));
  record('restore: CANCEL performs NO writes (counts + snapshot count unchanged)', rc.noWrite === true, String(rc.noWrite));
  const c = rc.contract || {};
  record('restore copy: says full-project restore, NOT an undo', c.fullProjectNotUndo === true, JSON.stringify(c));
  record('restore copy: warns post-snapshot data may be deleted', c.warnsDataAfter === true, JSON.stringify(c));
  record('restore copy: states a pre-restore safety snapshot is created', c.safetySnapshot === true, JSON.stringify(c));
  record('restore copy: states rollback leaves the project intact on failure', c.rollback === true, JSON.stringify(c));
  record('restore copy: states credentials are not restored', c.credentials === true, JSON.stringify(c));
  record('restore copy: shows the target snapshot id', c.showsTargetId === true, JSON.stringify(c));

  /* RESTORE CONFIRM */
  const rf = r.restoreConfirm || {};
  record('restore: two-step confirm performs a REAL service restore', rf.confirmClicked === true, String(rf.confirmClicked));
  record('restore: project data reverts to the snapshot (extra chapter removed)', rf.countsRevertedToSnapshot === true && rf.extraChapterGone === true, JSON.stringify(rf));
  record('restore: the draft content is restored to the snapshot', rf.draftRestored === true, String(rf.draftRestored));
  record('restore: a pre-restore safety snapshot was actually created', rf.preRestoreSafetySnapshotCreated === true && rf.snapshotCountGrewBySafety === true, JSON.stringify(rf));
  record('restore: success notice shown (never a false success on failure)', rf.showsSuccessNotice === true, String(rf.showsSuccessNotice));

  /* ISOLATION */
  const iso = r.isolation || {};
  record('isolation: the OTHER project is byte-for-byte unchanged', iso.betaUntouched === true, String(iso.betaUntouched));

  /* SYNC */
  const sync = r.sync || {};
  record('sync: project root reloads after restore (exists + title intact)', sync.projectStillExists === true && sync.titleIntact === true, JSON.stringify(sync));

  /* EDITOR */
  const ed = r.editor || {};
  record('editor: after restore, a real AutosaveEngine persists new edits', ed.persistsNewEdit === true, String(ed.persistsNewEdit));
  record('editor: pre-restore (mutated) text never resurrects over the restore', ed.noResurrectPreRestore === true, String(ed.noResurrectPreRestore));
  record('editor: the post-restore edit advances the revision (engine clean)', ed.revisionAdvanced === true && ed.engineNotDirty === true, JSON.stringify(ed));

  /* FAILURE */
  const fail = r.failure || {};
  record('failure: restoring a missing snapshot is rejected with a service error code', fail.threw === true && Boolean(fail.code), JSON.stringify(fail));
  record('failure: the page remains usable after a failed restore', fail.pageUsable === true, String(fail.pageUsable));

  /* CLEANUP */
  const cl = r.cleanup || {};
  record('cleanup: no orphaned projects/snapshots remain', cl.projects === 0 && cl.snapshots === 0, JSON.stringify(cl));

  record('no uncaught page exceptions', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

  teardown();

  const failed = results.filter((x) => !x.ok);
  console.log('\n================ SUMMARY ================');
  console.log(`TOTAL ${results.length}  PASS ${results.length - failed.length}  FAIL ${failed.length}`);
  if (failed.length > 0) {
    console.log('FAILED:');
    failed.forEach((f) => console.log(`  - ${f.name}: ${f.detail}`));
    process.exitCode = 1;
  }
}

main()
  .then(() => {
    teardown();
    process.exit(process.exitCode || 0);
  })
  .catch((error) => {
    console.error('HARNESS ERROR:', error);
    teardown();
    process.exit(1);
  });
