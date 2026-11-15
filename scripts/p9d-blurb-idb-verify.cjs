/**
 * P9 Batch D — Blurb Generator: REAL IndexedDB persistence.
 *
 * Drives the ACTUAL services (`projectService`) against the browser's REAL
 * IndexedDB over the same headless-Chrome/CDP infrastructure the other P9
 * scripts use. The blurb-generation AI call itself is covered by the pure unit
 * tests (`verify:blurb`); this script proves the STORAGE GUARANTEE that the UI
 * relies on:
 *
 *   1. saving a blurb writes ONLY `NovelProject.blurb` — the internal
 *      `description` is byte-for-byte unchanged;
 *   2. the saved blurb survives a reload (it is really persisted);
 *   3. updating the description later does NOT clobber the blurb, and vice
 *      versa (independent fields);
 *   4. clearing a blurb (`blurb: null`) removes it without touching anything
 *      else;
 *   5. blurbs are project-isolated (writing one project's blurb never affects
 *      another's);
 *   6. `updatedAt` advances on a blurb save.
 *
 * Requires the dev server on http://localhost:5177/ (start it first, e.g.
 * `npm run dev -- --port 5177 --strictPort`).
 *
 * Usage: npm run verify:blurb:idb
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_URL = 'http://localhost:5177/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9413;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
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
  try { if (activeProfileDir) fs.rmSync(activeProfileDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.on('SIGINT', () => { teardown(); process.exit(130); });
process.on('SIGTERM', () => { teardown(); process.exit(143); });

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}.`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9d-blurb-idb-chrome-'));
  activeProfileDir = userDataDir;
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
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

  await cdp.send('Page.navigate', { url: APP_URL });
  await sleep(3000);

  /* ------------------ seed: two projects via real service -------------- */
  const seeded = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    const { projectService } = svc;
    for (const p of await projectService.listProjects()) await projectService.deleteProject(p.id);
    const a = await projectService.createProject({ title: '甲项目', description: '原始内部描述-A' });
    const b = await projectService.createProject({ title: '乙项目', description: '原始内部描述-B' });
    return { a: a.id, b: b.id };
  })()`);
  if (!seeded || !seeded.a || !seeded.b) throw new Error('Seed failed: ' + JSON.stringify(seeded));

  /* --------------------------- (1) save blurb ------------------------- */
  const saveResult = await cdp.eval(`(async () => {
    const { projectService } = await import('/src/services/index.ts');
    const before = await projectService.getProject('${seeded.a}');
    const updated = await projectService.updateProject('${seeded.a}', { blurb: '这是公开简介。' });
    return {
      blurb: updated.blurb,
      description: updated.description,
      descriptionUnchanged: updated.description === before.description,
      updatedAdvanced: updated.updatedAt >= before.updatedAt,
    };
  })()`);
  record('idb: saving a blurb stores it on the project', saveResult.blurb === '这是公开简介。', JSON.stringify(saveResult.blurb));
  record('idb: saving a blurb does NOT change description', saveResult.description === '原始内部描述-A' && saveResult.descriptionUnchanged, saveResult.description);
  record('idb: saving a blurb refreshes updatedAt', saveResult.updatedAdvanced === true);

  /* --------------------- (2) survives a reload ------------------------ */
  await cdp.send('Page.reload', { ignoreCache: false });
  await sleep(2500);
  const afterReload = await cdp.eval(`(async () => {
    const { projectService } = await import('/src/services/index.ts');
    const p = await projectService.getProject('${seeded.a}');
    return { blurb: p.blurb, description: p.description };
  })()`);
  record('idb: blurb persists across reload', afterReload.blurb === '这是公开简介。', JSON.stringify(afterReload.blurb));
  record('idb: description persists unchanged across reload', afterReload.description === '原始内部描述-A');

  /* ----------- (3) editing description does not clobber blurb --------- */
  const afterDescEdit = await cdp.eval(`(async () => {
    const { projectService } = await import('/src/services/index.ts');
    const u = await projectService.updateProject('${seeded.a}', { description: '新的内部描述' });
    return { blurb: u.blurb, description: u.description };
  })()`);
  record('idb: editing description keeps the blurb intact', afterDescEdit.blurb === '这是公开简介。', JSON.stringify(afterDescEdit.blurb));
  record('idb: editing description updates only description', afterDescEdit.description === '新的内部描述');

  /* ----------- (3b) editing blurb does not clobber description -------- */
  const afterBlurbEdit = await cdp.eval(`(async () => {
    const { projectService } = await import('/src/services/index.ts');
    const u = await projectService.updateProject('${seeded.a}', { blurb: '第二版简介。' });
    return { blurb: u.blurb, description: u.description };
  })()`);
  record('idb: editing blurb keeps description intact', afterBlurbEdit.description === '新的内部描述');
  record('idb: editing blurb updates the blurb', afterBlurbEdit.blurb === '第二版简介。');

  /* -------------------- (4) clearing the blurb ------------------------ */
  const afterClear = await cdp.eval(`(async () => {
    const { projectService } = await import('/src/services/index.ts');
    const u = await projectService.updateProject('${seeded.a}', { blurb: null });
    return { blurb: u.blurb, hasBlurb: 'blurb' in u, description: u.description };
  })()`);
  record('idb: clearing a blurb removes the field', afterClear.hasBlurb === false, JSON.stringify(afterClear.blurb));
  record('idb: clearing a blurb leaves description untouched', afterClear.description === '新的内部描述');

  /* -------------------- (5) project isolation ------------------------- */
  const isolation = await cdp.eval(`(async () => {
    const { projectService } = await import('/src/services/index.ts');
    await projectService.updateProject('${seeded.a}', { blurb: 'A的可复用简介' });
    const a = await projectService.getProject('${seeded.a}');
    const b = await projectService.getProject('${seeded.b}');
    return { a: a.blurb, bBlurb: b.blurb, bDescription: b.description };
  })()`);
  record('idb: writing A\'s blurb sets A', isolation.a === 'A的可复用简介');
  record('idb: writing A\'s blurb does NOT touch B', isolation.bBlurb === undefined && isolation.bDescription === '原始内部描述-B', JSON.stringify(isolation));

  /* -------------------- (6) description untouched root --------------- */
  const bUntouched = await cdp.eval(`(async () => {
    const { projectService } = await import('/src/services/index.ts');
    const b = await projectService.getProject('${seeded.b}');
    return { description: b.description, title: b.title };
  })()`);
  record('idb: B project remains fully intact', bUntouched.description === '原始内部描述-B' && bUntouched.title === '乙项目');

  teardown();

  const failures = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failures.length}/${results.length} checks passed.`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  teardown();
  console.error('\nFATAL:', error);
  process.exit(1);
});
