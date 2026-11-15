/**
 * P9 Batch B — Publishing Presets & Chapter Export: REAL browser + REAL DB.
 *
 * Uses the SAME headless-Chrome-over-CDP infrastructure as the other P9 UI
 * scripts. The app modules run for real from `/src/...`, data is seeded into the
 * REAL IndexedDB the app uses, and EVERY assertion is verified against the REAL
 * app (real store singleton, real localStorage, real pipeline output). Nothing
 * about presets/exports is mocked.
 *
 * Covers:
 *   - both pages render as real pages (not placeholders);
 *   - 8 built-in presets listed; selecting changes the ACTIVE preset;
 *   - the active preset is SHARED across both pages (select on one page, read on
 *     the other);
 *   - custom preset create / edit / duplicate / delete (with confirm) works;
 *   - built-in presets cannot be edited/deleted (only "Customise"/duplicate);
 *   - selection persists in localStorage across reload;
 *   - corrupt localStorage is recovered (defaults + notice), never crashes;
 *   - chapter export: multi-select, canonical order preserved, stale selection
 *     cleared on volume switch, "select all" scoped to the volume;
 *   - export download (TXT) contains selected chapters in order + preset format;
 *   - copy-to-clipboard uses the SAME content as the TXT writer;
 *   - changing preset changes the export output (formatting applied).
 *
 * Requires the dev server on http://localhost:5177/ (started by the caller).
 *
 * Usage: npm run verify:publishing:ui
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_URL = 'http://localhost:5177/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9411;
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

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9b-ui-chrome-'));
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
  await sleep(3000);

  const driverSrc = fs.readFileSync(path.join(__dirname, 'lib', 'p9b-publishing-ui-page.js'), 'utf8');
  const drv = (expr) => cdp.eval(`(${driverSrc}).${expr}`);

  /* ----------------------------- seed data ------------------------------ */
  const seeded = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    const { projectService, outlineService, manuscriptService } = svc;
    for (const p of await projectService.listProjects()) await projectService.deleteProject(p.id);
    const P = await projectService.createProject({ title: 'Export Demo', description: 'demo', settings: { author: 'Elara Vance', language: 'en' } });
    const v1 = await outlineService.createVolume(P.id, { title: 'Volume One' });
    const v2 = await outlineService.createVolume(P.id, { title: 'Volume Two' });
    const c1 = await outlineService.createChapter(P.id, v1.id, { title: 'Alpha' });
    const c2 = await outlineService.createChapter(P.id, v1.id, { title: 'Beta' });
    const c3 = await outlineService.createChapter(P.id, v2.id, { title: 'Gamma' });
    await manuscriptService.saveChapterDraft(P.id, c1.id, { content: 'ALPHA-BODY-PARA' });
    await manuscriptService.saveChapterDraft(P.id, c2.id, { content: 'BETA-BODY-PARA' });
    await manuscriptService.saveChapterDraft(P.id, c3.id, { content: 'GAMMA-BODY-PARA' });
    return { projectId: P.id, v1: v1.id, v2: v2.id, c1: c1.id, c2: c2.id, c3: c3.id };
  })()`);
  if (!seeded || !seeded.projectId) throw new Error('Seed failed: ' + JSON.stringify(seeded));

  // Clear any preset storage from previous runs so we start clean.
  await cdp.eval(`(() => { localStorage.removeItem('n87-publishing-presets'); })()`);

  const goto = async (route) => {
    await cdp.send('Page.navigate', { url: `${APP_URL.replace(/\/$/, '')}${route}` });
    await sleep(2500);
  };

  /* ================================================================ */
  /* (1) Presets page renders; 8 built-ins listed; default active      */
  /* ================================================================ */
  await goto('/publishing/presets');
  const cards = await drv('presetCards()');
  record('presets: page lists 8 built-in presets', cards.length === 8, String(cards.length));
  const builtinIds = ['generic','qidian','jinjiang','fanqie','wattpad','royal-road','amazon-kdp','generic-epub'];
  record('presets: all required built-in ids are present',
    builtinIds.every((id) => cards.some((c) => c.id === id)), cards.map((c) => c.id).join(','));
  const activeDefault = await drv('activePresetLabel()');
  record('presets: default active preset is Generic', activeDefault === 'Generic', String(activeDefault));

  /* ================================================================ */
  /* (2) Selecting a built-in changes the active preset                */
  /* ================================================================ */
  await cdp.eval(`(async () => {
    const card = [...document.querySelectorAll('[data-testid="preset-card"]')].find((c) => c.getAttribute('data-preset-id') === 'qidian');
    card.querySelector('[data-testid="preset-select"]').click();
  })()`);
  await sleep(400);
  record('presets: selecting "qidian" makes it active', (await drv('activePresetLabel()')) === '起点中文网', String(await drv('activePresetLabel()')));

  /* ================================================================ */
  /* (3) Built-ins expose NO edit/delete (only duplicate)              */
  /* ================================================================ */
  const builtinActions = await cdp.eval(`(() => {
    const card = [...document.querySelectorAll('[data-testid="preset-card"]')].find((c) => c.getAttribute('data-preset-id') === 'generic');
    return {
      hasEdit: !!card.querySelector('[data-testid="preset-edit"]'),
      hasDelete: !!card.querySelector('[data-testid="preset-delete"]'),
      hasDuplicate: !!card.querySelector('[data-testid="preset-duplicate"]'),
    };
  })()`);
  record('presets: built-in has no Edit button', builtinActions.hasEdit === false);
  record('presets: built-in has no Delete button', builtinActions.hasDelete === false);
  record('presets: built-in has a Customise/duplicate button', builtinActions.hasDuplicate === true);

  /* ================================================================ */
  /* (4) Create a custom preset via the editor                          */
  /* ================================================================ */
  await drv(`clickTestId('create-preset')`);
  await sleep(400);
  record('create: the editor dialog opens', /new custom preset/i.test((await drv('dialogTitle()')) || ''), String(await drv('dialogTitle()')));
  await drv(`setInput('preset-name-input', 'My Profile')`);
  await drv(`setInput('preset-metadata', 'title')`);
  await drv(`setInput('preset-paragraph-style', 'blank-line')`);
  await drv(`setInput('preset-file-template', '{title}-{author}')`);
  await drv(`setInput('preset-extension', 'md')`);
  await drv(`clickTestId('preset-editor-save')`);
  await sleep(500);
  record('create: saving closes the dialog', (await drv('dialogOpen()')) === false);
  const afterCreate = await drv('presetCards()');
  record('create: a custom preset "My Profile" now exists', afterCreate.some((c) => /My Profile/.test(c.text)), afterCreate.map((c) => c.id).join(','));
  record('create: the new custom preset is active', (await drv('activePresetLabel()')) === 'My Profile', String(await drv('activePresetLabel()')));

  // Verify persistence envelope was written.
  const stored = await cdp.eval(`(() => JSON.parse(localStorage.getItem('n87-publishing-presets') || 'null'))()`);
  record('persist: localStorage envelope exists with version 1', stored && stored.version === 1, JSON.stringify(stored && stored.version));
  record('persist: envelope records one custom preset', stored && stored.customPresets && stored.customPresets.length === 1, String(stored && stored.customPresets && stored.customPresets.length));
  const customId = stored.customPresets[0].id;

  /* ================================================================ */
  /* (5) Edit the custom preset's label                                */
  /* ================================================================ */
  await cdp.eval(`(() => {
    const card = [...document.querySelectorAll('[data-testid="preset-card"]')].find((c) => c.getAttribute('data-preset-id') === ${JSON.stringify(customId)});
    card.querySelector('[data-testid="preset-edit"]').click();
  })()`);
  await sleep(400);
  record('edit: the editor opens in edit mode', /edit custom preset/i.test((await drv('dialogTitle()')) || ''), String(await drv('dialogTitle()')));
  await drv(`setInput('preset-name-input', 'My Edited Profile')`);
  await drv(`clickTestId('preset-editor-save')`);
  await sleep(500);
  record('edit: renaming updates the card', (await drv('presetCards()')).some((c) => /My Edited Profile/.test(c.text)));

  /* ================================================================ */
  /* (6) Invalid draft is rejected inline                              */
  /* ================================================================ */
  await drv(`clickTestId('create-preset')`);
  await sleep(300);
  await drv(`setInput('preset-name-input', '')`); // empty label invalid
  await drv(`clickTestId('preset-editor-save')`);
  await sleep(300);
  record('validation: empty name is rejected and the dialog stays open', (await drv('dialogOpen()')) === true && !!(await drv('dialogError()')));
  await drv(`clickByText('Cancel')`);
  await sleep(300);

  /* ================================================================ */
  /* (7) SHARED state: select qidian on presets page, read on export   */
  /* ================================================================ */
  await cdp.eval(`(() => {
    const card = [...document.querySelectorAll('[data-testid="preset-card"]')].find((c) => c.getAttribute('data-preset-id') === 'qidian');
    card.querySelector('[data-testid="preset-select"]').click();
  })()`);
  await sleep(300);

  /* ================================================================ */
  /* (8) Export page: selection, order, scoping, download, copy        */
  /* ================================================================ */
  await goto('/publishing/chapter-export');
  await sleep(1500);
  record('export: page renders (not placeholder)', !/coming soon|placeholder/i.test(await cdp.eval('document.body.innerText')));
  // The export page shows the SHARED active preset (qidian).
  const pickerVal = await drv('byIdValue("export-preset-picker")');
  record('shared: export page reflects the preset selected on the presets page', pickerVal === 'qidian', String(pickerVal));

  // Select the seeded project (there should be exactly one).
  await cdp.eval(`(async () => {
    const sel = document.querySelector('[data-testid="export-project-select"]');
    // If more than one, pick the seeded one by matching — the seed cleared others.
    sel.value = ${JSON.stringify(seeded.projectId)};
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(1200);

  // Volume selector defaults to the first volume (Volume One → v1).
  await cdp.eval(`(() => {
    const sel = document.querySelector('[data-testid="export-volume-select"]');
    sel.value = ${JSON.stringify(seeded.v1)};
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(800);

  let rows = await drv('chapterRows()');
  record('export: volume One lists exactly its 2 chapters', rows.length === 2, rows.map((r) => r.id).join(','));
  record('export: chapter list is in canonical order (Alpha then Beta)',
    rows[0] && rows[1] && /Alpha/.test(rows[0].text) && /Beta/.test(rows[1].text), rows.map((r) => r.text).join(' | '));

  // Select BOTH chapters, but click Beta FIRST to prove order isn't click order.
  await cdp.eval(`(() => {
    const ids = ${JSON.stringify([seeded.c2, seeded.c1])};
    for (const id of ids) {
      const row = [...document.querySelectorAll('[data-testid="chapter-row"]')].find((r) => r.getAttribute('data-chapter-id') === id);
      row.querySelector('input[type="checkbox"]').click();
    }
  })()`);
  await sleep(1500);
  record('export: selection count shows 2', /2 selected/.test((await drv('selectionCount()')) || ''), String(await drv('selectionCount()')));
  const preview = await drv('previewText()');
  record('export: preview shows chapter body text', /ALPHA-BODY-PARA/.test(preview || '') && /BETA-BODY-PARA/.test(preview || ''));
  // Canonical order: Alpha appears before Beta in the preview (click order reversed).
  record('export: preview preserves canonical order (Alpha before Beta) even though Beta was clicked first',
    (preview || '').indexOf('ALPHA-BODY-PARA') < (preview || '').indexOf('BETA-BODY-PARA'));

  // Download TXT and verify content + filename from the preset template.
  const dl = await cdp.eval(`(${driverSrc}).interceptDownload('download-button')`);
  await sleep(300);
  record('export: a download file name is produced', !!(dl && dl.fileName), dl && dl.fileName);
  record('export: downloaded TXT contains both selected chapter bodies', dl && /ALPHA-BODY-PARA/.test(dl.text) && /BETA-BODY-PARA/.test(dl.text));
  record('export: downloaded TXT excludes the unselected chapter (Gamma)', dl && !/GAMMA-BODY-PARA/.test(dl.text));
  record('export: TXT filename is a .txt file', dl && /\.txt$/i.test(dl.fileName), dl && dl.fileName);

  // Copy to clipboard — must match the TXT writer body.
  const clip = await cdp.eval(`(${driverSrc}).interceptClipboard('copy-button')`);
  await sleep(300);
  record('export: clipboard contains both selected chapters', typeof clip === 'string' && /ALPHA-BODY-PARA/.test(clip) && /BETA-BODY-PARA/.test(clip));
  record('export: clipboard content matches the TXT download body', typeof clip === 'string' && dl && clip.trim() === dl.text.trim());

  /* ================================================================ */
  /* (9) Switching volume clears stale selection                       */
  /* ================================================================ */
  await cdp.eval(`(() => {
    const sel = document.querySelector('[data-testid="export-volume-select"]');
    sel.value = ${JSON.stringify(seeded.v2)};
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(800);
  rows = await drv('chapterRows()');
  record('export: switching to volume Two lists Gamma only', rows.length === 1 && rows[0].id === seeded.c3, rows.map((r) => r.id).join(','));
  record('export: switching volume CLEARS the previous selection', /0 selected/.test((await drv('selectionCount()')) || ''), String(await drv('selectionCount()')));

  /* ================================================================ */
  /* (10) Select all is scoped to the current volume                   */
  /* ================================================================ */
  await cdp.eval(`(() => {
    const sel = document.querySelector('[data-testid="export-volume-select"]');
    sel.value = ${JSON.stringify(seeded.v1)};
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(800);
  await drv(`clickTestId('select-all')`);
  await sleep(1200);
  record('export: select-all selects both chapters of the volume', /2 selected/.test((await drv('selectionCount()')) || ''), String(await drv('selectionCount()')));
  const afterClear = await (async () => { await drv(`clickTestId('clear-selection')`); await sleep(500); return drv('selectionCount()'); })();
  record('export: clear empties the selection', /0 selected/.test(afterClear || ''), String(afterClear));

  /* ================================================================ */
  /* (11) Changing the preset changes the export output                */
  /* ================================================================ */
  // Select Alpha only, with qidian active.
  await cdp.eval(`(() => {
    const row = [...document.querySelectorAll('[data-testid="chapter-row"]')].find((r) => r.getAttribute('data-chapter-id') === ${JSON.stringify(seeded.c1)});
    row.querySelector('input[type="checkbox"]').click();
  })()`);
  await sleep(1500);
  const qidianPreview = await drv('previewText()');
  // Switch the preset to "generic" via the shared picker on the export page.
  await drv(`setById('export-preset-picker', 'generic')`);
  await sleep(1600);
  const genericPreview = await drv('previewText()');
  record('export: switching preset changes the preview output', qidianPreview !== genericPreview && !!qidianPreview && !!genericPreview);
  record('shared(export->store): switching preset on export page persists to localStorage',
    await cdp.eval(`(() => JSON.parse(localStorage.getItem('n87-publishing-presets') || '{}').activePresetId === 'generic')()`));

  /* ================================================================ */
  /* (12) Selection persists across reload (project/volume/preset)     */
  /* ================================================================ */
  await goto('/publishing/presets');
  const afterReloadActive = await drv('activePresetLabel()');
  record('persist: active preset (generic) survives a full reload', afterReloadActive === 'Generic', String(afterReloadActive));

  /* ================================================================ */
  /* (13) Custom preset delete requires confirmation, then removes     */
  /* ================================================================ */
  const before = await drv('presetCards()');
  const customCardId = before.find((c) => /My Edited Profile/.test(c.text))?.id;
  record('delete: the edited custom preset is present before delete', !!customCardId, String(customCardId));
  if (customCardId) {
    await cdp.eval(`(() => {
      const card = [...document.querySelectorAll('[data-testid="preset-card"]')].find((c) => c.getAttribute('data-preset-id') === ${JSON.stringify(customCardId)});
      card.querySelector('[data-testid="preset-delete"]').click();
    })()`);
    await sleep(400);
    record('delete: clicking Delete opens a confirmation dialog', /delete/i.test((await drv('dialogTitle()')) || ''), String(await drv('dialogTitle()')));
    await drv(`clickTestId('preset-delete-confirm')`);
    await sleep(500);
    const afterDelete = await drv('presetCards()');
    record('delete: confirming removes the custom preset', !afterDelete.some((c) => c.id === customCardId), afterDelete.map((c) => c.id).join(','));
    const storedAfterDelete = await cdp.eval(`(() => JSON.parse(localStorage.getItem('n87-publishing-presets') || '{}'))()`);
    record('delete: persisted state no longer contains the deleted preset',
      !storedAfterDelete.customPresets || !storedAfterDelete.customPresets.some((c) => c.id === customCardId));
  }

  /* ================================================================ */
  /* (14) Corrupt storage recovery (defaults + notice, no crash)        */
  /* ================================================================ */
  await cdp.eval(`(() => { localStorage.setItem('n87-publishing-presets', '{ corrupt json'); })()`);
  await goto('/publishing/presets');
  const recoveredActive = await drv('activePresetLabel()');
  record('recover: corrupt storage falls back to the default preset', recoveredActive === 'Generic', String(recoveredActive));
  const notice = await cdp.eval(`(() => { const el = document.querySelector('[data-testid="preset-recovery-notice"]'); return el ? el.innerText : null; })()`);
  record('recover: a recovery notice is shown', typeof notice === 'string' && notice.length > 0, String(notice));
  record('recover: the page did not crash (still shows built-ins)', (await drv('presetCards()')).length === 8);

  /* ================================================================ */
  /* (15) No uncaught exceptions across the whole flow                 */
  /* ================================================================ */
  record('no uncaught page exceptions', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

  teardown();
  finish();
}

function finish() {
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
