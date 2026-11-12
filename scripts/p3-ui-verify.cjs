/**
 * P3 UI smoke test: real browser, real DOM, real app routes.
 *
 * Drives the actual Outline tab end to end:
 *   project detail -> "Outline" tab -> empty state -> create volume ->
 *   add chapter (linked to a narrative beat) -> expand chapter -> add scene ->
 *   verify rendering -> reload -> still rendered -> cascade cleanup.
 *
 * Usage: npm run verify:outline:ui
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_URL = 'http://localhost:5177/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9337;

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
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3ui-chrome-'));
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

  // Seed: project + narrative plan with beats (so the chapter beat picker is testable).
  const seed = await cdp.eval(`(async () => {
    const dbMod = await import('/src/db/index.ts');
    const svc = await import('/src/services/index.ts');
    await dbMod.initDatabase();
    const p = await svc.projectService.createProject({ title: 'Outline UI Project' });
    const plan = await svc.narrativeService.createPlan(p.id, {
      logline: 'A keeper hunts the sea.',
      beats: [
        { title: 'Opening Image', description: 'The world before.', position: 0 },
        { title: 'Inciting Incident', description: 'The call to adventure.', position: 20 },
      ],
    });
    localStorage.setItem('n87-p3ui-project', p.id);
    return { id: p.id, beats: plan.beats.map(b => ({ id: b.id, title: b.title })) };
  })()`);
  record('预置项目与叙事节拍', typeof seed.id === 'string' && seed.beats?.length === 2, `${seed.id} beats=${seed.beats?.length}`);

  stage('navigating to project detail');
  await cdp.send('Page.navigate', { url: `${APP_URL}#/projects/${seed.id}` });
  await cdp.eval(`(() => {
    history.pushState(null, '', '/projects/${seed.id}');
    window.dispatchEvent(new PopStateEvent('popstate'));
    return true;
  })()`);
  await sleep(2500);

  const detailRendered = await cdp.eval(`(async () => {
    for (let i = 0; i < 40; i++) {
      if (document.body.innerText.includes('Outline UI Project')) return true;
      await new Promise(r => setTimeout(r, 150));
    }
    return false;
  })()`);
  record('项目详情页渲染', detailRendered === true, `path=${await cdp.eval('location.pathname')}`);

  const tabs = await cdp.eval(`(() => {
    const items = [...document.querySelectorAll('[role="tab"]')];
    return { labels: items.map(t => t.textContent.trim()), found: items.some(t => t.textContent.trim() === 'Outline') };
  })()`);
  record('详情页存在 Outline 标签页', tabs?.found === true, `tabs=${JSON.stringify(tabs?.labels)}`);

  await cdp.eval(`(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find(t => t.textContent.trim() === 'Outline');
    if (tab) tab.click();
    return true;
  })()`);
  record('点击 Outline 标签', true);

  const emptyState = await cdp.eval(`(async () => {
    for (let i = 0; i < 40; i++) {
      const text = document.body.innerText;
      if (text.includes('No outline yet')) {
        return {
          shown: true,
          hasCta: [...document.querySelectorAll('button')].some(b => b.textContent.includes('Create your first volume')),
        };
      }
      await new Promise(r => setTimeout(r, 150));
    }
    return { shown: false, hasCta: false };
  })()`);
  record('未创建时显示空状态与「Create your first volume」', emptyState?.shown === true && emptyState?.hasCta === true, JSON.stringify(emptyState));

  // ---- Create a volume through the dialog ----
  await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Create your first volume'));
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(600);

  const volumeDialog = await cdp.eval(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return { open: false };
    return { open: true, title: dlg.innerText.split('\\n')[0], inputs: dlg.querySelectorAll('input').length };
  })()`);
  record('创建卷对话框打开', volumeDialog?.open === true && volumeDialog?.title === 'New volume', JSON.stringify(volumeDialog));

  await cdp.eval(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const setValue = (el, value) => {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setValue(dlg.querySelector('input'), 'Book One');
    setValue(dlg.querySelector('textarea'), 'Opening arc.');
    return true;
  })()`);
  await cdp.eval(`(() => {
    document.querySelector('button[form="volume-form"]')?.click();
    return true;
  })()`);

  const volumeSaved = await cdp.eval(`(async () => {
    for (let i = 0; i < 50; i++) {
      if (!document.querySelector('[role="dialog"]') && document.body.innerText.includes('Book One')) {
        return { ok: true, hasAddChapter: [...document.querySelectorAll('button')].some(b => b.textContent.includes('Add chapter')) };
      }
      await new Promise(r => setTimeout(r, 150));
    }
    return { ok: false, text: document.body.innerText.slice(0, 300) };
  })()`);
  record('保存后卷渲染并出现「Add chapter」', volumeSaved?.ok === true && volumeSaved?.hasAddChapter === true, JSON.stringify(volumeSaved));

  // ---- Create a chapter linked to a beat ----
  await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add chapter');
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(600);

  const chapterDialog = await cdp.eval(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return { open: false };
    const selects = [...dlg.querySelectorAll('select')];
    const beatSelect = selects.find(s => [...s.options].some(o => o.textContent.includes('Opening Image')));
    return {
      open: true,
      title: dlg.innerText.split('\\n')[0],
      hasBeatPicker: !!beatSelect,
      beatOptions: beatSelect ? [...beatSelect.options].map(o => o.textContent.trim()) : [],
    };
  })()`);
  record(
    '章节对话框提供节拍选择器（选项来自 Narrative 节拍标题）',
    chapterDialog?.open === true &&
      chapterDialog?.title === 'New chapter' &&
      chapterDialog?.hasBeatPicker === true &&
      chapterDialog?.beatOptions?.some((o) => o.includes('Opening Image')) &&
      chapterDialog?.beatOptions?.some((o) => o.includes('Inciting Incident')),
    JSON.stringify(chapterDialog?.beatOptions),
  );

  await cdp.eval(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const setValue = (el, value) => {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const setSelect = (el, value) => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };

    setValue(dlg.querySelector('input'), 'The Lighthouse');
    const selects = [...dlg.querySelectorAll('select')];
    const beatSelect = selects.find(s => [...s.options].some(o => o.textContent.includes('Opening Image')));
    const beatOption = [...beatSelect.options].find(o => o.textContent.includes('Opening Image'));
    setSelect(beatSelect, beatOption.value);

    // Resolve controls by their <label> text instead of DOM position.
    const byLabel = (name, tag) => {
      const labels = [...dlg.querySelectorAll('label')];
      const text = (el) => el.textContent.trim().split('*')[0].trim();
      const label = labels.find(l => text(l) === name);
      const id = label && label.getAttribute('for');
      const el = id ? document.getElementById(id) : null;
      return el && (!tag || el.tagName === tag) ? el : null;
    };

    setValue(byLabel('Title', 'INPUT'), 'The Lighthouse');
    setValue(byLabel('Summary', 'INPUT'), 'One line summary.');
    setValue(byLabel('Goal', 'TEXTAREA'), 'Establish the keeper.');
    return {
      beatId: beatOption.value,
      summary: byLabel('Summary', 'INPUT').value,
      goal: byLabel('Goal', 'TEXTAREA').value,
    };
  })()`);

  // The selected beat's preview must be rendered from the beat itself.
  const beatPreview = await cdp.eval(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    return {
      preview: dlg.innerText.includes('The world before.'),
      hint: dlg.innerText.includes('Beat details live in the Narrative tab'),
    };
  })()`);
  record('选中节拍后显示源自 Narrative 的预览与提示', beatPreview?.preview === true && beatPreview?.hint === true, JSON.stringify(beatPreview));

  await cdp.eval(`(() => {
    document.querySelector('button[form="chapter-form"]')?.click();
    return true;
  })()`);

  const chapterSaved = await cdp.eval(`(async () => {
    for (let i = 0; i < 50; i++) {
      const text = document.body.innerText;
      if (!document.querySelector('[role="dialog"]') && text.includes('The Lighthouse')) {
        return {
          ok: true,
          showsChapterLabel: text.includes('Chapter 1'),
          showsBeatLink: text.includes('Opening Image'),
          showsPlanned: text.includes('Planned'),
        };
      }
      await new Promise(r => setTimeout(r, 150));
    }
    return { ok: false, text: document.body.innerText.slice(0, 400) };
  })()`);
  record(
    '保存后章节渲染（Chapter 1、节拍链接、状态徽章）',
    chapterSaved?.ok === true && chapterSaved?.showsChapterLabel === true && chapterSaved?.showsBeatLink === true && chapterSaved?.showsPlanned === true,
    JSON.stringify(chapterSaved),
  );

  // ---- Expand chapter -> scenes ----
  await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '').startsWith('Expand Chapter 1'));
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(700);

  const scenesEmpty = await cdp.eval(`(async () => {
    for (let i = 0; i < 40; i++) {
      const text = document.body.innerText;
      if (text.includes('Break this chapter into scenes')) {
        return { ok: true, hasAddScene: [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Add scene') };
      }
      await new Promise(r => setTimeout(r, 150));
    }
    return { ok: false };
  })()`);
  record('展开章节后显示场景空状态与「Add scene」', scenesEmpty?.ok === true && scenesEmpty?.hasAddScene === true, JSON.stringify(scenesEmpty));

  await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add scene');
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(600);

  const sceneDialog = await cdp.eval(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return { open: false };
    return {
      open: true,
      title: dlg.innerText.split('\\n')[0],
      hasGoal: dlg.innerText.includes('Goal'),
      hasConflict: dlg.innerText.includes('Conflict'),
      hasTurningPoint: dlg.innerText.includes('Turning point'),
      hasOutcome: dlg.innerText.includes('Outcome'),
    };
  })()`);
  record(
    '场景对话框打开且含 Goal/Conflict/Turning point/Outcome',
    sceneDialog?.open === true && sceneDialog?.title === 'New scene' && sceneDialog?.hasGoal && sceneDialog?.hasConflict && sceneDialog?.hasTurningPoint && sceneDialog?.hasOutcome,
    JSON.stringify(sceneDialog),
  );

  await cdp.eval(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const setValue = (el, value) => {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setValue(dlg.querySelector('input'), 'The letter arrives');
    const areas = [...dlg.querySelectorAll('textarea')];
    setValue(areas[0], 'A letter from the dead arrives.');
    setValue(areas[1], 'The POV wants to open it.');
    const numbers = [...dlg.querySelectorAll('input[type="number"]')];
    if (numbers[0]) setValue(numbers[0], '1200');
    return true;
  })()`);
  await cdp.eval(`(() => {
    document.querySelector('button[form="scene-form"]')?.click();
    return true;
  })()`);

  const sceneSaved = await cdp.eval(`(async () => {
    for (let i = 0; i < 50; i++) {
      const text = document.body.innerText;
      if (!document.querySelector('[role="dialog"]') && text.includes('The letter arrives')) {
        return { ok: true, hasWordTarget: text.includes('1.2k words'), hasCount: text.includes('1 scene') };
      }
      await new Promise(r => setTimeout(r, 150));
    }
    return { ok: false, text: document.body.innerText.slice(0, 400) };
  })()`);
  record(
    '保存后场景渲染（目标字数、场景计数）',
    sceneSaved?.ok === true && sceneSaved?.hasWordTarget === true && sceneSaved?.hasCount === true,
    JSON.stringify(sceneSaved),
  );

  // ---- Data layer confirms persisted links ----
  const persisted = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    const id = localStorage.getItem('n87-p3ui-project');
    const outline = await svc.outlineService.getOutline(id);
    const chapter = outline[0]?.chapters[0];
    const scenes = chapter ? await svc.sceneService.listScenes(chapter.id) : [];
    const plan = await svc.narrativeService.getPlan(id);
    const linkedBeat = plan?.beats.find(b => b.id === chapter?.plotBeatId);
    return chapter ? {
      volume: outline[0].volume.title,
      chapter: chapter.title,
      chapterStatus: chapter.status,
      beatId: chapter.plotBeatId,
      beatResolves: !!linkedBeat,
      beatTitle: linkedBeat?.title,
      summary: chapter.summary,
      goal: chapter.goal,
      scenes: scenes.length,
      sceneTitle: scenes[0]?.title,
      sceneTarget: scenes[0]?.targetWords,
    } : null;
  })()`);
  record(
    '数据层确认持久化：章节仅存 beatId，且可解析回 Narrative 节拍',
    persisted?.volume === 'Book One' &&
      persisted?.chapter === 'The Lighthouse' &&
      typeof persisted?.beatId === 'string' &&
      persisted?.beatResolves === true &&
      persisted?.beatTitle === 'Opening Image' &&
      persisted?.summary === 'One line summary.' &&
      persisted?.goal === 'Establish the keeper.' &&
      persisted?.scenes === 1 &&
      persisted?.sceneTarget === 1200,
    JSON.stringify(persisted),
  );

  // ---- Reload ----
  await cdp.send('Page.reload');
  await sleep(3500);
  await cdp.eval(`(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find(t => t.textContent.trim() === 'Outline');
    if (tab) tab.click();
    return true;
  })()`);

  const afterReload = await cdp.eval(`(async () => {
    for (let i = 0; i < 50; i++) {
      const text = document.body.innerText;
      if (text.includes('Book One') && text.includes('The Lighthouse')) {
        return { rendered: true, beatLink: text.includes('Opening Image'), emptyState: text.includes('No outline yet') };
      }
      await new Promise(r => setTimeout(r, 150));
    }
    return { rendered: false };
  })()`);
  record(
    '刷新后 Outline 标签恢复（卷/章/节拍链接）',
    afterReload?.rendered === true && afterReload?.beatLink === true && afterReload?.emptyState === false,
    JSON.stringify(afterReload),
  );

  // ---- Cleanup ----
  const cleaned = await cdp.eval(`(async () => {
    const dbMod = await import('/src/db/index.ts');
    const svc = await import('/src/services/index.ts');
    const id = localStorage.getItem('n87-p3ui-project');
    await svc.projectService.deleteProject(id);
    return {
      volumes: await dbMod.db.volumes.where('projectId').equals(id).count(),
      chapters: await dbMod.db.chapters.where('projectId').equals(id).count(),
      scenes: await dbMod.db.scenes.where('projectId').equals(id).count(),
    };
  })()`);
  record('清理测试数据（无孤儿）', Object.values(cleaned ?? {}).every((v) => v === 0), JSON.stringify(cleaned));

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
