/**
 * P2-B UI smoke test: real browser, real DOM, real app routes.
 *
 * Creates a project through the service layer, then drives the actual UI:
 *   project detail -> "Narrative" tab -> empty state -> create dialog ->
 *   fill fields -> save -> verify rendered plan -> reload -> still rendered.
 *
 * Usage: npm run verify:narrative:ui
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_URL = 'http://localhost:5177/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9335;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const t0 = Date.now();
function stage(label, extra) {
  const elapsed = String(Date.now() - t0).padStart(6, ' ');
  console.log(`[${elapsed}ms] STAGE: ${label}${extra ? '  ' + extra : ''}`);
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
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
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
  try { if (activeWs) activeWs.close(); } catch { /* ignore */ }
  try {
    if (activeChrome && activeChrome.exitCode === null && !activeChrome.killed) {
      activeChrome.kill('SIGKILL');
    }
  } catch { /* ignore */ }
  try {
    if (activeProfileDir && fs.existsSync(activeProfileDir)) {
      fs.rmSync(activeProfileDir, { recursive: true, force: true });
    }
  } catch { /* ignore */ }
  stage('teardown complete');
}

process.on('exit', teardown);
process.on('SIGINT', () => { teardown(); process.exit(130); });
process.on('SIGTERM', () => { teardown(); process.exit(143); });

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2bui-chrome-'));
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
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const pageErrors = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params.exceptionDetails?.exception?.description || 'unknown');
    }
  });

  const results = [];
  const record = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
  };

  stage('navigating to app');
  await cdp.send('Page.navigate', { url: APP_URL });
  await sleep(3500);

  // Seed a project via the real service layer.
  const seed = await cdp.eval(`(async () => {
    const dbMod = await import('/src/db/index.ts');
    const svc = await import('/src/services/index.ts');
    await dbMod.initDatabase();
    const p = await svc.projectService.createProject({ title: 'UI Narrative Project' });
    localStorage.setItem('n87-p2bui-project', p.id);
    return { id: p.id };
  })()`);
  record('预置测试项目', typeof seed.id === 'string' && seed.id.length > 0, seed.id);

  // Navigate to the project detail page.
  stage('navigating to project detail');
  await cdp.send('Page.navigate', { url: `${APP_URL}#/projects/${seed.id}` });
  await cdp.send('Runtime.evaluate', {
    expression: `location.hash = ''; history.pushState(null, '', '/projects/${seed.id}'); window.dispatchEvent(new PopStateEvent('popstate'));`,
    awaitPromise: true,
  });
  await sleep(2500);

  // Wait for the page to render the project title.
  const detailRendered = await cdp.eval(`(async () => {
    for (let i = 0; i < 40; i++) {
      if (document.body.innerText.includes('UI Narrative Project')) return true;
      await new Promise(r => setTimeout(r, 150));
    }
    return false;
  })()`);
  record('项目详情页渲染', detailRendered === true, `url=${await cdp.eval('location.pathname')}`);

  // The Narrative tab must exist in the tab bar.
  const hasNarrativeTab = await cdp.eval(`(() => {
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    return { labels: tabs.map(t => t.textContent.trim()), found: tabs.some(t => t.textContent.trim() === 'Narrative') };
  })()`);
  record(
    '详情页存在 Narrative 标签页',
    hasNarrativeTab?.found === true,
    `tabs=${JSON.stringify(hasNarrativeTab?.labels)}`,
  );

  // Click it.
  const clicked = await cdp.eval(`(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find(t => t.textContent.trim() === 'Narrative');
    if (!tab) return false;
    tab.click();
    return true;
  })()`);
  record('点击 Narrative 标签', clicked === true);

  // Empty state with a create CTA.
  const emptyState = await cdp.eval(`(async () => {
    for (let i = 0; i < 40; i++) {
      const text = document.body.innerText;
      if (text.includes('No narrative plan yet')) {
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Create narrative plan'));
        return { shown: true, hasCta: !!btn };
      }
      await new Promise(r => setTimeout(r, 150));
    }
    return { shown: false, hasCta: false };
  })()`);
  record(
    '未创建时显示空状态与「Create narrative plan」按钮',
    emptyState?.shown === true && emptyState?.hasCta === true,
    JSON.stringify(emptyState),
  );

  // Open the dialog.
  await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Create narrative plan'));
    btn && btn.click();
    return true;
  })()`);
  await sleep(600);

  const dialogOpen = await cdp.eval(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return { open: false };
    return {
      open: true,
      title: dlg.innerText.split('\\n')[0],
      hasLogline: !!dlg.querySelector('input'),
      hasStructure: !!dlg.querySelector('select'),
      textareas: dlg.querySelectorAll('textarea').length,
    };
  })()`);
  record(
    '创建对话框打开（含 logline 输入、结构/状态下拉、多行文本域）',
    dialogOpen?.open === true &&
      dialogOpen?.hasLogline === true &&
      dialogOpen?.hasStructure === true &&
      dialogOpen?.textareas >= 4,
    JSON.stringify(dialogOpen),
  );

  // Fill the form via native React-compatible setters.
  const filled = await cdp.eval(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const setValue = (el, value) => {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const inputs = [...dlg.querySelectorAll('input')];
    const areas = [...dlg.querySelectorAll('textarea')];

    // Logline is the first text input.
    setValue(inputs[0], 'A cartographer maps a city that moves each night.');

    // Structure -> save-the-cat, Status -> in-progress.
    const selects = [...dlg.querySelectorAll('select')];
    const setSelect = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setSelect(selects[0], 'save-the-cat');
    setSelect(selects[1], 'in-progress');

    // Textareas in order: premise(0), theme(1), conflict(2), stakes(3), ending(4), motifs is input.
    setValue(areas[0], 'A city rewrites its streets nightly.');
    setValue(areas[1], 'Home is something you keep making.');
    setValue(areas[2], 'The mapmaker cannot leave.');
    setValue(areas[3], 'Lose the city, lose her sister.');
    setValue(areas[4], 'She burns her own atlas.');

    return {
      logline: inputs[0].value,
      structure: selects[0].value,
      status: selects[1].value,
      premise: areas[0].value,
    };
  })()`);
  record(
    '表单填写生效（受控输入被更新）',
    filled?.logline?.startsWith('A cartographer') &&
      filled?.structure === 'save-the-cat' &&
      filled?.status === 'in-progress' &&
      filled?.premise?.startsWith('A city rewrites'),
    JSON.stringify(filled),
  );

  // Apply the structure preset -> beats should appear.
  await cdp.eval(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const btn = [...dlg.querySelectorAll('button')].find(b => b.textContent.includes('Use preset'));
    btn && btn.click();
    return true;
  })()`);
  await sleep(400);
  const presetApplied = await cdp.eval(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const beatInputs = [...dlg.querySelectorAll('input[aria-label$="title"]')];
    return { beats: beatInputs.length, first: beatInputs[0]?.value, second: beatInputs[1]?.value };
  })()`);
  record(
    '「Use preset」按结构生成节拍（Save the Cat = 15 个）',
    presetApplied?.beats === 15 &&
      presetApplied?.first === 'Opening Image' &&
      presetApplied?.second === 'Theme Stated',
    `beats=${presetApplied?.beats} first=${presetApplied?.first}`,
  );

  // Submit.
  stage('submitting dialog');
  await cdp.eval(`(() => {
    const submit = document.querySelector('button[form="narrative-form"]');
    submit && submit.click();
    return true;
  })()`);

  const saved = await cdp.eval(`(async () => {
    for (let i = 0; i < 60; i++) {
      const dlg = document.querySelector('[role="dialog"]');
      const text = document.body.innerText;
      if (!dlg && text.includes('A cartographer maps a city')) {
        return { closed: true, rendered: true, beatsShown: text.includes('Beat timeline'), hasFifteen: /15 beats/.test(text) };
      }
      await new Promise(r => setTimeout(r, 150));
    }
    const dlg = document.querySelector('[role="dialog"]');
    return { closed: !dlg, rendered: false, dialogText: dlg ? dlg.innerText.slice(0, 300) : null };
  })()`);
  record(
    '保存后对话框关闭且规划渲染（logline、Beat timeline、15 beats）',
    saved?.closed === true && saved?.rendered === true && saved?.beatsShown === true && saved?.hasFifteen === true,
    JSON.stringify(saved),
  );

  // Verify persisted via the data layer.
  const persisted = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    const id = localStorage.getItem('n87-p2bui-project');
    const plan = await svc.narrativeService.getPlan(id);
    return plan ? {
      logline: plan.logline, structure: plan.structure, status: plan.status, beats: plan.beats.length,
      premise: plan.premise, ending: plan.ending,
    } : null;
  })()`);
  record(
    '数据层确认已持久化（结构/状态/15 节拍/文本）',
    persisted?.structure === 'save-the-cat' &&
      persisted?.status === 'in-progress' &&
      persisted?.beats === 15 &&
      persisted?.premise === 'A city rewrites its streets nightly.' &&
      persisted?.ending === 'She burns her own atlas.',
    JSON.stringify(persisted),
  );

  // Reload: the Narrative tab should still render the plan (tab state resets, click again).
  await cdp.send('Page.reload');
  await sleep(3500);
  await cdp.eval(`(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find(t => t.textContent.trim() === 'Narrative');
    tab && tab.click();
    return true;
  })()`);
  const afterReload = await cdp.eval(`(async () => {
    for (let i = 0; i < 50; i++) {
      const text = document.body.innerText;
      if (text.includes('A cartographer maps a city')) {
        return { rendered: true, hasEmptyState: text.includes('No narrative plan yet') };
      }
      await new Promise(r => setTimeout(r, 150));
    }
    return { rendered: false, hasEmptyState: document.body.innerText.includes('No narrative plan yet') };
  })()`);
  record(
    '刷新后重新打开 Narrative 标签，规划依然渲染（非空状态）',
    afterReload?.rendered === true && afterReload?.hasEmptyState === false,
    JSON.stringify(afterReload),
  );

  // Cleanup through the real cascade.
  const cleaned = await cdp.eval(`(async () => {
    const dbMod = await import('/src/db/index.ts');
    const svc = await import('/src/services/index.ts');
    const id = localStorage.getItem('n87-p2bui-project');
    await svc.projectService.deleteProject(id);
    return {
      plans: await dbMod.db.narrativePlans.where('projectId').equals(id).count(),
    };
  })()`);
  record('清理测试数据', cleaned?.plans === 0, JSON.stringify(cleaned));

  record('运行期无未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

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
