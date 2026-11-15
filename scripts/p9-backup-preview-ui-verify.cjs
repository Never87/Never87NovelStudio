/**
 * P9 Batch 4-2 — Backup IMPORT / PREVIEW UI: REAL browser + REAL IndexedDB.
 *
 * Uses the SAME infrastructure as the P2–P9 UI scripts (headless Chrome over the
 * DevTools Protocol; real app modules from `/src/...`; the real IndexedDB the app
 * uses). The page is driven ENTIRELY through the rendered DOM. File selection is
 * performed with a REAL temp `.n87novel` file via `DOM.setFileInputFiles`, so the
 * real `<input type="file">` → `File.text()` → preview-service path runs.
 *
 * Covers:
 *   - route + import controls + read-only / no-restore copy;
 *   - selecting a VALID backup shows a preview with metadata + 19 counts;
 *   - selecting an INVALID file shows an error (never a fake preview);
 *   - Clear preview returns to the initial state;
 *   - the page stays usable; previewing never writes to the DB.
 *
 * Requires the dev server on http://localhost:5177/ (started by the caller).
 *
 * Usage: npm run verify:backup:preview:ui
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_URL = 'http://localhost:5177/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9401;
const DB_NAME = `p9bp-ui-${Date.now()}`;

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
let tempFiles = [];
let tornDown = false;
function teardown() {
  if (tornDown) return;
  tornDown = true;
  try { activeWs?.close(); } catch { /* closed */ }
  try { activeChrome?.kill(); } catch { /* gone */ }
  try { if (activeProfileDir) fs.rmSync(activeProfileDir, { recursive: true, force: true }); } catch { /* best effort */ }
  for (const f of tempFiles) { try { fs.rmSync(f, { force: true }); } catch { /* best effort */ } }
}
process.on('SIGINT', () => { teardown(); process.exit(130); });
process.on('SIGTERM', () => { teardown(); process.exit(143); });

const writeTemp = (name, content) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9bp-file-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf8');
  tempFiles.push(p);
  try { fs.rmdirSync(dir); } catch { /* non-empty, leave it */ }
  return p;
};

