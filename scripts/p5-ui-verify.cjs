/**
 * P5 UI smoke test: real browser, real routing, real Dexie.
 *
 * Verifies the four AI pages actually mount at their routes (not placeholders)
 * and that the AI configuration data layer works end to end against IndexedDB:
 *   - create provider, add two models, enforce "one default per provider",
 *   - set global default, assign a task, clear it on model delete,
 *   - cascade-delete a provider (models + assignments cleaned up).
 *
 * It also asserts AiService refuses to generate when nothing is configured
 * (the "no silent substitution" guarantee) without any network call.
 *
 * Usage: npm run verify:ai:ui
 * Requires a dev server on http://localhost:5177/.
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_URL = 'http://localhost:5177/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9351;

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

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}.`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p5ui-chrome-'));
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

  // ---- Load the app once so modules are importable for in-page tests ----
  await cdp.send('Page.navigate', { url: APP_URL });
  await sleep(2500);

  // ---- Route smoke: each AI page renders its own header, not a placeholder ----
  const routes = [
    { path: '/settings/api', header: 'API Settings' },
    { path: '/settings/providers', header: 'Provider Management' },
    { path: '/settings/models', header: 'Model Configuration' },
    { path: '/ai/assistance', header: 'AI Assistance' },
  ];
  for (const route of routes) {
    await cdp.sendBounded('Page.navigate', { url: `${APP_URL.replace(/\/$/, '')}${route.path}` }, 15_000);
    const rendered = await cdp.eval(`(async () => {
      for (let i = 0; i < 60; i++) {
        const h1 = document.querySelector('h1');
        if (h1 && (h1.textContent || '').includes(${JSON.stringify(route.header)})) {
          return { ok: true, title: (h1.textContent || '').trim(), isPlaceholder: document.body.innerText.includes('under construction') || document.body.innerText.includes('ModulePlaceholder') };
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      const h1 = document.querySelector('h1');
      return { ok: false, title: h1 ? (h1.textContent || '').trim() : null };
    })()`);
    record(`route ${route.path} renders "${route.header}" (not a placeholder)`, rendered?.ok === true && rendered?.isPlaceholder === false, JSON.stringify(rendered));
  }

  // ---- Data layer: real config service against IndexedDB ----
  const dataLayer = await cdp.eval(`(async () => {
    const dbMod = await import('/src/db/index.ts');
    const svc = await import('/src/services/index.ts');
    await dbMod.initDatabase();
    const cfg = svc.aiConfigService;

    // Clean slate for this run.
    for (const p of await cfg.listProviders()) await cfg.deleteProvider(p.id);

    const provider = await cfg.createProvider({
      name: 'UI Test OpenAI', providerType: 'openai', apiKey: 'sk-ui-test-1234', enabled: true,
    });
    const m1 = await cfg.createModel({ providerId: provider.id, modelId: 'gpt-4o-mini', displayName: 'Mini', isDefault: true });
    const m2 = await cfg.createModel({ providerId: provider.id, modelId: 'gpt-4o', displayName: 'Full' });

    // Promote m2: m1 must lose the default flag (one default per provider).
    await cfg.setProviderDefaultModel(provider.id, m2.id);
    const afterPromote = await cfg.listModelsByProvider(provider.id);
    const defaultCount = afterPromote.filter((m) => m.isDefault).length;
    const m2IsDefault = afterPromote.find((m) => m.id === m2.id)?.isDefault === true;

    // Global default + task assignment, then delete the model and check cleanup.
    await cfg.setGlobalDefaultModel(m2.id);
    await cfg.setTaskModel('continue', m2.id);
    await cfg.deleteModel(m2.id);
    const assignAfterDelete = await cfg.getAssignments();

    // Resolve a task with nothing assigned globally: must throw, not substitute.
    let configErrorKind = null;
    try {
      await svc.aiService.resolveTarget('continue');
    } catch (e) {
      configErrorKind = e && e.kind ? e.kind : (e && e.name) || 'unknown';
    }

    // Cascade delete provider.
    await cfg.deleteProvider(provider.id);
    const providersLeft = (await cfg.listProviders()).length;
    const modelsLeft = (await cfg.listModels()).length;

    return {
      providerCreated: !!provider.id,
      defaultCount,
      m2IsDefault,
      globalClearedAfterDelete: assignAfterDelete.global.defaultModelId === null,
      taskClearedAfterDelete: assignAfterDelete.tasks.continue === null,
      configErrorKind,
      providersLeft,
      modelsLeft,
    };
  })()`);

  record('data: provider + models created', dataLayer?.providerCreated === true, JSON.stringify(dataLayer));
  record('data: exactly one default per provider after promotion', dataLayer?.defaultCount === 1 && dataLayer?.m2IsDefault === true, `defaultCount=${dataLayer?.defaultCount}`);
  record('data: deleting a model clears the global default', dataLayer?.globalClearedAfterDelete === true, String(dataLayer?.globalClearedAfterDelete));
  record('data: deleting a model clears task assignments', dataLayer?.taskClearedAfterDelete === true, String(dataLayer?.taskClearedAfterDelete));
  record('data: no configured model → explicit config error (no silent substitution)', dataLayer?.configErrorKind === 'config', String(dataLayer?.configErrorKind));
  record('data: deleting a provider cascades away its models', dataLayer?.providersLeft === 0 && dataLayer?.modelsLeft === 0, JSON.stringify({ providersLeft: dataLayer?.providersLeft, modelsLeft: dataLayer?.modelsLeft }));

  // ======================================================================
  // F1 + F3: Editor AI Assistant — real buttons, selection, preview, apply.
  // We seed a provider+model (so the assistant renders) and a project+chapter
  // (so the Writing tab opens), then STUB aiService.generate so no network is
  // used. The stub records the messages it receives and returns canned text.
  // ======================================================================
  const seed = await cdp.eval(`(async () => {
    const dbMod = await import('/src/db/index.ts');
    const svc = await import('/src/services/index.ts');
    await dbMod.initDatabase();
    const cfg = svc.aiConfigService;

    // Fresh AI config so hasModels is true.
    for (const p of await cfg.listProviders()) await cfg.deleteProvider(p.id);
    const provider = await cfg.createProvider({ name: 'Editor Test', providerType: 'openai', apiKey: 'sk-editor-test-9', enabled: true });
    const model = await cfg.createModel({ providerId: provider.id, modelId: 'gpt-4o-mini', displayName: 'Editor Mini', isDefault: true, enabled: true });
    await cfg.setGlobalDefaultModel(model.id);

    // Fresh project + volume + two chapters with known prose.
    for (const p of await svc.projectService.listProjects()) await svc.projectService.deleteProject(p.id);
    const project = await svc.projectService.createProject({ title: 'AI Editor Project' });
    const volume = await svc.outlineService.createVolume(project.id, { title: 'Book One' });
    const c1 = await svc.outlineService.createChapter(project.id, volume.id, { title: 'Chapter One' });
    const c2 = await svc.outlineService.createChapter(project.id, volume.id, { title: 'Chapter Two' });
    const prose1 = 'The keeper climbed the stair and lit the lamp.';
    const prose2 = 'The second chapter opens on a quiet morning.';
    const d1 = await svc.manuscriptService.openChapterDraft(project.id, c1.id);
    await svc.manuscriptService.saveChapterDraft(project.id, c1.id, { content: prose1, expectedRevision: d1.draft.revision });
    const d2 = await svc.manuscriptService.openChapterDraft(project.id, c2.id);
    await svc.manuscriptService.saveChapterDraft(project.id, c2.id, { content: prose2, expectedRevision: d2.draft.revision });

    return {
      projectId: project.id,
      c1: c1.id,
      c2: c2.id,
      prose1,
      prose2,
    };
  })()`);

  record('F1 setup: provider+model+project+chapters seeded', !!seed?.projectId && !!seed?.c1, JSON.stringify({ projectId: seed?.projectId, c1: seed?.c1 }));

  // Open the Writing tab of the project.
  await cdp.sendBounded('Page.navigate', { url: `${APP_URL.replace(/\/$/, '')}/projects/${seed.projectId}` }, 15_000);
  const opened = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 60; i++) {
      const tab = [...document.querySelectorAll('button, a')].find((b) => /^Writing$/.test((b.textContent || '').trim()));
      if (tab) { tab.click(); break; }
      await sleep(150);
    }
    // Wait for the AI assistant card and editor to mount.
    for (let i = 0; i < 80; i++) {
      const hasAssistant = !!findAssistantCard();
      const hasEditor = !!document.querySelector('.ProseMirror');
      if (hasAssistant && hasEditor) return { ok: true };
      await sleep(150);
    }
    return { ok: false, hasAssistant: !!findAssistantCard(), hasEditor: !!document.querySelector('.ProseMirror') };
    function findAssistantCard() {
      return [...document.querySelectorAll('h3')].find((h) => (h.textContent || '').trim() === 'AI Assistant');
    }
  })()`);
  record('F1: Writing tab opens with the AI Assistant mounted', opened?.ok === true, JSON.stringify(opened));

  // Install the generation stub AFTER navigation by patching window.fetch.
  // The transport binds `globalThis.fetch`, so intercepting fetch is the most
  // reliable seam — it needs no module identity and touches no network. We
  // record the request body so we can assert the selected text was the input.
  await cdp.eval(`(() => {
    window.__aiStub = { calls: 0, lastBody: null, content: 'GENERATED_INSERT_TEXT' };
    if (window.__origFetch) return true; // idempotent
    window.__origFetch = window.fetch;
    window.fetch = async (url, init) => {
      try {
        const body = init && init.body ? JSON.parse(init.body) : null;
        window.__aiStub.calls += 1;
        window.__aiStub.lastBody = body;
        const content = window.__aiStub.content;
        const payload = { choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(payload),
          json: async () => payload,
        };
      } catch (e) {
        return { ok: false, status: 500, text: async () => 'stub error', json: async () => ({}) };
      }
    };
    return true;
  })()`);

  // Discover the assistant buttons and their enabled/disabled state (no selection yet).
  const buttonState = await cdp.eval(`(() => {
    const aside = [...document.querySelectorAll('h3')].find((h) => (h.textContent || '').trim() === 'AI Assistant')?.closest('section,div');
    const scope = aside ? (aside.closest('aside') || aside) : document;
    const labels = ['Continue', 'Rewrite', 'Polish', 'Expand', 'Shorten'];
    const found = {};
    for (const label of labels) {
      const btn = [...scope.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === label);
      found[label] = btn ? { present: true, disabled: btn.disabled } : { present: false };
    }
    return found;
  })()`);
  const allPresent = ['Continue', 'Rewrite', 'Polish', 'Expand', 'Shorten'].every((l) => buttonState?.[l]?.present);
  record('F1: all five actions visible (Continue, Rewrite, Polish, Expand, Shorten)', allPresent, JSON.stringify(buttonState));
  record('F1: Expand present', buttonState?.Expand?.present === true, JSON.stringify(buttonState?.Expand));
  record('F1: Shorten present', buttonState?.Shorten?.present === true, JSON.stringify(buttonState?.Shorten));
  record('F1: replace actions disabled without a selection', buttonState?.Expand?.disabled === true && buttonState?.Shorten?.disabled === true, JSON.stringify({ expand: buttonState?.Expand, shorten: buttonState?.Shorten }));

  // Select all editor text -> replace actions should enable.
  const afterSelect = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const pm = document.querySelector('.ProseMirror');
    pm.focus();
    document.execCommand('selectAll');
    // Give React a tick to observe the selection update.
    for (let i = 0; i < 20; i++) {
      await sleep(50);
      const aside = [...document.querySelectorAll('h3')].find((h) => (h.textContent || '').trim() === 'AI Assistant')?.closest('section,div');
      const scope = aside ? (aside.closest('aside') || aside) : document;
      const expand = [...scope.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Expand');
      if (expand && !expand.disabled) return { enabled: true, selection: String(window.getSelection()) };
    }
    const expand = [...scope.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Expand');
    return { enabled: expand ? !expand.disabled : false, selection: String(window.getSelection()) };
  })()`);
  record('F1: selecting text enables Expand/Shorten', afterSelect?.enabled === true, JSON.stringify(afterSelect));
  record('F1: selection captured by editor is non-empty', (afterSelect?.selection || '').trim().length > 0, JSON.stringify(afterSelect?.selection));

  // Click Expand -> preview opens; the stub received the selected text as input.
  const expandRun = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const pm = document.querySelector('.ProseMirror');
    pm.focus();
    // Select the first text node's content via a real Range (more reliable than
    // execCommand for a contenteditable).
    const walker = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT);
    const firstText = walker.nextNode();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(firstText || pm);
    sel.removeAllRanges(); sel.addRange(range);
    await sleep(250);
    const card = [...document.querySelectorAll('h3')].find((h) => (h.textContent || '').trim() === 'AI Assistant')?.closest('div');
    const scope = card?.closest('aside') || card || document;
    const expand = [...scope.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Expand');
    const diag = {
      badge: scope.innerText ? scope.innerText.split('\\n').slice(0, 2).join(' | ') : '',
      expandPresent: !!expand,
      expandDisabled: expand ? expand.disabled : null,
      selectionLen: String(window.getSelection()).length,
    };
    if (!expand || expand.disabled) return { previewOpen: false, reason: 'disabled', diag };
    // Dispatch a bubbling click and sample the assistant state immediately.
    let clickErr = null;
    try { expand.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); }
    catch (e) { clickErr = String(e); }
    const samples = [];
    for (let i = 0; i < 80; i++) {
      await sleep(50);
      const dialog = document.querySelector('[role="dialog"]');
      const cardNow = [...document.querySelectorAll('h3')].find((h) => (h.textContent || '').trim() === 'AI Assistant')?.closest('div');
      const scopeNow = cardNow?.closest('aside') || cardNow || document;
      samples.push({ t: i * 50, dialog: !!dialog, calls: window.__aiStub.calls, text: (scopeNow.innerText || '').replace(/\\n/g, '/').slice(0, 60) });
      if (dialog && /generated/i.test(dialog.textContent || '')) {
        const body = window.__aiStub.lastBody || {};
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const userMsg = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\\n');
        return {
          previewOpen: true,
          userMessageHasSelection: userMsg.includes('lighthouse') || userMsg.includes('keeper') || userMsg.includes('climbed') || userMsg.includes('stair'),
          showsGenerated: /GENERATED_INSERT_TEXT/.test(dialog.textContent || ''),
        };
      }
      if (window.__aiStub.calls > 0) break;
    }
    return { previewOpen: false, calls: window.__aiStub.calls, clickErr, diag, samples: samples.slice(0, 6) };
  })()`);
  record('F1: Expand produces a preview proposal', expandRun?.previewOpen === true, JSON.stringify(expandRun));
  record('F1: Expand used the selected text as input', expandRun?.userMessageHasSelection === true, JSON.stringify(expandRun));

  // Reject -> doc unchanged.
  const rejectResult = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const before = document.querySelector('.ProseMirror').innerText;
    const dialog = document.querySelector('[role="dialog"]');
    const reject = [...dialog.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Reject');
    reject.click();
    await sleep(200);
    const after = document.querySelector('.ProseMirror').innerText;
    return { unchanged: before === after, hasGenerated: after.includes('GENERATED_INSERT_TEXT'), dialogClosed: !document.querySelector('[role="dialog"]') };
  })()`);
  record('F1: Reject does not modify the manuscript', rejectResult?.unchanged === true && rejectResult?.hasGenerated === false, JSON.stringify(rejectResult));

  // Regenerate -> never modifies the manuscript (new preview, content unchanged).
  const regenResult = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // Re-select and Generate, then Regenerate.
    const pm = document.querySelector('.ProseMirror');
    pm.focus(); document.execCommand('selectAll');
    await sleep(120);
    const aside = [...document.querySelectorAll('h3')].find((h) => (h.textContent || '').trim() === 'AI Assistant')?.closest('section,div');
    const scope = aside ? (aside.closest('aside') || aside) : document;
    [...scope.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Polish').click();
    for (let i = 0; i < 40; i++) { await sleep(50); if (document.querySelector('[role="dialog"]')) break; }
    const editorTextBefore = document.querySelector('.ProseMirror').innerText;
    const dialog = document.querySelector('[role="dialog"]');
    const regen = [...dialog.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Regenerate');
    const callsBefore = window.__aiStub.calls;
    regen.click();
    for (let i = 0; i < 40; i++) { await sleep(50); if (window.__aiStub.calls > callsBefore && document.querySelector('[role="dialog"]')) break; }
    const editorTextAfter = document.querySelector('.ProseMirror').innerText;
    return { unchanged: editorTextBefore === editorTextAfter, calledAgain: window.__aiStub.calls > callsBefore, hasGenerated: editorTextAfter.includes('GENERATED_INSERT_TEXT') };
  })()`);
  record('F1: Regenerate re-runs without modifying the manuscript', regenResult?.unchanged === true && regenResult?.calledAgain === true && regenResult?.hasGenerated === false, JSON.stringify(regenResult));

  // Close any open dialog.
  await cdp.eval(`(() => { const d = document.querySelector('[role="dialog"]'); if (d) { const x = d.querySelector('[aria-label="Close dialog"]'); if (x) x.click(); } return true; })()`);
  await sleep(300);

  // Apply an Expand -> the original selection is REPLACED by the generated text (only Apply mutates).
  const applyResult = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__aiStub.content = 'EXPANDED_OUTPUT';
    const pm = document.querySelector('.ProseMirror');
    pm.focus(); document.execCommand('selectAll');
    await sleep(120);
    const aside = [...document.querySelectorAll('h3')].find((h) => (h.textContent || '').trim() === 'AI Assistant')?.closest('section,div');
    const scope = aside ? (aside.closest('aside') || aside) : document;
    [...scope.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Expand').click();
    for (let i = 0; i < 40; i++) { await sleep(50); if (document.querySelector('[role="dialog"]')) break; }
    const dialog = document.querySelector('[role="dialog"]');
    const apply = [...dialog.querySelectorAll('button')].find((b) => /Apply changes/.test(b.textContent || ''));
    apply.click();
    await sleep(200);
    const text = document.querySelector('.ProseMirror').innerText;
    return { hasOutput: text.includes('EXPANDED_OUTPUT'), dialogClosed: !document.querySelector('[role="dialog"]') };
  })()`);
  record('F1: Apply mutates the manuscript through the editor', applyResult?.hasOutput === true, JSON.stringify(applyResult));

  // ---- F3: continuation inserts at the CAPTURED anchor, not the live cursor ----
  // Put the caret in the MIDDLE of the document, continue, then move the caret
  // to the very start before applying. If apply honoured the live cursor, the
  // text would land at the start; honouring the anchor lands it mid-document.
  const continueAnchor = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__aiStub.content = 'CONTINUED_AT_ANCHOR';
    const pm = document.querySelector('.ProseMirror');
    pm.focus();
    // Restore known content and put caret near the end via selection collapse.
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(pm);
    range.collapse(false); // end
    sel.removeAllRanges(); sel.addRange(range);
    await sleep(120);
    const aside = [...document.querySelectorAll('h3')].find((h) => (h.textContent || '').trim() === 'AI Assistant')?.closest('section,div');
    const scope = aside ? (aside.closest('aside') || aside) : document;
    [...scope.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Continue').click();
    for (let i = 0; i < 40; i++) { await sleep(50); if (document.querySelector('[role="dialog"]')) break; }
    if (!document.querySelector('[role="dialog"]')) return { previewOpen: false };

    // Move the caret to the START of the doc AFTER generation.
    const sel2 = window.getSelection();
    const r2 = document.createRange();
    r2.selectNodeContents(pm); r2.collapse(true); // start
    sel2.removeAllRanges(); sel2.addRange(r2);
    await sleep(80);

    const dialog = document.querySelector('[role="dialog"]');
    const apply = [...dialog.querySelectorAll('button')].find((b) => /Insert below/.test(b.textContent || ''));
    apply.click();
    await sleep(200);
    const text = document.querySelector('.ProseMirror').innerText;
    return {
      inserted: text.includes('CONTINUED_AT_ANCHOR'),
      // Anchor was at end; if inserted-at-start it would be the FIRST thing.
      atStart: text.trim().startsWith('CONTINUED_AT_ANCHOR'),
      previewOpen: true,
    };
  })()`);
  record('F3: continuation produced a preview', continueAnchor?.previewOpen === true, JSON.stringify(continueAnchor));
  record('F3: continuation inserted at the captured anchor (not the moved cursor)', continueAnchor?.inserted === true && continueAnchor?.atStart === false, JSON.stringify(continueAnchor));

  // Cleanup the seeded project + provider.
  await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    for (const p of await svc.projectService.listProjects()) await svc.projectService.deleteProject(p.id);
    for (const p of await svc.aiConfigService.listProviders()) await svc.aiConfigService.deleteProvider(p.id);
    return true;
  })()`);

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
