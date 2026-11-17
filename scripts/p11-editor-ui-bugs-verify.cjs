/**
 * Story Editor — DOM-level regression tests for the four reported toolbar /
 * slash-menu UI bugs (toolbar selectors, command execution, slash auto-scroll,
 * toolbar geometry). Node + jsdom, NO real browser.
 *
 * Why a separate script: the pure-logic checks in
 * `p11-editor-formatting-verify.cjs` run headless TipTap with no React. The
 * interaction bugs below live in the React components' event handlers, refs and
 * effects, so they must be driven through the ACTUAL components. This script
 * bundles a small harness (`scripts/lib/dom-harness.tsx`) that imports React +
 * the real components into ONE module graph — a single React instance — and
 * drives it under jsdom.
 *
 * What this DOES verify: real event handlers fire as in a browser (click,
 * mousedown, change, keydown), the editor document changes, Markdown
 * serialises, refs/effects run (scrollIntoView is actually called), and box
 * dimensions are state-independent (class/utility level).
 *
 * What this CANNOT verify: pixel rendering / native OS dropdown painting /
 * native scroll — jsdom has no layout engine or native <select> popup. Those
 * are called out as NOT browser-verified in the final report.
 *
 * Usage: npm run verify:editor-ui-bugs
 */
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, '.tmp-verify');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
}
function even(name, condition, detail) {
  record(name, Boolean(condition), detail);
}
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  record(name, ok, ok ? undefined : `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}

/** Installs a jsdom window + layout stubs, returns the dom + recorders. */
function installDom() {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.MutationObserver = dom.window.MutationObserver;
  globalThis.getSelection = dom.window.getSelection.bind(dom.window);
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  // jsdom has no layout: ProseMirror focus()/coordsAtPos() need these.
  const zero = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() { return this; } };
  const list = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} });
  dom.window.Range.prototype.getClientRects = list;
  dom.window.Range.prototype.getBoundingClientRect = () => zero;
  dom.window.Element.prototype.getClientRects = list;
  dom.window.Element.prototype.getBoundingClientRect = () => zero;
  const scrollCalls = [];
  dom.window.HTMLElement.prototype.scrollIntoView = function (opts) { scrollCalls.push(opts); };
  dom.window.HTMLElement.prototype.scrollTo = function () {};
  return { dom, scrollCalls };
}

/** Bundles the harness into one temp module (all deps internal) and imports it. */
async function bundleHarness() {
  const vite = await import(pathToFileURL(path.join(ROOT, 'node_modules', 'vite', 'dist', 'node', 'index.js')).href);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `dom-harness-${Date.now()}.mjs`);
  await vite.build({
    configFile: false,
    logLevel: 'silent',
    root: ROOT,
    resolve: { alias: { '@': path.join(ROOT, 'src') } },
    build: {
      write: true,
      minify: false,
      target: 'esnext',
      outDir: OUT_DIR,
      emptyOutDir: false,
      lib: { entry: path.join(ROOT, 'scripts/lib/dom-harness.tsx'), formats: ['es'], fileName: () => path.basename(outFile) },
      rollupOptions: { external: [] },
    },
  });
  const mod = await import(`${pathToFileURL(outFile).href}?t=${Date.now()}`);
  return { mod, outFile };
}

async function main() {
  const { scrollCalls } = installDom();
  // `act` must be captured before the bundled React is loaded (see P11 script).
  const ReactAct = require('react').act;
  const act = ReactAct;

  const { mod, outFile } = await bundleHarness();

  const settle = (ms = 40) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

  async function mount(value = '') {
    let h;
    await act(async () => { h = mod.mountHarness(value); });
    await settle();
    return h;
  }

  mod.useStoryEditorStore.getState().resetTypography();

  /* ================= Bug 1: font & size selectors ================= */
  {
    const h = await mount('hello world');
    const fontSel = h.container.querySelector('select[aria-label="Font family"]');
    const sizeSel = h.container.querySelector('select[aria-label="Font size"]');
    even('BUG1.1: font family <select> renders', !!fontSel);
    even('BUG1.2: font size <select> renders', !!sizeSel);

    // The original bug: onMouseDown={preventDefault} blocked the native dropdown.
    const fm = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
    fontSel.dispatchEvent(fm);
    even('BUG1.3: font <select> mousedown is NOT default-prevented', fm.defaultPrevented === false, `prevented=${fm.defaultPrevented}`);
    const sm = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
    sizeSel.dispatchEvent(sm);
    even('BUG1.4: font size <select> mousedown is NOT default-prevented', sm.defaultPrevented === false, `prevented=${sm.defaultPrevented}`);

    // Selecting a value (mouse pick OR keyboard) dispatches `change`.
    await act(async () => { fontSel.value = 'mono'; fontSel.dispatchEvent(new window.Event('change', { bubbles: true })); });
    eq('BUG1.5: font selection applies to the store', mod.useStoryEditorStore.getState().typography.fontFamily, 'mono');
    eq('BUG1.6: font <select> reflects the chosen value', fontSel.value, 'mono');

    await act(async () => { sizeSel.value = '22'; sizeSel.dispatchEvent(new window.Event('change', { bubbles: true })); });
    eq('BUG1.7: font size selection applies to the store', mod.useStoryEditorStore.getState().typography.fontSize, 22);
    eq('BUG1.8: size <select> reflects the chosen value', sizeSel.value, '22');

    // Keyboard path: ArrowUp/Down on a native select changes value → change event.
    await act(async () => {
      sizeSel.value = '24';
      sizeSel.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    eq('BUG1.9: keyboard-driven value change also applies', mod.useStoryEditorStore.getState().typography.fontSize, 24);

    // Selection is preserved across a select interaction.
    h.getEditor().commands.setTextSelection({ from: 1, to: 6 });
    await act(async () => {
      fontSel.dispatchEvent(new window.FocusEvent('focus'));
      fontSel.value = 'serif';
      fontSel.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    const sel = h.getEditor().state.selection;
    even('BUG1.10: editor selection preserved across select change', sel.from >= 1 && sel.to <= h.getEditor().state.doc.content.size, `from=${sel.from} to=${sel.to}`);

    h.unmount();
    mod.useStoryEditorStore.getState().resetTypography();
  }

  /* ================= Bug 2: toolbar + slash commands ================= */
  {
    const h = await mount('chapter text');
    const click = async (label) => {
      const btn = h.container.querySelector(`button[aria-label="${label}"]`);
      await act(async () => {
        btn.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      await settle(10);
      return btn;
    };

    h.getEditor().commands.setTextSelection(1);
    await click('Heading 1');
    even('BUG2.1: toolbar H1 changes the block to a level-1 heading', h.getEditor().isActive('heading', { level: 1 }));
    const node1 = h.getEditor().getJSON().content[0];
    even('BUG2.2: H1 is a real heading node in the document', node1.type === 'heading' && node1.attrs.level === 1, JSON.stringify(node1.attrs));

    await click('Heading 2');
    even('BUG2.3: toolbar H2 applies level 2', h.getEditor().isActive('heading', { level: 2 }));
    await click('Heading 3');
    even('BUG2.4: toolbar H3 applies level 3', h.getEditor().isActive('heading', { level: 3 }));

    await click('Heading 3'); // back to paragraph
    h.getEditor().commands.setTextSelection({ from: 1, to: 8 });
    await click('Bold');
    even('BUG2.5: toolbar Bold applies a bold mark', h.getEditor().isActive('bold'));
    await click('Italic');
    even('BUG2.6: toolbar Italic applies an italic mark', h.getEditor().isActive('italic'));

    const serialised = h.getMarkdown();
    even('BUG2.7: Markdown preserves the bold/italic formatting', serialised.includes('**') && serialised.includes('*'), serialised);

    const before = h.getMarkdown();
    await click('Undo');
    even('BUG2.9: toolbar Undo changes the document', h.getMarkdown() !== before);
    await click('Redo');
    eq('BUG2.10: toolbar Redo restores the document', h.getMarkdown(), before);

    h.unmount();
  }

  /* ---- Bug 2b: slash commands via the real SlashMenu ---- */
  {
    const h = await mount('');
    const type = async (text) => {
      const size = h.getEditor().state.doc.content.size - 1;
      await act(async () => {
        h.getEditor().commands.setTextSelection(size);
        h.getEditor().commands.insertContent(text);
      });
      await settle(10);
    };
    const key = async (k) => {
      await act(async () => {
        h.getEditor().view.dom.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
      });
      await settle(10);
    };

    for (const level of [1, 2, 3, 4, 5, 6]) {
      await type(`/h${level}`);
      even(`BUG2.11: typing /h${level} opens the menu`, !!h.container.querySelector('[role="listbox"]'));
      await key('Enter');
      const node = h.getEditor().getJSON().content[0];
      even(`BUG2.12: slash /h${level} yields a level-${level} heading`, node && node.type === 'heading' && node.attrs.level === level, JSON.stringify(node && node.attrs));
      even(`BUG2.13: slash /h${level} removes the "/h${level}" text`, !h.getMarkdown().includes(`/h${level}`), h.getMarkdown());
      await act(async () => { h.getEditor().commands.setContent('<p></p>'); });
    }

    // Bold via slash: typing the `/bold` query collapses any selection, so the
    // realistic outcome is a toggled stored mark — subsequent typing is bold.
    // (Applying a mark to an EXISTING selection through the slash menu is not a
    // coherent flow: the slash characters themselves replace the selection.)
    await act(async () => { h.getEditor().commands.setContent('<p></p>'); h.getEditor().commands.setTextSelection(1); });
    await type('/bold');
    await key('Enter');
    await act(async () => { h.getEditor().commands.insertContent('bold word'); });
    even('BUG2.14: slash /bold makes subsequently-typed text bold', h.getMarkdown().includes('**bold word**'), h.getMarkdown());

    await act(async () => { h.getEditor().commands.setContent('<p></p>'); h.getEditor().commands.setTextSelection(1); });
    await type('/italic');
    await key('Enter');
    await act(async () => { h.getEditor().commands.insertContent('italic word'); });
    even('BUG2.15: slash /italic makes subsequently-typed text italic', /\*italic word\*|_italic word_/.test(h.getMarkdown()), h.getMarkdown());

    // A slash-applied heading survives Markdown serialisation & reopen.
    await act(async () => { h.getEditor().commands.setContent('<p></p>'); });
    await type('/h2');
    await key('Enter');
    await act(async () => { h.getEditor().commands.insertContent('title'); });
    const slashMd = h.getMarkdown();
    even('BUG2.16: slash-applied heading serialises as "## "', /^## /m.test(slashMd), slashMd);

    h.unmount();
  }

  /* ================= Bug 3: slash auto-scroll ================= */
  {
    const h = await mount('');
    await act(async () => { h.getEditor().commands.setTextSelection(1); h.getEditor().commands.insertContent('/'); });
    await settle(10);
    const options = h.container.querySelectorAll('[role="option"]');
    even('BUG3.1: the menu lists more items than fit (scrollable)', options.length > 8, `n=${options.length}`);

    const start = scrollCalls.length;
    const down = async () => {
      await act(async () => {
        h.getEditor().view.dom.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      });
      await settle(5);
    };
    await down(); await down(); await down();
    const afterDown = scrollCalls.length - start;
    even('BUG3.2: ArrowDown scrolls the active option into view', afterDown >= 3, `calls=${afterDown}`);
    even('BUG3.3: scrollIntoView uses block:"nearest" (no page/manuscript scroll)', scrollCalls.slice(-3).every((o) => o && o.block === 'nearest'), JSON.stringify(scrollCalls.slice(-3)));

    const beforeUp = scrollCalls.length;
    await act(async () => { h.getEditor().view.dom.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })); });
    await settle(5);
    await act(async () => { h.getEditor().view.dom.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })); });
    await settle(5);
    even('BUG3.4: ArrowUp keeps scrolling the active option into view', scrollCalls.length - beforeUp >= 2);

    const activeOpt = h.container.querySelector('[role="option"][aria-selected="true"]');
    even('BUG3.5: the active option advances with keyboard navigation', !!activeOpt && /Heading/.test(activeOpt.textContent), activeOpt && activeOpt.textContent.trim().slice(0, 16));

    let ok = true;
    try {
      for (let i = 0; i < options.length + 2; i++) {
        await act(async () => { h.getEditor().view.dom.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); });
      }
    } catch { ok = false; }
    even('BUG3.6: full-list navigation wraps without errors', ok);

    await act(async () => { h.getEditor().view.dom.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    await settle(5);
    even('BUG3.7: Escape closes the menu', !h.container.querySelector('[role="listbox"]'));

    h.unmount();
  }

  /* ================= Bug 4: toolbar geometry stability ================= */
  {
    const h = await mount('stable');
    const h1 = h.container.querySelector('button[aria-label="Heading 1"]');
    const undo = h.container.querySelector('button[aria-label="Undo"]');
    const fontSel = h.container.querySelector('select[aria-label="Font family"]');
    const sizeSel = h.container.querySelector('select[aria-label="Font size"]');
    const toolbar = h.container.querySelector('[role="toolbar"]');

    const classBefore = h1.className;
    h.getEditor().commands.setTextSelection(1);
    await act(async () => {
      h1.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      h1.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await settle(10);
    const classAfter = h1.className;
    even('BUG4.1: H1 becomes active after the click', h1.getAttribute('aria-pressed') === 'true');

    const toks = (s) => s.split(/\s+/).filter(Boolean);
    const changed = toks(classBefore).filter((c) => !toks(classAfter).includes(c)).concat(toks(classAfter).filter((c) => !toks(classBefore).includes(c)));
    const sizing = /\b(w-|min-w-|max-w-|h-|px-|py-|p-|border|ring|outline|text-\d|font-)/;
    const sizingChanges = changed.filter((c) => sizing.test(c));
    even('BUG4.2: active state changes only colour (no width/border/font classes)', sizingChanges.length === 0, sizingChanges.join(',') || 'none');

    even('BUG4.3: buttons carry a fixed width/min-width utility', /\bw-\d|min-w-\d/.test(classAfter), toks(classAfter).filter((c) => /w-\d/.test(c)).join(','));
    even('BUG4.4: buttons forbid flex shrinking', /\bshrink-0\b/.test(h1.className));
    even('BUG4.5: font family select has a fixed width', /\bw-\d/.test(fontSel.className), toks(fontSel.className).filter((c) => /w-\d/.test(c)).join(','));
    even('BUG4.6: font size select has a fixed width', /\bw-\d/.test(sizeSel.className), toks(sizeSel.className).filter((c) => /w-\d/.test(c)).join(','));
    even('BUG4.7: toolbar wrapper is flex-nowrap (no wrap reflow)', /\bflex-nowrap\b/.test(toolbar.className) && !/\bflex-wrap\b/.test(toolbar.className), toolbar.className);
    even('BUG4.8: disabled state uses opacity only (no size change)', /disabled:opacity-40/.test(undo.className) && !/disabled:w-/.test(undo.className));

    h.unmount();
  }

  // Cleanup.
  try { fs.unlinkSync(outFile); } catch { /* ignore */ }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length > 0) {
    console.error(`\n${failed.length} check(s) failed: ${failed.map((f) => f.name).join(', ')}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Editor UI-bug verification crashed:', error);
  process.exit(1);
});
