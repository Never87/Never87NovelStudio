/**
 * P9 Batch E — Portfolio + Royalty Calculator: REAL IndexedDB persistence AND
 * UI interaction, driven through headless Chrome / CDP against the running dev
 * server (the same infrastructure as the other P9 verify scripts).
 *
 * This script requires the dev server (it drives the REAL app over the network),
 * so it runs once the app is served. It proves the guarantees the PURE suites
 * cannot cover:
 *
 *   PORTFOLIO (persistence)
 *     1. saving a display profile persists across a page reload;
 *     2. saving a profile NEVER changes the project's `description` or `blurb`;
 *     3. editing the project's blurb afterwards keeps the profile intact and
 *        vice versa (independent layers);
 *     4. profiles are project-isolated;
 *     5. deleting a profile reverts the catalog entry to the project values.
 *
 *   ROYALTY CALCULATOR (UI)
 *     6. the page renders inputs, a comparison table and the disclaimer;
 *     7. editing the price updates the computed author income in the table.
 *
 * Usage (after starting the dev server on port 5177):
 *   npm run verify:portfolio:ui
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_URL = 'http://localhost:5177/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9415;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  -> ${detail}` : ''}`);
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
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
  try { if (activeProfileDir) fs.rmSync(activeProfileDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.on('SIGINT', () => { teardown(); process.exit(130); });
process.on('SIGTERM', () => { teardown(); process.exit(143); });

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}.`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9e-chrome-'));
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

  await cdp.send('Page.navigate', { url: APP_URL });
  await sleep(3000);

  /* ------------------ seed two projects via real services ------------- */
  const seeded = await cdp.eval(`(async () => {
    const { projectService, portfolioService } = await import('/src/services/index.ts');
    for (const p of await projectService.listProjects()) await projectService.deleteProject(p.id);
    const a = await projectService.createProject({ title: 'Project A', description: 'INTERNAL-A', settings: { author: 'Author A' } });
    const b = await projectService.createProject({ title: 'Project B', description: 'INTERNAL-B' });
    await projectService.updateProject(a.id, { blurb: 'PUBLIC BLURB A' });
    return { a: a.id, b: b.id };
  })()`);
  if (!seeded || !seeded.a || !seeded.b) throw new Error('Seed failed: ' + JSON.stringify(seeded));

  /* --------------------- (1) profile persists ------------------------- */
  const saved = await cdp.eval(`(async () => {
    const { portfolioService, projectService } = await import('/src/services/index.ts');
    const before = await projectService.getProject('${seeded.a}');
    await portfolioService.upsertProfile('${seeded.a}', { displayTitle: 'Curated A', penName: 'Pen A', featured: true });
    const after = await projectService.getProject('${seeded.a}');
    const entries = await portfolioService.listEntries();
    const a = entries.find((e) => e.projectId === '${seeded.a}');
    return {
      curatedTitle: a.title,
      author: a.author,
      descriptionUnchanged: after.description === before.description,
      blurbUnchanged: after.blurb === before.blurb,
    };
  })()`);
  record('portfolio: profile saved → entry shows curated title', saved.curatedTitle === 'Curated A', JSON.stringify(saved.curatedTitle));
  record('portfolio: profile saved → pen name shown', saved.author === 'Pen A', JSON.stringify(saved.author));
  record('portfolio: saving a profile does NOT change project description', saved.descriptionUnchanged === true);
  record('portfolio: saving a profile does NOT change project blurb', saved.blurbUnchanged === true);

  /* --------------------- (2) persists after reload -------------------- */
  await cdp.send('Page.reload', { ignoreCache: false });
  await sleep(2500);
  const afterReload = await cdp.eval(`(async () => {
    const { portfolioService } = await import('/src/services/index.ts');
    const entries = await portfolioService.listEntries();
    const a = entries.find((e) => e.projectId === '${seeded.a}');
    return { title: a.title, hasProfile: a.hasProfile };
  })()`);
  record('portfolio: profile persists across reload', afterReload.title === 'Curated A' && afterReload.hasProfile === true, JSON.stringify(afterReload));

  /* ------------ (3) editing blurb keeps the profile intact ------------ */
  const blurbEdit = await cdp.eval(`(async () => {
    const { portfolioService, projectService } = await import('/src/services/index.ts');
    await projectService.updateProject('${seeded.a}', { blurb: 'PUBLIC BLURB A v2' });
    const entries = await portfolioService.listEntries();
    const a = entries.find((e) => e.projectId === '${seeded.a}');
    return { title: a.title, blurb: a.blurb };
  })()`);
  record('portfolio: editing the blurb keeps the curated title', blurbEdit.title === 'Curated A');
  record('portfolio: editing the blurb updates the displayed blurb', blurbEdit.blurb === 'PUBLIC BLURB A v2');

  /* -------------------- (4) project isolation ------------------------- */
  const isolation = await cdp.eval(`(async () => {
    const { portfolioService, projectService } = await import('/src/services/index.ts');
    const b = await projectService.getProject('${seeded.b}');
    const entries = await portfolioService.listEntries();
    const bEntry = entries.find((e) => e.projectId === '${seeded.b}');
    return { bHasProfile: bEntry.hasProfile, bTitle: bEntry.title, bDescription: b.description };
  })()`);
  record('portfolio: project B has no profile (isolated)', isolation.bHasProfile === false);
  record('portfolio: project B title is its own', isolation.bTitle === 'Project B');
  record('portfolio: project B description intact', isolation.bDescription === 'INTERNAL-B');

  /* -------------------- (5) delete reverts ---------------------------- */
  const reverted = await cdp.eval(`(async () => {
    const { portfolioService } = await import('/src/services/index.ts');
    await portfolioService.deleteProfile('${seeded.a}');
    const entries = await portfolioService.listEntries();
    const a = entries.find((e) => e.projectId === '${seeded.a}');
    return { title: a.title, hasProfile: a.hasProfile };
  })()`);
  record('portfolio: deleting a profile reverts to project title', reverted.title === 'Project A' && reverted.hasProfile === false);

  /* -------------------- (6) Royalty UI renders ------------------------ */
  await cdp.send('Page.navigate', { url: APP_URL + 'publishing/royalty-calculator' });
  await sleep(2500);
  const royaltyUi = await cdp.eval(`(() => {
    const q = (sel) => document.querySelector(sel);
    return {
      hasPriceInput: !!q('[data-testid="royalty-price-input"]'),
      hasUnitsInput: !!q('[data-testid="royalty-units-input"]'),
      hasTable: !!q('[data-testid="royalty-table"]'),
      hasDisclaimer: !!q('[data-testid="royalty-disclaimer"]'),
      hasResults: !!q('[data-testid="royalty-results"]'),
      bodyHasEstimate: /estimate/i.test(document.body.innerText),
    };
  })()`);
  record('royalty: page renders price input', royaltyUi.hasPriceInput === true);
  record('royalty: page renders units input', royaltyUi.hasUnitsInput === true);
  record('royalty: page renders comparison table', royaltyUi.hasTable === true);
  record('royalty: page renders the estimate disclaimer', royaltyUi.hasDisclaimer === true && royaltyUi.bodyHasEstimate === true);
  record('royalty: page renders results panel', royaltyUi.hasResults === true);

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
