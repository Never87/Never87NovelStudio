/**
 * P9 Batch-2 — REAL browser + REAL Dexie/IndexedDB verification.
 *
 * Two halves, one run, on the SAME infrastructure the P2–P9 UI/IDB scripts use
 * (headless Chrome over the DevTools Protocol; real app modules from `/src/...`;
 * the real IndexedDB the app uses). No separate framework is introduced.
 *
 *   PART 1 — Version History & Diff Viewer UI (driven by clicks/selects only)
 *     * route loads, project + manuscript selection work
 *     * the live "Current draft" is distinct from immutable versions
 *     * version metadata + ordering are correct
 *     * switching project/manuscript does not leak data
 *     * empty history is handled
 *     * restore confirmation cancels without modifying data
 *
 *   PART 1b — Diff Viewer UI
 *     * current vs historical, historical vs historical
 *     * additions/deletions render; identical handled; empty handled
 *     * incompatible targets rejected; project switch drops stale data
 *     * a large (~8k word) document diffs without breaking the page
 *
 *   PART 2 — Restore / autosave RACE (real AutosaveEngine + real IDB)
 *     Loaded from `scripts/lib/p9-b2-race-page.js`; replays the hook's exact
 *     coordination sequence (flush -> restore -> bind -> reload) against a
 *     delayed in-flight save, for BOTH chapter and scene.
 *
 * Requires the dev server on http://localhost:5177/ (started by the caller).
 *
 * Usage: npm run verify:b2:ui:idb
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_URL = 'http://localhost:5177/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9392;

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
  sendBounded(method, params = {}, ms = 20_000) {
    let timer = null;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${method} timed out in ${ms}ms.`)), ms); });
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
  try { activeWs?.close(); } catch { /* closed */ }
  try { activeChrome?.kill(); } catch { /* gone */ }
  try { if (activeProfileDir) fs.rmSync(activeProfileDir, { recursive: true, force: true }); } catch { /* best effort */ }
}
process.on('SIGINT', () => { teardown(); process.exit(130); });
process.on('SIGTERM', () => { teardown(); process.exit(143); });