async function setFile(cdp, filePath) {
  // Resolve the hidden input's document root and nodeId, then set files.
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type="file"]' });
  if (!nodeId) throw new Error('File input not found');
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [filePath.replace(/\\/g, '/')] });
}

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}.`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9bp-ui-chrome-'));
  activeProfileDir = userDataDir;
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--window-size=1400,1000',
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
  await cdp.send('DOM.enable');

  const pageErrors = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params?.exceptionDetails?.exception?.description ?? 'unknown');
    }
  });

  await cdp.send('Page.navigate', { url: APP_URL });
  await sleep(3000);

  // Seed through the APP's OWN singleton services (so the page and the preview
  // service's existence probe read the SAME live database the app uses), then
  // produce a REAL backup file to disk via the real export service.
  const seeded = await cdp.eval(`(async () => {
    const dbMod = await import('/src/db/index.ts');
    const db = dbMod.getDb();
    const svc = await import('/src/services/index.ts');
    const { projectService, worldService, outlineService, manuscriptService, backupService } = svc;

    const TABLES = ['projects','worlds','characters','narrativePlans','volumes','chapters','scenes',
      'chapterDrafts','sceneDrafts','draftVersions','promptTemplates','promptTemplateVersions',
      'contextItems','contextConfigs','knowledgeEntries','continuityFacts','analysisFindings',
      'sourceDocuments','documentSections','extractionRecords','aiProviders','aiModels','aiTaskConfigs','aiGlobalConfig'];
    const fingerprint = async () => {
      const out = {};
      for (const t of TABLES) {
        const rows = await db.table(t).toArray();
        out[t] = rows.sort((a,b)=> String(a.id)<String(b.id)?-1:String(a.id)>String(b.id)?1:0);
      }
      return JSON.stringify(out);
    };

    for (const p of await projectService.listProjects()) await projectService.deleteProject(p.id);
    const A = await projectService.createProject({ title: 'BP UI Alpha', description: 'Alpha UI backup.' });
    await worldService.createWorld(A.id, { title: 'Alpha World', overview: 'o' });
    const vol = await outlineService.createVolume(A.id, { title: 'Alpha Volume' });
    const ch = await outlineService.createChapter(A.id, vol.id, { title: 'Alpha Chapter' });
    await manuscriptService.saveChapterDraft(A.id, ch.id, { content: 'Alpha preview content.' });

    const file = await backupService.exportProjectFile(A.id);
    const fp = await fingerprint();
    return { projectId: A.id, content: file.content, fileName: file.fileName, fingerprint: fp, total: file.totalRecords };
  })()`);
  if (!seeded || !seeded.content) throw new Error('Seed/export failed: ' + JSON.stringify(seeded));

  const validPath = writeTemp('BP UI Alpha.n87novel', seeded.content);
  const invalidPath = writeTemp('not-a-backup.n87novel', '{ "kind": "project", this is broken');
  const emptyPath = writeTemp('empty.n87novel', '   ');

  // Navigate to the backup route so the page mounts with the seeded project.
  await cdp.send('Page.navigate', { url: `${APP_URL.replace(/\/$/, '')}/data/backup-restore` });
  await sleep(3000);

  const driverSrc = fs.readFileSync(path.join(__dirname, 'lib', 'p9-backup-preview-ui-page.js'), 'utf8');
  const driver = await cdp.eval(`(${driverSrc})`);

  /* ROUTE + COPY */
  const snap = await cdp.eval(`(${driverSrc}).snapshot()`);
  record('route: page renders the Backup & Restore heading', /Backup & Restore/i.test(snap.heading), snap.heading);
  record('route: page is NOT a placeholder', snap.routeIsPlaceholder === false, String(snap.routeIsPlaceholder));
  record('route: sidebar exposes + highlights the Backup & Restore link', snap.navLink === true && snap.navActive === true, JSON.stringify({ nav: snap.navLink, active: snap.navActive }));
  record('import: a real file input is present', snap.hasFileInput === true, String(snap.hasFileInput));
  record('import: file input accepts .n87novel', /\.n87novel|application\/json/.test(snap.fileInputAccept || ''), snap.fileInputAccept);
  record('import: a Select backup file button is present', snap.hasSelectButton === true, String(snap.hasSelectButton));
  record('copy: states the preview is read-only', snap.mentionsReadOnly === true, String(snap.mentionsReadOnly));
  record('copy: states no restore is performed', snap.mentionsNoRestore === true, String(snap.mentionsNoRestore));

  /* VALID FILE → PREVIEW */
  await setFile(cdp, validPath);
  await sleep(2000);
  const v = await cdp.eval(`(${driverSrc}).importState()`);
  record('valid: a preview panel appears', v.kind === 'preview', v.kind);
  record('valid: preview says the backup is valid', v.showsValid === true, String(v.showsValid));
  record('valid: preview confirms integrity is verified', v.showsIntegrityVerified === true, String(v.showsIntegrityVerified));
  record('valid: preview shows the source project title', /BP UI Alpha/.test(v.text || ''), (v.text || '').slice(0, 60));
  record('valid: preview lists 19 collection counts', v.collectionRowCount === 19, String(v.collectionRowCount));
  record('valid: preview states no restore has been performed', v.showsNoRestore === true, String(v.showsNoRestore));
  record('valid: preview states nothing has been restored yet', v.showsNextStepNotImplemented === true, String(v.showsNextStepNotImplemented));
  record('valid: since the source project exists locally, an existing warning is shown', v.showsExistingWarning === true, JSON.stringify({ hasNewNote: v.showsNewProjectNote }));

  /* CLEAR PREVIEW */
  const cleared = await cdp.eval(`(${driverSrc}).clickButton('Clear preview')`);
  await sleep(800);
  const afterClear = await cdp.eval(`(${driverSrc}).importState()`);
  record('clear: a Clear control exists and resets to no preview', cleared === true && afterClear.kind === 'none', JSON.stringify({ cleared, state: afterClear.kind }));

  /* INVALID FILE → ERROR */
  await setFile(cdp, invalidPath);
  await sleep(1800);
  const bad = await cdp.eval(`(${driverSrc}).importState()`);
  record('invalid: an error is shown (not a fake preview)', bad.kind === 'error', bad.kind);
  record('invalid: the error message is informative', /could not be previewed|valid|json|structure/i.test(bad.text || ''), (bad.text || '').slice(0, 80));

  /* EMPTY FILE → ERROR */
  const cleared2 = await cdp.eval(`(${driverSrc}).clickButton('Clear preview')`);
  await sleep(500);
  await setFile(cdp, emptyPath);
  await sleep(1500);
  const empty = await cdp.eval(`(${driverSrc}).importState()`);
  record('empty: an empty file is rejected with an error', empty.kind === 'error', empty.kind);

  /* PAGE STILL USABLE */
  const usable = await cdp.eval(`(${driverSrc}).importUsable()`);
  record('usable: the import controls remain after errors', usable === true, String(usable));

  /* NO DB WRITES */
  const fpAfter = await cdp.eval(`(async () => {
    const dbMod = await import('/src/db/index.ts');
    const db = dbMod.getDb();
    const TABLES = ['projects','worlds','characters','narrativePlans','volumes','chapters','scenes',
      'chapterDrafts','sceneDrafts','draftVersions','promptTemplates','promptTemplateVersions',
      'contextItems','contextConfigs','knowledgeEntries','continuityFacts','analysisFindings',
      'sourceDocuments','documentSections','extractionRecords','aiProviders','aiModels','aiTaskConfigs','aiGlobalConfig'];
    const out = {};
    for (const t of TABLES) {
      const rows = await db.table(t).toArray();
      out[t] = rows.sort((a,b)=> String(a.id)<String(b.id)?-1:String(a.id)>String(b.id)?1:0);
    }
    return JSON.stringify(out);
  })()`);
  record('read-only: previewing through the UI never changes the database', fpAfter === seeded.fingerprint, String(fpAfter === seeded.fingerprint));

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
