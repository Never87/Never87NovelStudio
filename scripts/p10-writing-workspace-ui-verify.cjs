/**
 * Writing Workspace upgrade — real-browser verification.
 *
 * Exercises the Story Editor writing workspace (items 1–8 of the UX brief)
 * against the real DOM, real IndexedDB and the real services:
 *
 *   1. three-panel workspace renders (Manuscript · editor · Story panel);
 *   2. Focus Mode hides global chrome AND its own page header, and reverts;
 *   3. in-editor "New chapter" opens a writable chapter + switches to it;
 *   4. typography change applies + persists to localStorage;
 *   5. Links tab computes bidirectional chapter↔entity links;
 *   6. Continuity tab reconstructs point-in-time state;
 *   7. Projects/selector: a project selector is present on the Story Editor;
 *   8. Ideas capture writes a Knowledge Base entry linked to the chapter.
 *
 * Usage: npm run verify:workspace:ui   (needs a dev server on :5177)
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_URL = 'http://localhost:5177/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9460;

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
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) {
      const d = result.exceptionDetails;
      throw new Error(`Page exception: ${d.exception?.description || d.text || JSON.stringify(d)}`);
    }
    return result.result.value;
  }
  async type(text) {
    for (const char of text) await this.send('Input.insertText', { text: char });
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

/** Clicks the first element matching a text-bearing selector. */
function clickByTextJs(findExpr, text) {
  return `(() => {
    const el = ${findExpr}.find((n) => (n.textContent || '').trim().includes(${JSON.stringify(text)}));
    if (!el) return false;
    el.click();
    return true;
  })()`;
}

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}.`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsui-chrome-'));
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

  const pageErrors = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params?.exceptionDetails?.exception?.description ?? 'unknown');
    }
  });

  await cdp.send('Page.navigate', { url: APP_URL });
  await sleep(2500);

  // ---- Seed a project with one character, two chapters, continuity + knowledge ----
  const seed = await cdp.eval(`(async () => {
    const dbMod = await import('/src/db/index.ts');
    const svc = await import('/src/services/index.ts');
    await dbMod.initDatabase();
    for (const p of await svc.projectService.listProjects()) await svc.projectService.deleteProject(p.id);
    const p = await svc.projectService.createProject({ title: 'Workspace Project' });
    const ch = await svc.characterService.createCharacter(p.id, { name: 'Elara' });
    const vol = await svc.outlineService.createVolume(p.id, { title: 'Book One' });
    const c1 = await svc.outlineService.createChapter(p.id, vol.id, { title: 'Arrival', characterIds: [ch.id] });
    const c2 = await svc.outlineService.createChapter(p.id, vol.id, { title: 'Storm', characterIds: [] });
    // Give chapter 1 prose that mentions Elara so links detect a mention.
    // (opening the draft ensures one exists before we save into it.)
    const doc = await svc.manuscriptService.openChapterDraft(p.id, c1.id);
    await svc.manuscriptService.saveChapterDraft(p.id, c1.id, { content: 'Elara stepped onto the shore.', expectedRevision: doc.draft.revision });
    // A continuity fact anchored at chapter 1.
    await svc.continuityService.createFact(p.id, { subjectType: 'character', subjectId: ch.id, subjectLabel: 'Elara', predicate: 'position', value: 'harbour', anchorChapterId: c1.id });
    localStorage.setItem('n87-wsui', JSON.stringify({ projectId: p.id, c1: c1.id, c2: c2.id, charId: ch.id }));
    return { projectId: p.id, c1: c1.id, c2: c2.id, charId: ch.id };
  })()`);
  record('seed project (character + 2 chapters + continuity + prose)', !!seed?.c1, JSON.stringify(seed));

  // ---- Open the Story Editor route for that project ----
  const url = `${APP_URL}novel/story-editor?project=${seed.projectId}`;
  await cdp.sendBounded('Page.navigate', { url }, 20_000);
  const mounted = await cdp.eval(`(async () => {
    for (let i = 0; i < 80; i++) {
      const editable = document.querySelector('[aria-label="Chapter manuscript"]');
      const text = document.body.innerText;
      if (editable && text.includes('Manuscript') && text.includes('Arrival')) return true;
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  })()`);
  record('workspace: three-panel editor mounts on the Story Editor route', mounted === true, String(mounted));

  // 1. Story panel with its four tabs is present.
  const panel = await cdp.eval(`(() => {
    const tabs = Array.from(document.querySelectorAll('[role="tab"]')).map((t) => (t.textContent || '').trim());
    const storyTabs = ['AI', 'Links', 'Continuity', 'Ideas'].every((label) => tabs.includes(label));
    return { storyTabs, tabs };
  })()`);
  record('workspace: Story panel exposes AI / Links / Continuity / Ideas tabs', panel?.storyTabs === true, JSON.stringify(panel?.tabs));

  // 7. Project selector present on the header.
  const hasSelector = await cdp.eval(`document.body.innerText.includes('Workspace Project')`);
  record('projects: in-workspace project selector shows the current project', hasSelector === true, String(hasSelector));

  // 2. Focus Mode: click Focus, global sidebar/topbar hidden, page header gone.
  const focusClicked = await cdp.eval(clickByTextJs(`Array.from(document.querySelectorAll('button'))`, 'Focus'));
  record('focus: the Focus Mode control is present', focusClicked === true, String(focusClicked));
  // Poll for the transition (React state update + re-render).
  await cdp.eval(`(async () => {
    for (let i = 0; i < 40; i++) {
      if (Array.from(document.querySelectorAll('button')).some((b) => (b.textContent || '').trim() === 'Exit Focus')) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  })()`);
  const focusState = await cdp.eval(`(() => {
    const text = document.body.innerText;
    const hasDashboardLink = !!Array.from(document.querySelectorAll('a')).find((a) => (a.textContent || '').trim() === 'Dashboard');
    const hasPageHeader = text.includes('Write and autosave chapter manuscripts');
    const exitPresent = !!Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Exit Focus');
    const editorStillThere = !!document.querySelector('[aria-label="Chapter manuscript"]');
    return { hasDashboardLink, hasPageHeader, exitPresent, editorStillThere };
  })()`);
  record(
    'focus: entering Focus hides sidebar and page header while the SAME editor stays mounted',
    focusState?.exitPresent === true && focusState?.hasDashboardLink === false && focusState?.hasPageHeader === false && focusState?.editorStillThere === true,
    JSON.stringify(focusState),
  );

  // Exit focus.
  await cdp.eval(clickByTextJs(`Array.from(document.querySelectorAll('button'))`, 'Exit Focus'));
  await cdp.eval(`(async () => {
    for (let i = 0; i < 40; i++) {
      if (Array.from(document.querySelectorAll('a')).some((a) => (a.textContent || '').trim() === 'Dashboard')) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  })()`);
  const afterExit = await cdp.eval(`(() => {
    const hasDashboardLink = !!Array.from(document.querySelectorAll('a')).find((a) => (a.textContent || '').trim() === 'Dashboard');
    const hasPageHeader = document.body.innerText.includes('Write and autosave chapter manuscripts');
    return { hasDashboardLink, hasPageHeader };
  })()`);
  record('focus: exiting Focus restores the global chrome and page header', afterExit?.hasDashboardLink === true && afterExit?.hasPageHeader === true, JSON.stringify(afterExit));

  // 4. Typography: open the menu, pick "Sans" font, verify it persists to storage
  // AND applies as a CSS variable on the writing surface.
  const typo = await cdp.eval(`(async () => {
    const before = JSON.parse(localStorage.getItem('n87-story-editor') || '{}');
    const beforeFont = before?.state?.typography?.fontFamily ?? null;
    // Open the typography popover (IconButton aria-label="Editor typography").
    const openBtn = Array.from(document.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') || '') === 'Editor typography');
    if (!openBtn) return { found: false };
    openBtn.click();
    await new Promise((r) => setTimeout(r, 200));
    const sans = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Sans');
    if (!sans) return { found: true, clickedSans: false };
    sans.click();
    await new Promise((r) => setTimeout(r, 200));
    const after = JSON.parse(localStorage.getItem('n87-story-editor') || '{}');
    const surface = document.querySelector('.n87-prose-editor');
    const fontFamily = surface ? getComputedStyle(surface).fontFamily : null;
    return { found: true, clickedSans: true, beforeFont, afterFont: after?.state?.typography?.fontFamily ?? null, fontFamily };
  })()`);
  record(
    'typography: choosing a font persists to storage and applies to the writing surface',
    typo?.found === true && typo?.clickedSans === true && typo?.afterFont === 'sans' &&
      typo?.afterFont !== typo?.beforeFont &&
      typeof typo?.fontFamily === 'string' && /Inter/i.test(typo.fontFamily),
    JSON.stringify(typo),
  );

  // 5. Links tab computes bidirectional links.
  await cdp.eval(clickByTextJs(`Array.from(document.querySelectorAll('[role="tab"]'))`, 'Links'));
  await sleep(800);
  const links = await cdp.eval(`(() => {
    const text = document.body.innerText.toLowerCase();
    return {
      showsCharacters: text.includes('characters in this chapter'),
      showsThought: text.includes('two-way connections'),
      mentionsElara: text.includes('elara'),
    };
  })()`);
  record(
    'links: Links tab renders the bidirectional view and finds the linked/mentioned character',
    links?.showsCharacters === true && links?.mentionsElara === true,
    JSON.stringify(links),
  );

  // 6. Continuity tab reconstructs point-in-time state.
  await cdp.eval(clickByTextJs(`Array.from(document.querySelectorAll('[role="tab"]'))`, 'Continuity'));
  await sleep(900);
  const continuity = await cdp.eval(`(() => {
    const text = document.body.innerText;
    return { showsStateHeading: text.includes('Continuity state as of this chapter'), harbour: text.includes('harbour'), elara: text.includes('Elara') };
  })()`);
  record(
    'continuity: tab reconstructs state as of the chapter and shows the anchored fact',
    continuity?.showsStateHeading === true && continuity?.harbour === true,
    JSON.stringify(continuity),
  );

  // 8. Ideas capture writes a Knowledge Base entry linked to the chapter.
  await cdp.eval(clickByTextJs(`Array.from(document.querySelectorAll('[role="tab"]'))`, 'Ideas'));
  await sleep(300);
  const ideaTyped = await cdp.eval(`(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return false;
    ta.focus();
    return document.activeElement === ta;
  })()`);
  if (ideaTyped) await cdp.type('A twist: the storm is alive.');
  await sleep(200);
  const captured = await cdp.eval(clickByTextJs(`Array.from(document.querySelectorAll('button'))`, 'Capture idea'));
  await sleep(900);
  const ideaSaved = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    const { projectId, c1 } = JSON.parse(localStorage.getItem('n87-wsui'));
    const entries = await svc.knowledgeService.listEntries(projectId);
    const hit = entries.find((e) => /storm is alive/i.test(e.title));
    return {
      found: !!hit,
      tagged: hit ? (hit.tags || []).includes('idea') : false,
      linkedToChapter: hit ? (hit.evidence || []).some((ev) => ev.chapterId === c1) : false,
      capturedOk: ${captured === true},
    };
  })()`);
  record(
    'ideas: capture saves a Knowledge Base entry tagged "idea" and linked to the chapter',
    ideaSaved?.found === true && ideaSaved?.tagged === true && ideaSaved?.linkedToChapter === true,
    JSON.stringify(ideaSaved),
  );

  // 3. In-editor creation: create a new chapter and confirm it opens writable.
  const beforeCount = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    const { projectId } = JSON.parse(localStorage.getItem('n87-wsui'));
    return (await svc.outlineService.listProjectChapters(projectId)).length;
  })()`);
  const newChapterClicked = await cdp.eval(`(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') || '') === 'New chapter');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await sleep(300);
  const created = await cdp.eval(`(async () => {
    const input = document.querySelector('input[placeholder="e.g. Chapter 1"]');
    if (!input) return { typed: false };
    input.focus();
    return { typed: document.activeElement === input };
  })()`);
  if (created?.typed) await cdp.type('In-Editor Chapter');
  await sleep(150);
  const submitClicked = await cdp.eval(`(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') || '') === 'Create chapter');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await sleep(1200);
  const afterCreate = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    const { projectId } = JSON.parse(localStorage.getItem('n87-wsui'));
    const chapters = await svc.outlineService.listProjectChapters(projectId);
    const editable = document.querySelector('[aria-label="Chapter manuscript"]');
    const headerTitle = document.querySelector('h3');
    return {
      count: chapters.length,
      hasNew: chapters.some((c) => c.title === 'In-Editor Chapter'),
      editorMounted: !!editable,
      openTitle: headerTitle ? (headerTitle.textContent || '').trim() : null,
    };
  })()`);
  record(
    'create: new chapter can be created in-editor and opens immediately as a writable chapter',
    newChapterClicked === true && submitClicked === true && afterCreate?.count === beforeCount + 1 &&
      afterCreate?.hasNew === true && afterCreate?.editorMounted === true,
    JSON.stringify({ beforeCount, ...afterCreate }),
  );

  // ---- Cleanup ----
  const cleaned = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    const { projectId } = JSON.parse(localStorage.getItem('n87-wsui'));
    await svc.projectService.deleteProject(projectId);
    return true;
  })()`);
  record('cleanup: project deleted', cleaned === true, String(cleaned));

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
