/**
 * P4 UI smoke test: real browser, real DOM, real editor.
 *
 * Drives the actual Writing tab end to end:
 *   project detail -> "Writing" tab -> editor renders the open chapter ->
 *   type into the TipTap surface -> autosave fires -> status turns "Saved" ->
 *   reload the page -> the typed prose is still there -> switch chapters ->
 *   the previous chapter's text was flushed before the switch.
 *
 * Usage: npm run verify:writing:ui
 * Requires a dev server on http://localhost:5177/.
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_URL = 'http://localhost:5177/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9348;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
function stage(label, extra) {
  console.log(`[${String(Date.now() - t0).padStart(6, ' ')}ms] STAGE: ${label}${extra ? '  ' + extra : ''}`);
}

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
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
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

  /** Types text into the focused element through real input events. */
  async type(text) {
    for (const char of text) {
      await this.send('Input.insertText', { text: char });
    }
  }

  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }
}

let activeWs = null;
let activeChrome = null;
let activeProfileDir = null;
let tornDown = false;

function teardown() {
  if (tornDown) return;
  tornDown = true;
  try { activeWs?.close(); } catch { /* already closed */ }
  try { activeChrome?.kill(); } catch { /* already gone */ }
  // The profile dir is released asynchronously by Chrome; a leftover temp dir
  // is harmless, so a failure to remove it must not fail the run.
  try {
    if (activeProfileDir) fs.rmSync(activeProfileDir, { recursive: true, force: true });
  } catch { /* best effort */ }
}

process.on('SIGINT', () => { teardown(); process.exit(130); });
process.on('SIGTERM', () => { teardown(); process.exit(143); });

