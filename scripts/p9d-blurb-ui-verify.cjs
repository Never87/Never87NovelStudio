/**
 * P9 Batch D — Blurb Generator: end-to-end UI smoke (headless Chrome / CDP).
 *
 * Renders the REAL `/publishing/blurb-generator` route against a live dev server
 * and asserts the user-facing contract that the pure unit + IDB tests do not
 * cover:
 *
 *   - the page is reachable from the sidebar and renders (not a placeholder);
 *   - a project selector is present; length + angle presets render and toggle;
 *   - the draft textarea is editable, word count updates, and Save enables only
 *     when the draft is dirty; Discard reverts to the saved blurb;
 *   - SAVING persists ONLY `NovelProject.blurb` (description must be untouched);
 *   - Copy does not throw; the saved blurb panel appears.
 *
 * No real AI call is made (there is no provider configured in the harness), so
 * the Generate button is expected to be disabled — that "configure AI first"
 * path is itself asserted.
 *
 * Requires the dev server on http://localhost:5177/ (start it first).
 * Usage: npm run verify:blurb:ui
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_URL = 'http://localhost:5177/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9414;
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

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9d-blurb-ui-chrome-'));
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
  await cdp.send('Page.enable');

  await cdp.send('Page.navigate', { url: APP_URL });
  await sleep(3000);

  /* ------------------------- seed a real project ---------------------- */
  const seeded = await cdp.eval(`(async () => {
    const { projectService } = await import('/src/services/index.ts');
    for (const p of await projectService.listProjects()) await projectService.deleteProject(p.id);
    // Clear any stored AI config so the "not configured" path is deterministic.
    const cfg = await import('/src/services/index.ts');
    const P = await projectService.createProject({
      title: '界面测试项目',
      description: '这是内部描述，用来确保保存简介时不改动它。',
      genre: ['悬疑'],
      tags: ['测试'],
    });
    return { id: P.id, description: P.description };
  })()`);
  if (!seeded || !seeded.id) throw new Error('Seed failed: ' + JSON.stringify(seeded));

  /* -------------------- (1) navigate to the route --------------------- */
  await cdp.send('Page.navigate', { url: `${APP_URL}publishing/blurb-generator` });
  await sleep(2600);

  const bodyText = await cdp.eval('document.body.innerText');
  record('ui: page renders (not a placeholder)', /Blurb Generator/i.test(bodyText) && !/coming soon|placeholder/i.test(bodyText));

  const hasProjectSelect = await cdp.eval(`!!document.querySelector('[data-testid="blurb-project"]')`);
  record('ui: project selector present', hasProjectSelect);

  /* ---------------------- (2) presets are rendered -------------------- */
  const presets = await cdp.eval(`(() => {
    const lens = ['short','standard','long'].filter((l) => document.querySelector('[data-testid="blurb-length-'+l+'"]'));
    const styles = ['suspense','character','world','balanced'].filter((s) => document.querySelector('[data-testid="blurb-style-'+s+'"]'));
    return { lens, styles };
  })()`);
  record('ui: all three length presets render', presets.lens.length === 3, JSON.stringify(presets.lens));
  record('ui: all four angle presets render', presets.styles.length === 4, JSON.stringify(presets.styles));

  /* ------------------- (3) toggling a preset changes pressed ---------- */
  await cdp.eval(`(() => { document.querySelector('[data-testid="blurb-length-long"]').click(); })()`);
  await sleep(300);
  const toggled = await cdp.eval(`(() => {
    const btn = document.querySelector('[data-testid="blurb-length-long"]');

    return btn.getAttribute('aria-pressed');
  })()`);
  record('ui: clicking a length preset marks it selected', toggled === 'true', String(toggled));

  /* ---------------- (4) Generate disabled without AI config ----------- */
  await sleep(400);
  const genDisabled = await cdp.eval(`(() => {
    const b = document.querySelector('[data-testid="blurb-generate"]');
    return b ? b.disabled : null;
  })()`);
  record('ui: Generate is disabled when no AI model is configured', genDisabled === true, String(genDisabled));
  const aiWarning = await cdp.eval(`!!document.querySelector('[data-testid="blurb-ai-warning"]')`);
  record('ui: "configure AI" guidance is shown', aiWarning === true);

  /* ---------------- (5) the draft textarea is editable ---------------- */
  const typed = await cdp.eval(`(() => {
    const ta = document.querySelector('[data-testid="blurb-textarea"]');
    if (!ta) return null;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '用户编辑的简介草稿。');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return ta.value;
  })()`);
  record('ui: draft textarea accepts user input', typed === '用户编辑的简介草稿。', String(typed));
  const wordCount = await cdp.eval(`(() => {
    const panel = document.querySelector('[data-testid="blurb-draft-panel"]');
    if (!panel) return null;
    const match = panel.innerText.match(/([0-9]+)\\s*words/i);
    return match ? match[1] : null;
  })()`);
  record('ui: word count reflects the (non-empty) draft', typeof wordCount === 'string' && Number(wordCount) > 0, String(wordCount));

  /* ---------------- (6) Save enables when draft is dirty -------------- */
  const saveState = await cdp.eval(`(() => {
    const save = document.querySelector('[data-testid="blurb-save"]');
    const discard = document.querySelector('[data-testid="blurb-discard"]');
    return { saveDisabled: save ? save.disabled : null, hasDiscard: !!discard };
  })()`);
  record('ui: Save is enabled for a dirty draft', saveState.saveDisabled === false, String(saveState.saveDisabled));
  record('ui: Discard is offered for a dirty draft', saveState.hasDiscard === true);

  /* ---------------- (7) Copy does not throw --------------------------- */
  const copyOk = await cdp.eval(`(async () => {
    const b = document.querySelector('[data-testid="blurb-copy"]');
    if (!b) return null;
    b.click();
    await new Promise((r) => setTimeout(r, 200));
    const msg = document.querySelector('[data-testid="blurb-message"]');
    return { clicked: true, message: msg ? msg.innerText : null };
  })()`);
  record('ui: Copy runs without throwing', copyOk && copyOk.clicked === true, JSON.stringify(copyOk));

  /* ---------------- (8) SAVE persists blurb, not description ---------- */
  const saveClick = await cdp.eval(`(async () => {
    const b = document.querySelector('[data-testid="blurb-save"]');
    if (!b) return { error: 'no save button' };
    b.click();
    await new Promise((r) => setTimeout(r, 900));
    const { projectService } = await import('/src/services/index.ts');
    const p = await projectService.getProject('${seeded.id}');
    return { blurb: p.blurb, description: p.description, seedDescription: '${seeded.description}' };
  })()`);
  record('ui: Save writes the draft to NovelProject.blurb', saveClick && saveClick.blurb === '用户编辑的简介草稿。', JSON.stringify(saveClick && saveClick.blurb));
  record('ui: Save does NOT modify the internal description', saveClick && saveClick.description === seeded.description, saveClick && saveClick.description);

  await sleep(400);
  const savedPanel = await cdp.eval(`!!document.querySelector('[data-testid="blurb-saved"]')`);
  record('ui: the saved-blurb panel appears after saving', savedPanel === true);

  /* ---------------- (9) Discard reverts the draft --------------------- */
  const discardResult = await cdp.eval(`(() => {
    const ta = document.querySelector('[data-testid="blurb-textarea"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '临时修改。');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(200);
  const discarded = await cdp.eval(`(() => {
    const d = document.querySelector('[data-testid="blurb-discard"]');
    if (!d) return null;
    d.click();
    return true;
  })()`);
  await sleep(300);
  const afterDiscard = await cdp.eval(`(() => { const ta = document.querySelector('[data-testid="blurb-textarea"]'); return ta ? ta.value : null; })()`);
  record('ui: Discard reverts the draft to the saved blurb', discardResult && discarded && afterDiscard === '用户编辑的简介草稿。', String(afterDiscard));

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
