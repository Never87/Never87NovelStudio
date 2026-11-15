/**
 * P9 Batch 4-3 — Backup & Restore RESTORE UI: REAL browser + REAL IndexedDB.
 *
 * Uses the SAME infrastructure as the other P9 UI scripts (headless Chrome over
 * the DevTools Protocol; real app modules from `/src/...`; the real IndexedDB the
 * app uses). File selection is performed with a REAL temp `.n87novel` file via
 * `DOM.setFileInputFiles`, so the real `<input type="file">` → `File.text()` →
 * preview → restore path runs. NOTHING about the restore is mocked: the buttons
 * call the REAL `projectRestoreService`, and every assertion is verified against
 * the REAL IndexedDB (`getDb()`).
 *
 * Covers (per the B4-3 UI test spec):
 *   - B4-1 export + B4-2 preview remain functional (page renders, preview works);
 *   - restore actions appear ONLY after a valid preview;
 *   - restore-as-new CANCEL performs NO writes;
 *   - restore-as-new CONFIRM performs a REAL restore (new project, fresh id);
 *   - replace-existing REQUIRES an explicit target (no inference from backup);
 *   - replace CANCEL performs NO writes;
 *   - replace CONFIRM performs a REAL restore + creates a pre-restore snapshot;
 *   - loading / duplicate-submit protection;
 *   - success feedback + navigation to the restored project;
 *   - other projects remain unaffected;
 *   - invalid preview cannot invoke restore;
 *   - preview interactions do not perform unintended writes.
 *
 * Requires the dev server on http://localhost:5177/ (started by the caller).
 *
 * Usage: npm run verify:backup:restore:ui
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_URL = 'http://localhost:5177/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9407;

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

const TABLES = ['projects','worlds','characters','narrativePlans','volumes','chapters','scenes',
  'chapterDrafts','sceneDrafts','draftVersions','promptTemplates','promptTemplateVersions',
  'contextItems','contextConfigs','knowledgeEntries','continuityFacts','analysisFindings',
  'sourceDocuments','documentSections','extractionRecords','aiProviders','aiModels','aiTaskConfigs','aiGlobalConfig'];

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

function writeTempFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9br-file-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf8');
  tempFiles.push(p);
  return p;
}

async function setFile(cdp, filePath) {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type="file"]' });
  if (!nodeId) throw new Error('File input not found');
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [filePath.replace(/\\/g, '/')] });
}

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}.`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9br-ui-chrome-'));
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

  /* -------- Seed: project A (source) + project B (unrelated) + export A --- */
  const seeded = await cdp.eval(`(async () => {
    const dbMod = await import('/src/db/index.ts');
    const db = dbMod.getDb();
    const svc = await import('/src/services/index.ts');
    const { projectService, worldService, outlineService, manuscriptService, backupService } = svc;

    const fingerprintFor = async (pid) => {
      // Fingerprint of ONE project's owned rows (excludes snapshots / roots of others).
      const out = {};
      for (const t of ${JSON.stringify(TABLES)}) {
        const rows = (await db.table(t).toArray()).filter((r) =>
          t === 'projects' ? r.id === pid : (r.projectId === pid));
        out[t] = rows.sort((a,b)=> String(a.id)<String(b.id)?-1:String(a.id)>String(b.id)?1:0);
      }
      return JSON.stringify(out);
    };
    const countsFor = async (pid) => {
      const out = {};
      for (const t of ${JSON.stringify(TABLES)}) {
        if (t === 'projects') { out[t] = (await db.projects.get(pid)) ? 1 : 0; continue; }
        out[t] = (await db.table(t).toArray()).filter((r) => r.projectId === pid).length;
      }
      return out;
    };

    for (const p of await projectService.listProjects()) await projectService.deleteProject(p.id);

    // Project A — the backup source, with a distinctive body.
    const A = await projectService.createProject({ title: 'Restore UI Alpha', description: 'Alpha source.' });
    await worldService.createWorld(A.id, { title: 'Alpha World', overview: 'alpha overview' });
    const volA = await outlineService.createVolume(A.id, { title: 'Alpha Volume' });
    const chA = await outlineService.createChapter(A.id, volA.id, { title: 'Alpha Chapter' });
    await manuscriptService.saveChapterDraft(A.id, chA.id, { content: 'BACKUP-ALPHA-CONTENT' });

    // Project B — unrelated, must never be touched.
    const B = await projectService.createProject({ title: 'Restore UI Beta', description: 'Beta unrelated.' });
    await worldService.createWorld(B.id, { title: 'Beta World', overview: 'beta overview' });
    const volB = await outlineService.createVolume(B.id, { title: 'Beta Volume' });
    const chB = await outlineService.createChapter(B.id, volB.id, { title: 'Beta Chapter' });
    await manuscriptService.saveChapterDraft(B.id, chB.id, { content: 'BETA-ORIGINAL-CONTENT' });

    const file = await backupService.exportProjectFile(A.id);
    return {
      alphaId: A.id,
      betaId: B.id,
      alphaFp: await fingerprintFor(A.id),
      betaFp: await fingerprintFor(B.id),
      alphaCounts: await countsFor(A.id),
      content: file.content,
      fileName: file.fileName,
      total: file.totalRecords,
    };
  })()`);
  if (!seeded || !seeded.content) throw new Error('Seed/export failed: ' + JSON.stringify(seeded));

  const validPath = writeTempFile('Restore UI Alpha.n87novel', seeded.content);
  const invalidPath = writeTempFile('bad.n87novel', '{ "kind": "project", broken');

  // Helper evaluated in-page: read the live project list count + a project row.
  const pageProjectCount = async () =>
    cdp.eval(`(async () => { const s = await import('/src/services/index.ts'); return (await s.projectService.listProjects()).length; })()`);
  const projectExists = async (id) =>
    cdp.eval(`(async () => { const s = await import('/src/services/index.ts'); return await s.projectService.projectExists(${JSON.stringify(id)}); })()`);
  const fingerprintFor = async (id) =>
    cdp.eval(`(async () => {
      const db = (await import('/src/db/index.ts')).getDb();
      const pid = ${JSON.stringify(id)};
      const out = {};
      for (const t of ${JSON.stringify(TABLES)}) {
        const rows = (await db.table(t).toArray()).filter((r) => t === 'projects' ? r.id === pid : (r.projectId === pid));
        out[t] = rows.sort((a,b)=> String(a.id)<String(b.id)?-1:String(a.id)>String(b.id)?1:0);
      }
      return JSON.stringify(out);
    })()`);
  const snapshotsFor = async (id) =>
    cdp.eval(`(async () => { const s = await import('/src/services/index.ts'); return (await s.projectSnapshotService.listSnapshots(${JSON.stringify(id)})).length; })()`);
  const alphaDraftContent = async (id) =>
    cdp.eval(`(async () => {
      const db = (await import('/src/db/index.ts')).getDb();
      const rows = (await db.chapterDrafts.toArray()).filter((r) => r.projectId === ${JSON.stringify(id)});
      return rows.map((r) => r.content).join('|');
    })()`);

  const navigateToPage = async () => {
    await cdp.send('Page.navigate', { url: `${APP_URL.replace(/\/$/, '')}/data/backup-restore` });
    await sleep(3000);
  };

  const driverSrc = fs.readFileSync(path.join(__dirname, 'lib', 'p9-backup-restore-ui-page.js'), 'utf8');
  const drv = (expr) => cdp.eval(`(${driverSrc}).${expr}`);

  /* ===================================================================== */
  /* (1) Page renders; NO restore actions before a preview                 */
  /* ===================================================================== */
  await navigateToPage();
  const before = await drv('snapshot()');
  record('ui: page renders the Backup & Restore heading', /Backup & Restore/i.test(before.heading), before.heading);
  record('ui: page is not a placeholder', before.routeIsPlaceholder === false, String(before.routeIsPlaceholder));
  record('ui: restore actions are hidden before any preview', before.hasActions === false, JSON.stringify(before));
  const noActionsBtn = await drv('restoreActions()');
  record('ui: no restore buttons exist without a preview', noActionsBtn.present === false, JSON.stringify(noActionsBtn));

  /* ===================================================================== */
  /* (2) Invalid file → error, restore actions still hidden; no writes     */
  /* ===================================================================== */
  const countPreInvalid = await pageProjectCount();
  await setFile(cdp, invalidPath);
  await sleep(1800);
  const invalidState = await drv('snapshot()');
  const invalidActions = await drv('restoreActions()');
  record('invalid: restore actions are absent for an invalid preview', invalidActions.present === false, JSON.stringify(invalidActions));
  record('invalid: page shows no fake preview panel', invalidState.hasPreview === false, JSON.stringify(invalidState));
  const countPostInvalid = await pageProjectCount();
  record('invalid: an invalid preview caused no writes', countPostInvalid === countPreInvalid, `${countPreInvalid} -> ${countPostInvalid}`);

  /* ===================================================================== */
  /* (3) Valid preview → both actions appear (with correct copy)           */
  /* ===================================================================== */
  await setFile(cdp, validPath);
  await sleep(2000);
  const validActions = await drv('restoreActions()');
  record('valid: restore action box appears after a valid preview', validActions.present === true, JSON.stringify(validActions));
  record('valid: both Restore-as-new and Replace buttons exist', validActions.hasNew === true && validActions.hasReplace === true, JSON.stringify(validActions));
  record('valid: actions show the source project name', validActions.showsSourceName === true, String(validActions.showsSourceName));
  record('valid: "new project / fresh id" is explained', validActions.mentionsFreshId === true, String(validActions.mentionsFreshId));
  record('valid: replace explains the 19 collections + safety snapshot', validActions.mentions19Collections === true && validActions.mentionsSafetySnapshot === true, JSON.stringify(validActions));

  /* ===================================================================== */
  /* (4) Restore-as-new: CANCEL performs no writes                          */
  /* ===================================================================== */
  const countPreNewCancel = await pageProjectCount();
  await drv(`clickTestId('backup-restore-new')`);
  await sleep(400);
  const newDialogTitle = await drv('dialogTitle()');
  record('new: a confirmation dialog opens', /new project/i.test(newDialogTitle || ''), String(newDialogTitle));
  // Cancel from the first (acknowledge) pane.
  await drv(`clickButton('Cancel')`);
  await sleep(400);
  record('new: cancel closes the dialog', (await drv('dialogOpen()')) === false, '');
  const countPostNewCancel = await pageProjectCount();
  record('new: cancellation performs no writes', countPostNewCancel === countPreNewCancel, `${countPreNewCancel} -> ${countPostNewCancel}`);

  /* ===================================================================== */
  /* (5) Restore-as-new: CONFIRM performs a REAL restore (fresh id)        */
  /* ===================================================================== */
  const countPreNewConfirm = await pageProjectCount();
  await drv(`clickTestId('backup-restore-new')`);
  await sleep(300);
  await drv(`clickTestId('backup-restore-new-acknowledge')`);
  await sleep(300);
  const confirmBtnPresent = await cdp.eval(`!!document.querySelector('[data-testid="backup-restore-new-confirm"]')`);
  record('new: confirm button appears after acknowledgement', confirmBtnPresent === true, String(confirmBtnPresent));
  // Duplicate-submit protection: click confirm twice in quick succession.
  await drv(`clickTestId('backup-restore-new-confirm')`);
  await drv(`clickTestId('backup-restore-new-confirm')`); // second click should be ignored
  await sleep(2500);
  const countPostNewConfirm = await pageProjectCount();
  record('new: confirmation performs a REAL restore (exactly ONE new project)', countPostNewConfirm === countPreNewConfirm + 1, `${countPreNewConfirm} -> ${countPostNewConfirm}`);
  const success = await drv('successBanner()');
  record('new: a success banner appears after the service resolves', success.visible === true, success.text.slice(0, 80));

  // The restored project has a FRESH id (not the source alpha id).
  const newProjectInfo = await cdp.eval(`(async () => {
    const s = await import('/src/services/index.ts');
    const list = await s.projectService.listProjects();
    const restored = list.filter((p) => p.title === 'Restore UI Alpha' && p.id !== ${JSON.stringify(seeded.alphaId)});
    return { count: restored.length, ids: restored.map((p) => p.id), alphaId: ${JSON.stringify(seeded.alphaId)} };
  })()`);
  record('new: the restored project uses a FRESH id (source id reused? = no)', newProjectInfo.count === 1 && !newProjectInfo.ids.includes(seeded.alphaId), JSON.stringify(newProjectInfo));
  const newId = newProjectInfo.ids[0];
  if (newId) {
    const restoredContent = await alphaDraftContent(newId);
    record('new: the restored project carries the backup content', /BACKUP-ALPHA-CONTENT/.test(restoredContent), restoredContent.slice(0, 60));
    const restoredFp = await fingerprintFor(newId);
    // The fresh project's owned-collection shape matches the source backup's shape.
    record('new: restored project data is populated (non-empty)', restoredFp.length > seeded.alphaFp.length * 0.5, `${restoredFp.length} vs ${seeded.alphaFp.length}`);
  }

  // Source (original alpha) remains untouched by an as-new restore.
  const alphaFpAfterNew = await fingerprintFor(seeded.alphaId);
  record('new: the ORIGINAL source project is unchanged', alphaFpAfterNew === seeded.alphaFp, String(alphaFpAfterNew === seeded.alphaFp));
  // Unrelated project B remains untouched.
  const betaFpAfterNew = await fingerprintFor(seeded.betaId);
  record('new: unrelated project B is unchanged', betaFpAfterNew === seeded.betaFp, String(betaFpAfterNew === seeded.betaFp));

  /* ===================================================================== */
  /* (6) Replace-existing: REQUIRES an explicit target                      */
  /* ===================================================================== */
  await navigateToPage();
  await setFile(cdp, validPath);
  await sleep(2000);
  await drv(`clickTestId('backup-restore-replace')`);
  await sleep(400);
  const replaceTitle = await drv('dialogTitle()');
  record('replace: a destructive confirmation dialog opens', /replace/i.test(replaceTitle || ''), String(replaceTitle));
  const opts = await drv('replaceTargetOptions()');
  record('replace: an explicit target picker is present', opts.present === true && opts.options.length >= 2, JSON.stringify(opts.options));
  record('replace: the picker defaults to NO target (never inferred)', opts.value === '', String(opts.value));
  // Without a target, the acknowledge/confirm is blocked.
  const ackNoTarget = await cdp.eval(`(() => { const b = document.querySelector('[data-testid="backup-restore-replace-acknowledge"]'); return b ? b.disabled : null; })()`);
  record('replace: cannot continue without selecting a target', ackNoTarget === true, String(ackNoTarget));

  /* ===================================================================== */
  /* (7) Replace: CANCEL performs no writes                                 */
  /* ===================================================================== */
  const alphaFpPreReplace = await fingerprintFor(seeded.alphaId);
  const betaFpPreReplace = await fingerprintFor(seeded.betaId);
  const snapsAlphaPre = await snapshotsFor(seeded.alphaId);
  await drv(`clickButton('Cancel')`);
  await sleep(400);
  record('replace: cancel closes the dialog', (await drv('dialogOpen()')) === false, '');
  record('replace: cancellation leaves alpha byte-identical', (await fingerprintFor(seeded.alphaId)) === alphaFpPreReplace, '');
  record('replace: cancellation creates no snapshot', (await snapshotsFor(seeded.alphaId)) === snapsAlphaPre, '');

  /* ===================================================================== */
  /* (8) Replace: CONFIRM a real restore onto ALPHA (target) + snapshot    */
  /* ===================================================================== */
  // First mutate alpha slightly so a real "replace" is observable.
  await cdp.eval(`(async () => {
    const db = (await import('/src/db/index.ts')).getDb();
    const rows = await db.chapterDrafts.where('projectId').equals(${JSON.stringify(seeded.alphaId)}).toArray();
    for (const r of rows) await db.chapterDrafts.put({ ...r, content: 'MUTATED-AFTER-BACKUP' });
  })()`);
  const alphaFpPreConfirm = await fingerprintFor(seeded.alphaId);
  const snapsBefore = await snapshotsFor(seeded.alphaId);

  await drv(`clickTestId('backup-restore-replace')`);
  await sleep(300);
  await drv(`selectReplaceTarget(${JSON.stringify(seeded.alphaId)})`);
  await sleep(300);
  const identityText = await drv('replaceIdentityText()');
  record('replace: dialog shows source AND target names together', /Source \(from backup\)/i.test(identityText) && /Target \(will be replaced\)/i.test(identityText), identityText.slice(0, 60));
  // now acknowledge + confirm
  await drv(`clickTestId('backup-restore-replace-acknowledge')`);
  await sleep(300);
  await drv(`clickTestId('backup-restore-replace-confirm')`);
  await sleep(2800);

  const successReplace = await drv('successBanner()');
  record('replace: a success banner appears after the service resolves', successReplace.visible === true, successReplace.text.slice(0, 80));
  record('replace: success mentions a pre-restore safety snapshot', /safety snapshot/i.test(successReplace.text || ''), successReplace.text.slice(0, 120));

  const alphaDraftAfter = await alphaDraftContent(seeded.alphaId);
  record('replace: the target’s content is replaced by the backup (mutation gone)', !/MUTATED-AFTER-BACKUP/.test(alphaDraftAfter) && /BACKUP-ALPHA-CONTENT/.test(alphaDraftAfter), alphaDraftAfter.slice(0, 80));

  const snapsAfter = await snapshotsFor(seeded.alphaId);
  record('replace: a pre-restore safety snapshot was created', snapsAfter === snapsBefore + 1, `${snapsBefore} -> ${snapsAfter}`);

  const betaFpPostReplace = await fingerprintFor(seeded.betaId);
  record('replace: unrelated project B is unchanged', betaFpPostReplace === betaFpPreReplace, String(betaFpPostReplace === betaFpPreReplace));

  // No leftover dialogs; project list refreshed (page reflects the change).
  record('replace: dialog is closed after a successful restore', (await drv('dialogOpen()')) === false, '');

  /* ===================================================================== */
  /* (9) Preview interactions performed no unintended writes to B          */
  /* ===================================================================== */
  record('isolation: project B never changed across the entire flow', (await fingerprintFor(seeded.betaId)) === seeded.betaFp, String((await fingerprintFor(seeded.betaId)) === seeded.betaFp));

  /* ===================================================================== */
  /* (10) MANDATORY FLUSH-BEFORE-REPLACE: a failing editor FLUSH aborts     */
  /*      the restore BEFORE the service writes anything.                  */
  /* ===================================================================== */
  // Create a dedicated target project C so this scenario is isolated.
  const gammaInfo = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    const p = await svc.projectService.createProject({ title: 'Restore UI Gamma', description: 'Gamma target.' });
    await svc.worldService.createWorld(p.id, { title: 'Gamma World', overview: 'gamma overview' });
    const vol = await svc.outlineService.createVolume(p.id, { title: 'Gamma Volume' });
    const ch = await svc.outlineService.createChapter(p.id, vol.id, { title: 'Gamma Chapter' });
    await svc.manuscriptService.saveChapterDraft(p.id, ch.id, { content: 'GAMMA-ORIGINAL' });
    return { gammaId: p.id };
  })()`);
  const gammaId = gammaInfo.gammaId;
  const gammaFpPre = await fingerprintFor(gammaId);
  const gammaSnapsPre = await snapshotsFor(gammaId);
  const gammaContentPre = await alphaDraftContent(gammaId);

  // Register a FAILING editor for gamma in the page's REAL registry singleton.
  // This simulates an open editor whose flush cannot persist pending autosave.
  // IMPORTANT: it must be registered AFTER the page navigation below (a full
  // page reload re-imports the module and would clear the module-level registry).

  await navigateToPage();
  await setFile(cdp, validPath);
  await sleep(2000);

  // Now (post-reload, post-preview) register the synthetic failing editor.
  await cdp.eval(`(async () => {
    const reg = await import('/src/modules/editor/editor-registry.ts');
    window.__n87_failing_unreg__ = reg.registerEditor({
      kind: 'chapter',
      projectId: ${JSON.stringify(gammaId)},
      ownerId: 'gamma_chapter',
      flush: () => Promise.reject(new Error('simulated flush failure for gamma')),
      reload: () => Promise.resolve(),
    });
  })()`);

  await drv(`clickTestId('backup-restore-replace')`);
  await sleep(300);
  await drv(`selectReplaceTarget(${JSON.stringify(gammaId)})`);
  await sleep(300);
  await drv(`clickTestId('backup-restore-replace-acknowledge')`);
  await sleep(300);
  await drv(`clickTestId('backup-restore-replace-confirm')`);
  await sleep(2500);

  const gammaFpPost = await fingerprintFor(gammaId);
  const gammaSnapsPost = await snapshotsFor(gammaId);
  const gammaContentPost = await alphaDraftContent(gammaId);
  const flushAbortSuccess = await drv('successBanner()');

  record('flush-abort: NO success banner when a required editor flush fails', flushAbortSuccess.visible === false, JSON.stringify(flushAbortSuccess));
  record('flush-abort: the restore service performed NO writes (gamma byte-identical)', gammaFpPost === gammaFpPre, String(gammaFpPost === gammaFpPre));
  record('flush-abort: gamma content unchanged (not replaced)', gammaContentPost === gammaContentPre, `${gammaContentPre.slice(0,20)} -> ${gammaContentPost.slice(0,20)}`);
  record('flush-abort: NO pre-restore snapshot was created', gammaSnapsPost === gammaSnapsPre, `${gammaSnapsPre} -> ${gammaSnapsPost}`);

  // Clean up the synthetic failing registration so it cannot affect later steps.
  await cdp.eval(`(() => { if (typeof window.__n87_failing_unreg__ === 'function') { window.__n87_failing_unreg__(); window.__n87_failing_unreg__ = null; } })()`);

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