const PAGE_HELPERS = `
window.__rv = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  async waitFor(fn, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { const v = fn(); if (v) return v; } catch (e) { /* not ready */ } await window.__rv.sleep(120); }
    return null;
  },
  setSelect(el, value) { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); },
  byAriaLabel(label) { return document.querySelector('[aria-label="' + label + '"]'); },
  anyDiffSpan() { return [...document.querySelectorAll('span')].some((s) => /bg-danger-soft|bg-success-soft/.test(s.className)); },
};
true;
`;

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}.`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9b2-chrome-'));
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
  await cdp.sendBounded('Page.navigate', { url: 'about:blank' }, 10_000);

  const pageErrors = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params?.exceptionDetails?.exception?.description ?? 'unknown');
    }
  });

  await cdp.send('Page.navigate', { url: APP_URL });
  await sleep(2500);
  await cdp.eval(PAGE_HELPERS);

  /* =================================================================== */
  /* SEED                                                                */
  /* =================================================================== */
  const seed = await cdp.eval(`(async () => {
    const dbMod = await import('/src/db/index.ts');
    const svc = await import('/src/services/index.ts');
    await dbMod.initDatabase();
    for (const p of await svc.projectService.listProjects()) await svc.projectService.deleteProject(p.id);

    const A = await svc.projectService.createProject({ title: 'P9 History Alpha' });
    const B = await svc.projectService.createProject({ title: 'P9 History Beta' });

    const volA = await svc.outlineService.createVolume(A.id, { title: 'Alpha Volume' });
    const chA = await svc.outlineService.createChapter(A.id, volA.id, { title: 'Alpha Chapter' });
    const scA = await svc.sceneService.createScene(A.id, chA.id, { title: 'Alpha Scene' });

    await svc.manuscriptService.saveChapterDraft(A.id, chA.id, { content: 'Alpha v1 text.' });
    const chV1 = await svc.manuscriptService.createManualVersion('chapter', chA.id, 'first draft');
    await svc.manuscriptService.saveChapterDraft(A.id, chA.id, { content: 'Alpha v2 text with more words here.' }, {});
    const chV2 = await svc.manuscriptService.createManualVersion('chapter', chA.id, 'second draft');
    const live = await svc.manuscriptService.getDraft('chapter', chA.id);
    await svc.manuscriptService.saveChapterDraft(A.id, chA.id, { content: 'Alpha LIVE current text.', expectedRevision: live.revision });
    const liveDraft = await svc.manuscriptService.getDraft('chapter', chA.id);

    await svc.manuscriptService.saveSceneDraft(A.id, scA.id, { content: 'Scene v1 text.' });
    const scV1 = await svc.manuscriptService.createManualVersion('scene', scA.id, 'scene first');
    const sceneDraft = await svc.manuscriptService.getDraft('scene', scA.id);

    const volB = await svc.outlineService.createVolume(B.id, { title: 'Beta Volume' });
    const chB = await svc.outlineService.createChapter(B.id, volB.id, { title: 'Beta Chapter' });
    await svc.manuscriptService.saveChapterDraft(B.id, chB.id, { content: 'Beta has content but no versions.' });

    return {
      projA: A.id, projB: B.id,
      chA: chA.id, scA: scA.id, chB: chB.id,
      draftA: liveDraft.id, draftScene: sceneDraft.id,
      chV1: chV1.id, chV2: chV2.id, scV1: scV1.id,
      liveRevision: liveDraft.revision,
    };
  })()`);
  if (!seed || !seed.projA) throw new Error('Seed failed: ' + JSON.stringify(seed));

  const go = async (route) => {
    await cdp.sendBounded('Page.navigate', { url: `${APP_URL.replace(/\/$/, '')}${route}` }, 20_000);
    await sleep(400);
    await cdp.eval(PAGE_HELPERS);
  };

  /* =================================================================== */
  /* PART 1 — VERSION HISTORY UI                                          */
  /* =================================================================== */
  await go('/data/version-history');

  const routeView = await cdp.eval(`(async () => {
    const h1 = await window.__rv.waitFor(() => {
      const el = document.querySelector('h1');
      return el && /Version History/i.test(el.textContent || '') ? el : null;
    });
    const body = document.body.innerText;
    const navLink = [...document.querySelectorAll('a')].find((a) => (a.getAttribute('href') || '').includes('/data/version-history'));
    return {
      heading: h1 ? (h1.textContent || '').trim() : null,
      isPlaceholder: /under construction|ModulePlaceholder/i.test(body),
      hasPicker: Boolean(document.querySelector('#vh-project-picker')),
      hasNavLink: Boolean(navLink),
      navActive: navLink ? (navLink.getAttribute('aria-current') === 'page' || /\\bactive\\b/.test(navLink.className)) : false,
    };
  })()`);
  record('route /data/version-history renders the Version History heading', /Version History/i.test(routeView?.heading || ''), JSON.stringify(routeView));
  record('version history is NOT a placeholder page', routeView?.isPlaceholder === false, String(routeView?.isPlaceholder));
  record('version history has a project picker', routeView?.hasPicker === true, String(routeView?.hasPicker));
  record('sidebar exposes + activates the Version History link', routeView?.hasNavLink === true && routeView?.navActive === true, JSON.stringify({ nav: routeView?.hasNavLink, active: routeView?.navActive }));

  await cdp.eval(`(async () => {
    const picker = await window.__rv.waitFor(() => document.querySelector('#vh-project-picker'));
    window.__rv.setSelect(picker, ${JSON.stringify(seed.projA)});
    return true;
  })()`);

  const listView = await cdp.eval(`(async () => {
    const list = await window.__rv.waitFor(() => {
      const sel = document.querySelector('#vh-manuscript');
      return sel && sel.options.length >= 2 ? sel : null;
    });
    if (!list) return { ok: false };
    return { ok: true, options: [...list.options].map((o) => o.textContent.trim()) };
  })()`);
  record('selecting project A lists its manuscripts (chapter + scene)', listView?.ok === true && listView.options.some((o) => /Alpha Chapter/.test(o)) && listView.options.some((o) => /Alpha Scene/.test(o)), JSON.stringify(listView));

  const selectManuscript = async (labelRe) => {
    const val = await cdp.eval(`(async () => {
      const sel = await window.__rv.waitFor(() => document.querySelector('#vh-manuscript'));
      const opt = [...sel.options].find((o) => new RegExp(${JSON.stringify(labelRe)}).test(o.textContent || ''));
      if (!opt) return null;
      window.__rv.setSelect(sel, opt.value);
      return opt.value;
    })()`);
    await sleep(500);
    return val;
  };

  const chapterOption = await selectManuscript('Alpha Chapter');
  record('manuscript selection: choosing a chapter loads its history', Boolean(chapterOption), String(chapterOption));

  const currentCard = await cdp.eval(`(async () => {
    await window.__rv.waitFor(() => /Current draft/i.test(document.body.innerText) ? true : null);
    const body = document.body.innerText;
    return {
      hasCurrent: /Current draft/i.test(body),
      showsLiveText: body.includes('Alpha LIVE current text.'),
      hasR1: /r1\\b/.test(body),
      hasR2: /r2\\b/.test(body),
    };
  })()`);
  record('current draft (live) is shown distinctly from historical versions', currentCard?.hasCurrent === true && currentCard?.showsLiveText === true, JSON.stringify(currentCard));

  const versionMeta = await cdp.eval(`(() => {
    const body = document.body.innerText;
    return {
      hasManualBadge: /manual/i.test(body),
      hasFirstDraftLabel: body.includes('first draft'),
      hasSecondDraftLabel: body.includes('second draft'),
      hasWordCount: /\\d+ words/.test(body),
    };
  })()`);
  record('version metadata: reason badge + label + word count render', versionMeta?.hasManualBadge === true && versionMeta?.hasFirstDraftLabel === true && versionMeta?.hasSecondDraftLabel === true && versionMeta?.hasWordCount === true, JSON.stringify(versionMeta));

  const ordering = await cdp.eval(`(() => {
    const body = document.body.innerText;
    const i2 = body.indexOf('r2');
    const i1 = body.indexOf('r1 ');
    return { i1, i2, newestFirst: i2 !== -1 && i1 !== -1 && i2 < i1 };
  })()`);
  record('version ordering: newest revision (r2) listed before older (r1)', ordering?.newestFirst === true, JSON.stringify(ordering));

  const cancelRestore = await cdp.eval(`(async () => {
    const db = (await import('/src/db/index.ts')).db;
    const before = await db.draftVersions.where('draftId').equals(${JSON.stringify(seed.draftA)}).count();
    const liveBefore = (await db.chapterDrafts.get(${JSON.stringify(seed.draftA)})).content;
    const restoreBtns = [...document.querySelectorAll('button')].filter((b) => (b.textContent || '').trim().toLowerCase() === 'restore');
    if (restoreBtns.length === 0) return { ok: false, reason: 'no restore button' };
    restoreBtns[0].click();
    const dialog = await window.__rv.waitFor(() => document.querySelector('[role="alertdialog"][aria-label="Confirm restore"]'));
    const confirmText = dialog ? dialog.textContent : null;
    const cancel = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim().toLowerCase() === 'cancel');
    if (cancel) cancel.click();
    await window.__rv.sleep(300);
    const after = await db.draftVersions.where('draftId').equals(${JSON.stringify(seed.draftA)}).count();
    const liveAfter = (await db.chapterDrafts.get(${JSON.stringify(seed.draftA)})).content;
    return {
      ok: true,
      confirmShown: Boolean(dialog),
      confirmText,
      confirmMentionsRevision: /Restore version r\\d+/.test(confirmText || ''),
      versionCountChanged: before !== after,
      liveChanged: liveBefore !== liveAfter,
    };
  })()`);
  record('restore: clicking Restore demands confirmation (naming the revision)', cancelRestore?.confirmShown === true && cancelRestore?.confirmMentionsRevision === true, JSON.stringify(cancelRestore));
  record('restore: Cancel does NOT modify data (versions + live content unchanged)', cancelRestore?.ok === true && cancelRestore?.versionCountChanged === false && cancelRestore?.liveChanged === false, JSON.stringify(cancelRestore));

  // Focused copy check: the confirmation must communicate the ACCURATE contract
  // of `manuscriptService.restoreVersion` (replace current draft, keep existing
  // snapshots, record a restore entry) and must NOT promise that unsnapshotted
  // current text is preserved as its own version.
  record('restore confirm copy: states the current draft is REPLACED by the selected version',
    /replaces the current draft/i.test(cancelRestore?.confirmText || ''),
    JSON.stringify({ confirmText: cancelRestore?.confirmText }));
  record('restore confirm copy: states existing snapshots are KEPT',
    /existing snapshots are kept/i.test(cancelRestore?.confirmText || ''),
    JSON.stringify({ confirmText: cancelRestore?.confirmText }));
  record('restore confirm copy: states a restore entry is ADDED to the history',
    /restore entry is added/i.test(cancelRestore?.confirmText || ''),
    JSON.stringify({ confirmText: cancelRestore?.confirmText }));
  record('restore confirm copy: does NOT promise unsnapshotted current text is saved as a new version',
    !/(current text|current draft)[^.]*\\bkept as a new version\\b/i.test(cancelRestore?.confirmText || '') &&
      !/saved as a new version first/i.test(cancelRestore?.confirmText || '') &&
      !/undo/i.test(cancelRestore?.confirmText || ''),
    JSON.stringify({ confirmText: cancelRestore?.confirmText }));

  await cdp.eval(`(async () => {
    const picker = document.querySelector('#vh-project-picker');
    window.__rv.setSelect(picker, ${JSON.stringify(seed.projB)});
    return true;
  })()`);
  await sleep(500);
  await selectManuscript('Beta Chapter');
  const emptyHistory = await cdp.eval(`(async () => {
    // Project B's chapter has content but NO versions: the page renders its
    // history entry with the Current draft card and an EMPTY version list — no
    // version rows and therefore no Restore buttons.
    const ok = await window.__rv.waitFor(() => /Current draft/i.test(document.body.innerText) ? true : null);
    const body = document.body.innerText;
    const restoreBtns = [...document.querySelectorAll('button')].filter((b) => (b.textContent || '').trim().toLowerCase() === 'restore').length;
    return {
      ok: Boolean(ok),
      showsBetaCurrent: body.includes('Beta has content but no versions.'),
      noVersionRows: restoreBtns === 0,
      body: body.slice(0, 400),
    };
  })()`);
  record('empty history: a manuscript with no versions renders its Current draft and zero versions',
    emptyHistory?.ok === true && emptyHistory?.showsBetaCurrent === true && emptyHistory?.noVersionRows === true,
    JSON.stringify({ ok: emptyHistory?.ok, showsBeta: emptyHistory?.showsBetaCurrent, noRows: emptyHistory?.noVersionRows }));

  await cdp.eval(`(async () => {
    const picker = document.querySelector('#vh-project-picker');
    window.__rv.setSelect(picker, ${JSON.stringify(seed.projA)});
    return true;
  })()`);
  await sleep(500);
  await selectManuscript('Alpha Chapter');
  const backToA = await cdp.eval(`(async () => {
    await window.__rv.waitFor(() => /Alpha LIVE current text\\./.test(document.body.innerText) ? true : null);
    const body = document.body.innerText;
    return { hasA: body.includes('Alpha LIVE current text.'), leaksB: body.includes('Beta has content but no versions.') };
  })()`);
  record('project switch: switching A<->B never leaks the other project text', backToA?.hasA === true && backToA?.leaksB === false, JSON.stringify(backToA));

  /* ------------------------------------------------------------------ */
  /* PART 1c — Editor Version History DIALOG copy (the same contract).    */
  /* The editor mounts VersionHistoryDialog; its Restore confirmation must */
  /* carry the SAME corrected wording as the Version History page.        */
  /* ------------------------------------------------------------------ */
  await go(`/projects/${seed.projA}`);
  const dialogOpen = await cdp.eval(`(async () => {
    // Wait for the project detail tabs, then open Writing -> Chapter manuscripts.
    const ok = await window.__rv.waitFor(() => document.body.innerText.includes('P9 History Alpha') ? true : null);
    if (!ok) return { ok: false, reason: 'project page not ready' };
    const writing = [...document.querySelectorAll('[role="tab"]')].find((t) => (t.textContent || '').trim() === 'Writing');
    if (!writing) return { ok: false, reason: 'no Writing tab' };
    writing.click();
    await window.__rv.sleep(900);
    const chapterView = [...document.querySelectorAll('[role="tab"]')].find((t) => (t.textContent || '').trim() === 'Chapter manuscripts');
    if (chapterView && chapterView.getAttribute('aria-selected') !== 'true') { chapterView.click(); await window.__rv.sleep(600); }
    // The editor defaults to the first chapter (Alpha Chapter, which has versions).
    const versionsBtn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim().toLowerCase() === 'versions');
    if (!versionsBtn) return { ok: false, reason: 'no Versions button' };
    versionsBtn.click();
    const dlg = await window.__rv.waitFor(() => document.querySelector('[role="dialog"]') && /Version history/i.test(document.body.innerText) ? true : null);
    return { ok: Boolean(dlg) };
  })()`);
  record('editor dialog: opening "Versions" shows the Version history dialog', dialogOpen?.ok === true, JSON.stringify(dialogOpen));

  const dialogConfirm = await cdp.eval(`(async () => {
    // Click the first row "Restore" to reveal the two-step confirmation.
    const restoreBtn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim().toLowerCase() === 'restore');
    if (!restoreBtn) return { ok: false, reason: 'no Restore button in dialog' };
    restoreBtn.click();
    const confirm = await window.__rv.waitFor(() => document.querySelector('[role="alertdialog"][aria-label="Confirm restore"]'));
    const text = confirm ? confirm.textContent : null;
    // Cancel so nothing is written.
    const cancel = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim().toLowerCase() === 'cancel');
    if (cancel) cancel.click();
    return { ok: true, confirmText: text };
  })()`);
  record('editor dialog: Restore opens the inline confirmation (two-step flow preserved)', dialogConfirm?.ok === true && Boolean(dialogConfirm?.confirmText), JSON.stringify({ ok: dialogConfirm?.ok }));
  record('editor dialog copy: states the current draft is REPLACED by the selected version',
    /replaces the current draft/i.test(dialogConfirm?.confirmText || ''), JSON.stringify({ confirmText: dialogConfirm?.confirmText }));
  record('editor dialog copy: states existing snapshots are KEPT',
    /existing snapshots are kept/i.test(dialogConfirm?.confirmText || ''), JSON.stringify({ confirmText: dialogConfirm?.confirmText }));
  record('editor dialog copy: states a restore entry is ADDED to the history',
    /restore entry is added/i.test(dialogConfirm?.confirmText || ''), JSON.stringify({ confirmText: dialogConfirm?.confirmText }));
  record('editor dialog copy: does NOT promise unsnapshotted current text is saved as a new version',
    !/saved as a new version first/i.test(dialogConfirm?.confirmText || '') &&
      !/undo/i.test(dialogConfirm?.confirmText || '') &&
      !/\bkept as a new version\b/i.test(dialogConfirm?.confirmText || ''),
    JSON.stringify({ confirmText: dialogConfirm?.confirmText }));

  /* =================================================================== */
  /* PART 1b — DIFF VIEWER UI                                             */
  /* =================================================================== */
  await go('/data/diff-viewer');

  const diffRoute = await cdp.eval(`(async () => {
    const h1 = await window.__rv.waitFor(() => {
      const el = document.querySelector('h1');
      return el && /Diff Viewer/i.test(el.textContent || '') ? el : null;
    });
    return {
      heading: h1 ? (h1.textContent || '').trim() : null,
      isPlaceholder: /under construction|ModulePlaceholder/i.test(document.body.innerText),
      hasPicker: Boolean(document.querySelector('#dv-project-picker')),
    };
  })()`);
  record('route /data/diff-viewer renders the Diff Viewer heading', /Diff Viewer/i.test(diffRoute?.heading || ''), JSON.stringify(diffRoute));
  record('diff viewer is NOT a placeholder page', diffRoute?.isPlaceholder === false, String(diffRoute?.isPlaceholder));

  await cdp.eval(`(async () => {
    const picker = await window.__rv.waitFor(() => document.querySelector('#dv-project-picker'));
    window.__rv.setSelect(picker, ${JSON.stringify(seed.projA)});
    return true;
  })()`);
  await sleep(500);
  const diffManuscript = await cdp.eval(`(async () => {
    const sel = await window.__rv.waitFor(() => { const s = document.querySelector('#dv-manuscript'); return s && s.options.length >= 2 ? s : null; });
    if (!sel) return { ok: false };
    const opt = [...sel.options].find((o) => /Alpha Chapter/.test(o.textContent || ''));
    window.__rv.setSelect(sel, opt.value);
    await window.__rv.sleep(500);
    return { ok: true };
  })()`);
  record('diff viewer: selecting a manuscript loads its comparison selectors', diffManuscript?.ok === true, JSON.stringify(diffManuscript));

  const diffDefault = await cdp.eval(`(async () => {
    const left = await window.__rv.waitFor(() => document.querySelector('#dv-left'));
    const right = document.querySelector('#dv-right');
    const body = document.body.innerText;
    return {
      hasLeft: Boolean(left), hasRight: Boolean(right), optCount: left ? left.options.length : 0,
      hasPlusMinus: /\\+\\d+/.test(body) && /−\\d+/.test(body),
    };
  })()`);
  record('diff viewer: left/right selectors render (Current + versions)', diffDefault?.hasLeft === true && diffDefault?.hasRight === true && diffDefault?.optCount >= 3, JSON.stringify(diffDefault));

  const currentVsVersion = await cdp.eval(`(async () => {
    const body = document.body.innerText;
    return {
      hasSummary: /\\+\\d+/.test(body) && /−\\d+/.test(body),
      hasDiffSpan: window.__rv.anyDiffSpan(),
      listsLR: /Compare/i.test(body) && /With/i.test(body),
    };
  })()`);
  record('diff viewer: current-vs-version renders +/- summary and change highlights', currentVsVersion?.hasSummary === true && currentVsVersion?.hasDiffSpan === true, JSON.stringify(currentVsVersion));

  const versionVsVersion = await cdp.eval(`(async () => {
    const left = document.querySelector('#dv-left');
    const right = document.querySelector('#dv-right');
    const optByRev = (rev) => [...left.options].find((o) => new RegExp('^r' + rev + '\\\\b').test((o.textContent || '').trim()));
    const r1 = optByRev(1);
    const r2 = optByRev(2);
    if (!r1 || !r2) return { ok: false, available: [...left.options].map((o) => o.textContent.trim()) };
    window.__rv.setSelect(left, r2.value);
    window.__rv.setSelect(right, r1.value);
    await window.__rv.sleep(400);
    return { ok: true, hasDiffSpan: window.__rv.anyDiffSpan(), identical: /Identical/.test(document.body.innerText) };
  })()`);
  record('diff viewer: version-vs-version comparison renders a word diff', versionVsVersion?.ok === true && versionVsVersion?.hasDiffSpan === true && versionVsVersion?.identical === false, JSON.stringify(versionVsVersion));

  const identical = await cdp.eval(`(async () => {
    const left = document.querySelector('#dv-left');
    const right = document.querySelector('#dv-right');
    const r1 = [...left.options].find((o) => /^r1\\b/.test((o.textContent || '').trim()));
    window.__rv.setSelect(left, r1.value);
    window.__rv.setSelect(right, r1.value);
    await window.__rv.sleep(400);
    return { identicalBadge: /Identical/.test(document.body.innerText) };
  })()`);
  record('diff viewer: identical selection shows the Identical badge (no diff)', identical?.identicalBadge === true, JSON.stringify(identical));

  await cdp.eval(`(async () => {
    const picker = document.querySelector('#dv-project-picker');
    window.__rv.setSelect(picker, ${JSON.stringify(seed.projB)});
    return true;
  })()`);
  await sleep(700);
  const diffSwitch = await cdp.eval(`(async () => {
    await window.__rv.sleep(300);
    const body = document.body.innerText;
    const sel = document.querySelector('#dv-manuscript');
    const selectedText = sel && sel.selectedIndex >= 0 ? (sel.options[sel.selectedIndex].textContent || '') : '';
    return {
      leaksAlpha: body.includes('Alpha v1 text.') || body.includes('Alpha v2 text') || body.includes('Alpha LIVE'),
      // After switching to B the manuscript selector must reflect B's chapter.
      showsB: /Beta Chapter/.test(selectedText) || /Nothing to compare/.test(body),
      selectedText,
    };
  })()`);
  record('diff viewer: project switch does not retain stale Alpha comparison data (selector reflects B)',
    diffSwitch?.leaksAlpha === false && diffSwitch?.showsB === true, JSON.stringify(diffSwitch));

  const incompatible = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    const h = svc.manuscriptHistoryService;
    // Same draft twice -> rejected.
    const same = await h.getComparableDraftHistories(${JSON.stringify(seed.projA)}, ${JSON.stringify(seed.draftA)}, ${JSON.stringify(seed.draftA)});
    // Cross-owner (chapter draft vs scene draft) -> rejected.
    const crossOwner = await h.getComparableDraftHistories(${JSON.stringify(seed.projA)}, ${JSON.stringify(seed.draftA)}, ${JSON.stringify(seed.draftScene)});
    // A genuine (same-owner) comparable pair is still allowed: a draft against itself
    // is the only same-owner pair here, so we also confirm a cross-project pair is rejected.
    const crossProject = await h.getComparableDraftHistories(${JSON.stringify(seed.projB)}, ${JSON.stringify(seed.draftA)}, ${JSON.stringify(seed.draftScene)});
    return { sameRejected: same === null, crossOwnerRejected: crossOwner === null, crossProjectRejected: crossProject === null };
  })()`);
  record('diff viewer: incompatible targets rejected (same-draft, cross-owner, cross-project -> null)',
    incompatible?.sameRejected === true && incompatible?.crossOwnerRejected === true && incompatible?.crossProjectRejected === true,
    JSON.stringify(incompatible));

  const largeDoc = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    // Reload to project A on the diff page first.
    const picker = document.querySelector('#dv-project-picker');
    window.__rv.setSelect(picker, ${JSON.stringify(seed.projA)});
    await window.__rv.sleep(600);
    const p = ${JSON.stringify(seed.projA)};
    const vol = await svc.outlineService.createVolume(p, { title: 'Large Vol' });
    const ch = await svc.outlineService.createChapter(p, vol.id, { title: 'Large Chapter' });
    const para = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor. ';
    const big = para.repeat(600);
    await svc.manuscriptService.saveChapterDraft(p, ch.id, { content: big });
    await svc.manuscriptService.createManualVersion('chapter', ch.id, 'big v1');
    await svc.manuscriptService.saveChapterDraft(p, ch.id, { content: big + ' A single appended tail sentence.' });
    // Refresh the manuscript list via the page's Refresh button (re-selecting the
    // same project value does not re-fire onChange, so it would not reload).
    const refresh = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim().toLowerCase() === 'refresh');
    if (refresh) refresh.click();
    await window.__rv.sleep(400);
    const sel = await window.__rv.waitFor(() => { const s = document.querySelector('#dv-manuscript'); return s && [...s.options].some((o) => /Large Chapter/.test(o.textContent || '')) ? s : null; }, 8000);
    if (!sel) { await svc.outlineService.deleteChapter(ch.id); return { ok: false, reason: 'Large option not found after refresh' }; }
    const opt = [...sel.options].find((o) => /Large Chapter/.test(o.textContent || ''));
    window.__rv.setSelect(sel, opt.value);
    await window.__rv.sleep(1400);
    const hasDiff = window.__rv.anyDiffSpan();
    const stillMounted = Boolean(document.querySelector('h1'));
    await svc.outlineService.deleteChapter(ch.id);
    return { ok: true, hasDiff, stillMounted };
  })()`);
  record('diff viewer: a large (~8k word) document diffs without breaking the page', largeDoc?.ok === true && largeDoc?.stillMounted === true, JSON.stringify(largeDoc));

  record('no uncaught page exceptions (UI phases)', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

  /* =================================================================== */
  /* PART 2 — RESTORE / AUTOSAVE RACE                                     */
  /* =================================================================== */
  const raceDriver = fs.readFileSync(path.join(__dirname, 'lib', 'p9-b2-race-page.js'), 'utf8');
  let race = null;
  try {
    race = await cdp.eval(`(${raceDriver})()`);
  } catch (error) {
    record('race driver executed', false, error.message);
  }

  if (race) {
    for (const [label, r] of [['chapter', race.chapterHookSequence || {}], ['scene', race.sceneHookSequence || {}]]) {
      record(`race [${label}]: pending debounced save FLUSHED before restore (in-flight write captured the edited text)`,
        r.inFlightContent === 'The user edited pending text.',
        JSON.stringify({ content: r.inFlightContent, rev: r.inFlightExpectedRevision }));
      record(`race [${label}]: delayed in-flight write cannot beat restore (restored text persisted)`,
        r.delayedWriteLanded === true && r.finalContent === 'The original historical text.',
        JSON.stringify({ landed: r.delayedWriteLanded, final: r.finalContent }));
      record(`race [${label}]: editor reload returns the restored content`, r.restoredLoaded === true, String(r.restoredLoaded));
      record(`race [${label}]: restore advanced the revision (append-only)`, r.restoredRevisionAdvanced === true, String(r.restoredRevisionAdvanced));
      record(`race [${label}]: engine REBOUND to the restored revision (not dirty)`,
        typeof r.engineRevisionAfter === 'number' && r.engineDirtyAfter === false,
        JSON.stringify({ rev: r.engineRevisionAfter, dirty: r.engineDirtyAfter }));
      record(`race [${label}]: existing historical version remains intact`, r.baselineVersionIntact === true, String(r.baselineVersionIntact));
      record(`race [${label}]: a restore snapshot was recorded (auditable)`, r.restoreSnapshotPresent === true, String(r.restoreSnapshotPresent));
      record(`race [${label}]: version history stays newest-first`, r.revisionsNewestFirst === true, String(r.revisionsNewestFirst));
    }

    const f = race.restoreFailure || {};
    record('race: restore FAILURE throws and leaves the DB unchanged', f.threw === true && f.dbUnchanged === true, JSON.stringify(f));
    record('race: restore FAILURE leaves the engine usable', f.engineStillUsable === true, String(f.engineStillUsable));

    const post = race.postRestoreEditing || {};
    record('race: after restore, NEW edits persist against the new revision (editor still works)',
      post.persistedPostEdit === true && post.revisionAdvanced === true, JSON.stringify(post));

    const iso = race.crossDocIsolation || {};
    record('race: chapter and scene drafts stay isolated (distinct owners + rows; scene unaffected)',
      iso.distinctOwners === true && iso.distinctDraftIds === true && iso.sceneContentIsPostEdit === true, JSON.stringify(iso));

    const cl = race.cleanup || {};
    record('race: cleanup removed the race project (no orphan drafts/versions)',
      cl.drafts === 0 && cl.sceneDrafts === 0 && cl.versions === 0, JSON.stringify(cl));
  }

  /* =================================================================== */
  /* Cleanup seeded projects                                             */
  /* =================================================================== */
  await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    for (const p of await svc.projectService.listProjects()) await svc.projectService.deleteProject(p.id);
    return true;
  })()`).catch(() => {});

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
