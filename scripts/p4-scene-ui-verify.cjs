/**
 * P4 scene-prose UI smoke test: real browser, real DOM, real editor.
 *
 * Drives the scene half of the Writing tab end to end:
 *   project detail -> "Writing" tab -> "Scene prose" sub-view -> chapter picker
 *   -> scene rail -> SceneEditorSurface renders -> type into the TipTap surface
 *   -> autosave fires -> status turns "Saved" -> reload the page -> the typed
 *   prose is still there -> switch scenes -> the outgoing scene was flushed
 *   before the switch -> scene prose stays independent from chapter prose.
 *
 * Usage: npm run verify:writing:scene:ui
 * Requires a dev server on http://localhost:5177/.
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_URL = 'http://localhost:5177/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9349;

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

  /**
   * Sends a command with a hard upper bound, so a stalled navigation can never
   * hang the whole run without output.
   */
  sendBounded(method, params = {}, ms = 15_000) {
    let timer = null;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${method} did not complete within ${ms}ms.`)), ms);
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

  async type(text) {
    for (const char of text) {
      await this.send('Input.insertText', { text: char });
    }
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
  try {
    if (activeProfileDir) fs.rmSync(activeProfileDir, { recursive: true, force: true });
  } catch { /* best effort */ }
}

process.on('SIGINT', () => { teardown(); process.exit(130); });
process.on('SIGTERM', () => { teardown(); process.exit(143); });

/** Opens the project detail page and selects the requested tab. */
async function openProjectTab(cdp, projectId) {
  await cdp.send('Page.navigate', { url: `${APP_URL}projects/${projectId}` });
  await cdp.eval(`(() => {
    history.pushState(null, '', '/projects/${projectId}');
    window.dispatchEvent(new PopStateEvent('popstate'));
    return true;
  })()`);
  return cdp.eval(`(async () => {
    for (let i = 0; i < 40; i++) {
      if (document.body.innerText.includes('Scene UI Project')) return true;
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  })()`);
}

async function main() {
  if (!fs.existsSync(CHROME)) {
    throw new Error(`Chrome not found at ${CHROME}.`);
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4sceneui-chrome-'));
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

  // ---- Seed project + volume + chapter + chapter prose + two scenes ----
  stage('seeding');
  const seed = await cdp.eval(`(async () => {
    const dbMod = await import('/src/db/index.ts');
    const svc = await import('/src/services/index.ts');
    await dbMod.initDatabase();
    const p = await svc.projectService.createProject({ title: 'Scene UI Project' });
    const vol = await svc.outlineService.createVolume(p.id, { title: 'Book One' });
    const c1 = await svc.outlineService.createChapter(p.id, vol.id, { title: 'The Lighthouse' });
    await svc.manuscriptService.saveChapterDraft(p.id, c1.id, { content: 'Chapter level prose stays separate.' });
    const s1 = await svc.sceneService.createScene(p.id, c1.id, { title: 'Arrival', location: 'Harbour' });
    const s2 = await svc.sceneService.createScene(p.id, c1.id, { title: 'Departure' });
    localStorage.setItem('n87-p4sceneui', JSON.stringify({ projectId: p.id, c1: c1.id, s1: s1.id, s2: s2.id }));
    return { projectId: p.id, chapterId: c1.id, s1: s1.id, s2: s2.id };
  })()`);
  record('seed project with a chapter and two scenes', !!seed?.s1 && !!seed?.s2, JSON.stringify(seed));

  // ---- Open the project's Writing tab ----
  stage('opening the project detail page');
  const detailRendered = await openProjectTab(cdp, seed.projectId);
  record('project detail page renders', detailRendered === true, `path=${await cdp.eval('location.pathname')}`);

  const writingClicked = await cdp.eval(`(() => {
    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    const writing = tabs.find((t) => (t.textContent || '').trim() === 'Writing');
    if (!writing) return { found: false, tabs: tabs.map((t) => (t.textContent || '').trim()) };
    writing.click();
    return { found: true };
  })()`);
  record('Writing tab is present and reachable', writingClicked?.found === true, JSON.stringify(writingClicked));
  await sleep(1000);

  // ---- Switch to the "Scene prose" sub-view ----
  const sceneView = await cdp.eval(`(async () => {
    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    const labels = tabs.map((t) => (t.textContent || '').trim());
    const sceneTab = tabs.find((t) => (t.textContent || '').trim() === 'Scene prose');
    if (sceneTab) sceneTab.click();
    for (let i = 0; i < 40; i++) {
      if (document.body.innerText.includes('Scene prose')) return { found: true, labels, body: document.body.innerText.slice(0, 400) };
      await new Promise((r) => setTimeout(r, 150));
    }
    return { found: false, labels, body: document.body.innerText.slice(0, 400) };
  })()`);
  record('Writing view: "Scene prose" sub-view is reachable', sceneView?.found === true, JSON.stringify(sceneView?.labels));

  // ---- Chapter picker + scene rail render ----
  const rail = await cdp.eval(`(async () => {
    for (let i = 0; i < 40; i++) {
      const chapterSelect = document.querySelector('select[aria-label="Select chapter"]');
      const hasArrival = document.body.innerText.includes('Arrival');
      const hasDeparture = document.body.innerText.includes('Departure');
      if (chapterSelect && hasArrival && hasDeparture) {
        return { ok: true, options: Array.from(chapterSelect.options).map((o) => o.textContent) };
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    return { ok: false, body: document.body.innerText.slice(0, 600) };
  })()`);
  record('scene view: chapter picker and scene rail render', rail?.ok === true, JSON.stringify(rail));

  // ---- Select a scene so the editor surface mounts ----
  const sceneClicked = await cdp.eval(`(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const arrival = buttons.find((b) => (b.textContent || '').trim().endsWith('Arrival'));
    if (!arrival) return false;
    arrival.click();
    return true;
  })()`);
  record('scene view: clicking a scene opens its editor', sceneClicked === true);

  await sleep(1200);

  // Note: TipTap/ProseMirror renders the editable node itself as the element
  // carrying `editorProps.attributes`, so the `aria-label` sits on the
  // `[contenteditable="true"]` element rather than on a wrapper.
  const surface = await cdp.eval(`(async () => {
    for (let i = 0; i < 40; i++) {
      const el = document.querySelector('[aria-label^="Scene manuscript:"]');
      if (el) {
        return {
          hasSurface: true,
          label: el.getAttribute('aria-label'),
          editable: el.getAttribute('contenteditable') === 'true',
          showsTitle: document.body.innerText.includes('Arrival'),
          hasWordCount: /\\d+ words/.test(document.body.innerText),
          chapterProseLeaked: document.body.innerText.includes('Chapter level prose stays separate.'),
        };
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    return { hasSurface: false };
  })()`);
  record(
    'scene editor: TipTap surface mounts with its own accessible name',
    surface?.hasSurface === true &&
      surface?.editable === true &&
      surface?.showsTitle === true &&
      surface?.label === 'Scene manuscript: Arrival',
    JSON.stringify(surface),
  );
  record(
    'scene editor: chapter prose never leaks into the scene surface',
    surface?.chapterProseLeaked === false,
    JSON.stringify({ chapterProseLeaked: surface?.chapterProseLeaked }),
  );

  // ---- Type into the scene surface ----
  stage('typing into the scene editor');
  const focused = await cdp.eval(`(() => {
    const editor = document.querySelector('[aria-label^="Scene manuscript:"]');
    if (!editor) return false;
    editor.focus();
    return document.activeElement === editor;
  })()`);
  record('scene editor: the surface accepts focus', focused === true);

  await cdp.type('The boat drifted in.');
  await sleep(400);

  const afterType = await cdp.eval(`(() => {
    const surface = document.querySelector('[aria-label^="Scene manuscript:"]');
    const text = surface?.innerText ?? '';
    const body = document.body.innerText;
    return {
      typedVisible: text.includes('The boat drifted in.'),
      unsaved: body.includes('Unsaved changes'),
      saving: body.includes('Saving...'),
      saved: /Saved/.test(body),
    };
  })()`);
  record(
    'scene autosave: typing marks the document dirty and the text renders',
    afterType?.typedVisible === true && afterType?.unsaved === true,
    JSON.stringify(afterType),
  );

  // ---- Wait for the debounced autosave ----
  stage('waiting for scene autosave');
  const saved = await cdp.eval(`(async () => {
    for (let i = 0; i < 60; i++) {
      const body = document.body.innerText;
      if (/Saved/.test(body) && !body.includes('Unsaved changes') && !body.includes('Saving...')) {
        return { saved: true };
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return { saved: false, body: document.body.innerText.slice(0, 700) };
  })()`);
  record('scene autosave: the debounced save completes and the status shows "Saved"', saved?.saved === true, JSON.stringify(saved));

  const persisted = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    const { s1 } = JSON.parse(localStorage.getItem('n87-p4sceneui'));
    const draft = await svc.manuscriptService.getDraft('scene', s1);
    return draft ? { content: draft.content, words: draft.wordCount, revision: draft.revision, kind: draft.kind } : null;
  })()`);
  record(
    'scene persistence: typed prose reached the scene draft (chapter draft untouched)',
    persisted?.kind === 'scene' && String(persisted?.content).includes('The boat drifted in.') && persisted?.revision === 1,
    JSON.stringify(persisted),
  );

  const chapterUntouched = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    const { c1 } = JSON.parse(localStorage.getItem('n87-p4sceneui'));
    const draft = await svc.manuscriptService.getDraft('chapter', c1);
    return draft ? { content: draft.content, revision: draft.revision } : null;
  })()`);
  record(
    'scene prose is independent of chapter prose',
    chapterUntouched?.content === 'Chapter level prose stays separate.' && chapterUntouched?.revision === 1,
    JSON.stringify(chapterUntouched),
  );

  // ---- Reload and confirm the scene prose is restored ----
  stage('reloading the page');
  await openProjectTab(cdp, seed.projectId);
  await cdp.eval(`(() => {
    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    const writing = tabs.find((t) => (t.textContent || '').trim() === 'Writing');
    writing?.click();
    return true;
  })()`);
  await sleep(800);
  await cdp.eval(`(() => {
    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    const sceneTab = tabs.find((t) => (t.textContent || '').trim() === 'Scene prose');
    sceneTab?.click();
    return true;
  })()`);
  await sleep(900);
  const restored = await cdp.eval(`(async () => {
    for (let i = 0; i < 40; i++) {
      const buttons = Array.from(document.querySelectorAll('button'));
      const arrival = buttons.find((b) => (b.textContent || '').trim().endsWith('Arrival'));
      if (arrival) {
        arrival.click();
        await new Promise((r) => setTimeout(r, 800));
        const surface = document.querySelector('[aria-label^="Scene manuscript:"]');
        return { text: surface?.innerText ?? '' };
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    return { text: '', missing: true };
  })()`);
  record(
    'scene reload: the manuscript is restored from the database',
    String(restored?.text).includes('The boat drifted in.'),
    JSON.stringify(restored?.text),
  );

  // ---- Switch scenes: outgoing prose is flushed ----
  stage('switching scenes');
  const switchResult = await cdp.eval(`(async () => {
    const editor = document.querySelector('[aria-label^="Scene manuscript:"]');
    if (!editor) return false;
    const selection = window.getSelection();
    selection.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.addRange(range);
    editor.focus();
    return true;
  })()`);
  if (switchResult) await cdp.type(' Anchored by the reef.');
  await sleep(300);

  const switched = await cdp.eval(`(async () => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const departure = buttons.find((b) => (b.textContent || '').trim().endsWith('Departure'));
    if (!departure) return { clicked: false };
    departure.click();
    await new Promise((r) => setTimeout(r, 1200));
    const svc = await import('/src/services/index.ts');
    const { s1 } = JSON.parse(localStorage.getItem('n87-p4sceneui'));
    const draft = await svc.manuscriptService.getDraft('scene', s1);
    const surface = document.querySelector('[aria-label^="Scene manuscript:"]');
    return {
      clicked: true,
      stored: draft?.content ?? null,
      nowShowing: (surface?.getAttribute('aria-label') ?? '').includes('Departure'),
      editorEmpty: !(surface?.innerText ?? '').includes('drifted'),
    };
  })()`);
  record(
    'scene switch: the outgoing scene is flushed before the new one opens',
    switched?.clicked === true &&
      String(switched?.stored).includes('Anchored by the reef.') &&
      switched?.nowShowing === true &&
      switched?.editorEmpty === true,
    JSON.stringify(switched),
  );

  // ---- Cleanup ----
  const cleaned = await cdp.eval(`(async () => {
    const dbMod = await import('/src/db/index.ts');
    const svc = await import('/src/services/index.ts');
    const { projectId } = JSON.parse(localStorage.getItem('n87-p4sceneui'));
    await svc.projectService.deleteProject(projectId);
    return {
      scenes: await dbMod.db.scenes.where('projectId').equals(projectId).count(),
      chapterDrafts: await dbMod.db.chapterDrafts.where('projectId').equals(projectId).count(),
      sceneDrafts: await dbMod.db.sceneDrafts.where('projectId').equals(projectId).count(),
      versions: await dbMod.db.draftVersions.where('projectId').equals(projectId).count(),
    };
  })()`);
  record(
    'cleanup: deleting the project removes scenes and scene drafts',
    Object.values(cleaned ?? {}).every((v) => v === 0),
    JSON.stringify(cleaned),
  );

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