async function main() {
  if (!fs.existsSync(CHROME)) {
    throw new Error(`Chrome not found at ${CHROME}.`);
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4ui-chrome-'));
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
  // The handshake has no natural failure mode of its own: if Chrome's target is
  // listed but its renderer never finishes opening the socket, neither `open`
  // nor `error` fires and the run would hang forever with no output. A bounded
  // timeout turns that silent deadlock into a normal rejection, which the
  // existing catch/teardown path already handles.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('CDP WebSocket never opened within 10s.')),
      10_000,
    );
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

  const pageErrors = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params?.exceptionDetails?.exception?.description ?? 'unknown');
    }
  });

  stage('navigating to app');
  await cdp.send('Page.navigate', { url: APP_URL });
  await sleep(3000);

  // ---- Seed project + volume + two chapters ----
  stage('seeding');
  const seed = await cdp.eval(`(async () => {
    const dbMod = await import('/src/db/index.ts');
    const svc = await import('/src/services/index.ts');
    await dbMod.initDatabase();
    const p = await svc.projectService.createProject({ title: 'Writing UI Project' });
    const vol = await svc.outlineService.createVolume(p.id, { title: 'Book One' });
    const c1 = await svc.outlineService.createChapter(p.id, vol.id, { title: 'The Lighthouse' });
    const c2 = await svc.outlineService.createChapter(p.id, vol.id, { title: 'The Storm' });
    localStorage.setItem('n87-p4ui', JSON.stringify({ projectId: p.id, c1: c1.id, c2: c2.id }));
    return { projectId: p.id, c1: c1.id, c2: c2.id };
  })()`);
  record('seed project with two chapters', !!seed?.c1, JSON.stringify(seed));

  // ---- Navigate to the project's Writing tab ----
  stage('opening the project detail page');
  await cdp.send('Page.navigate', { url: `${APP_URL}#/projects/${seed.projectId}` });
  await cdp.eval(`(() => {
    history.pushState(null, '', '/projects/${seed.projectId}');
    window.dispatchEvent(new PopStateEvent('popstate'));
    return true;
  })()`);
  await sleep(2500);

  // Wait for the detail page (and its tab bar) to be fully hydrated.
  const detailRendered = await cdp.eval(`(async () => {
    for (let i = 0; i < 40; i++) {
      if (document.body.innerText.includes('Writing UI Project')) return true;
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  })()`);
  record('project detail page renders', detailRendered === true, `path=${await cdp.eval('location.pathname')}`);

  // Click the "Writing" tab.
  const tabClicked = await cdp.eval(`(() => {
    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    const writing = tabs.find((t) => (t.textContent || '').trim() === 'Writing');
    if (!writing) return { found: false, tabs: tabs.map((t) => (t.textContent || '').trim()) };
    writing.click();
    return { found: true };
  })()`);
  record('Writing tab is present and reachable', tabClicked?.found === true, JSON.stringify(tabClicked));

  await sleep(1200);

  // ---- Editor surface renders with the first chapter ----
  const surface = await cdp.eval(`(() => {
    const editable = document.querySelector('[aria-label="Chapter manuscript"]');
    const text = document.body.innerText;
    return {
      hasEditable: !!editable,
      isContentEditable: editable ? editable.getAttribute('contenteditable') === 'true' : false,
      showsFirstChapter: text.includes('The Lighthouse'),
      showsNav: text.includes('The Storm'),
      hasWordCount: /\\d+ words/.test(text),
    };
  })()`);
  record(
    'editor: TipTap surface mounts, chapter title and nav render',
    surface?.hasEditable === true &&
      surface?.isContentEditable === true &&
      surface?.showsFirstChapter === true &&
      surface?.showsNav === true &&
      surface?.hasWordCount === true,
    JSON.stringify(surface),
  );

  // ---- Type into the editor ----
  stage('typing into the editor');
  const focused = await cdp.eval(`(() => {
    const editable = document.querySelector('[aria-label="Chapter manuscript"]');
    if (!editable) return false;
    editable.focus();
    return document.activeElement === editable;
  })()`);
  record('editor: the surface accepts focus', focused === true, String(focused));

  await cdp.type('The lamp swept the sea.');
  await sleep(300);

  // The autosave indicator should show unsaved or saving straight away.
  const afterTyping = await cdp.eval(`(() => {
    const text = document.body.innerText;
    return {
      unsaved: text.includes('Unsaved changes'),
      saving: text.includes('Saving…'),
      saved: text.includes('Saved'),
      typedVisible: text.includes('The lamp swept the sea.'),
    };
  })()`);
  record(
    'autosave: typing marks the document dirty and the text renders',
    afterTyping?.typedVisible === true && (afterTyping?.unsaved || afterTyping?.saving),
    JSON.stringify(afterTyping),
  );

  // ---- Wait for the debounced save to complete ----
  stage('waiting for autosave');
  let savedState = null;
  for (let i = 0; i < 40; i += 1) {
    savedState = await cdp.eval(`(() => {
      const text = document.body.innerText;
      return { saved: text.includes('Saved'), unsaved: text.includes('Unsaved changes'), failed: text.includes('Save failed') };
    })()`);
    if (savedState?.saved) break;
    await sleep(250);
  }
  record(
    'autosave: the debounced save completes and the status shows "Saved"',
    savedState?.saved === true && savedState?.failed === false,
    JSON.stringify(savedState),
  );

  // ---- The prose is actually persisted ----
  const persisted = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    const { projectId, c1 } = JSON.parse(localStorage.getItem('n87-p4ui'));
    const draft = await svc.manuscriptService.getDraft('chapter', c1);
    return { content: draft ? draft.content : null, words: draft ? draft.wordCount : 0, revision: draft ? draft.revision : 0 };
  })()`);
  record(
    'persistence: typed prose reached the database with derived counters',
    typeof persisted?.content === 'string' &&
      persisted.content.includes('The lamp swept the sea.') &&
      persisted?.words > 0 &&
      persisted?.revision === 1,
    JSON.stringify(persisted),
  );

  // ---- Reload: the prose survives a full page reload ----
  stage('reloading the page');
  await cdp.send('Page.navigate', { url: `${APP_URL}#/projects/${seed.projectId}` });
  await cdp.eval(`(() => {
    history.pushState(null, '', '/projects/${seed.projectId}');
    window.dispatchEvent(new PopStateEvent('popstate'));
    return true;
  })()`);
  await cdp.eval(`(async () => {
    for (let i = 0; i < 40; i++) {
      if (Array.from(document.querySelectorAll('[role="tab"]')).length > 0) return true;
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  })()`);
  await cdp.eval(`(() => {
    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    const writing = tabs.find((t) => (t.textContent || '').trim() === 'Writing');
    if (writing) writing.click();
    return true;
  })()`);
  await sleep(1800);

  const afterReload = await cdp.eval(`(() => {
    const editable = document.querySelector('[aria-label="Chapter manuscript"]');
    return {
      rendered: !!editable,
      content: editable ? editable.innerText : '',
    };
  })()`);
  record(
    'reload: the manuscript is restored from the database',
    afterReload?.rendered === true && afterReload?.content?.includes('The lamp swept the sea.'),
    JSON.stringify(afterReload?.content?.slice(0, 60)),
  );

  // ---- Switching chapters flushes the outgoing document first ----
  stage('switching chapters');
  const switched = await cdp.eval(`(() => {
    const editable = document.querySelector('[aria-label="Chapter manuscript"]');
    if (!editable) return { ok: false };
    editable.focus();
    return { ok: document.activeElement === editable };
  })()`);
  if (switched?.ok) {
    await cdp.type('Second chapter prose.');
  }
  // Click the other chapter in the left rail.
  const navClicked = await cdp.eval(`(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const target = buttons.find((b) => (b.textContent || '').includes('The Storm'));
    if (!target) return false;
    target.click();
    return true;
  })()`);
  await sleep(2000);

  const flushed = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    const { c1 } = JSON.parse(localStorage.getItem('n87-p4ui'));
    const draft = await svc.manuscriptService.getDraft('chapter', c1);
    const editable = document.querySelector('[aria-label="Chapter manuscript"]');
    return {
      stored: draft ? draft.content : null,
      nowShowing: document.body.innerText.includes('The Storm'),
      editorEmpty: editable ? editable.innerText.trim() === '' : null,
    };
  })()`);
  record(
    'switch: the outgoing chapter is flushed before the new one opens',
    navClicked === true &&
      typeof flushed?.stored === 'string' &&
      flushed.stored.includes('Second chapter prose.') &&
      flushed?.nowShowing === true &&
      flushed?.editorEmpty === true,
    JSON.stringify({ navClicked, stored: flushed?.stored, nowShowing: flushed?.nowShowing, editorEmpty: flushed?.editorEmpty }),
  );

  // ---- Cleanup ----
  const cleaned = await cdp.eval(`(async () => {
    const dbMod = await import('/src/db/index.ts');
    const svc = await import('/src/services/index.ts');
    const { projectId } = JSON.parse(localStorage.getItem('n87-p4ui'));
    await svc.projectService.deleteProject(projectId);
    return {
      chapters: await dbMod.db.chapters.where('projectId').equals(projectId).count(),
      drafts: await dbMod.db.chapterDrafts.where('projectId').equals(projectId).count(),
      versions: await dbMod.db.draftVersions.where('projectId').equals(projectId).count(),
    };
  })()`);
  record('cleanup: no orphaned rows after project delete', Object.values(cleaned ?? {}).every((v) => v === 0), JSON.stringify(cleaned));

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
  .then(() => {
    teardown();
    process.exit(process.exitCode || 0);
  })
  .catch((error) => {
    console.error('HARNESS ERROR:', error);
    teardown();
    process.exit(1);
  });
