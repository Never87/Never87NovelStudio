/**
 * Story Editor — Warm Paper appearance verification (focused, Node-level).
 *
 * The Warm Paper theme is a scoped CSS token remap plus a persisted preference.
 * What is VERIFIABLE in Node (no browser) is the PREFERENCE + PERSISTENCE layer
 * and the wiring that scopes the theme to the editor — not pixel rendering. This
 * script therefore checks:
 *
 *   1. DEFAULT compatibility — the initial appearance is `default` (today's
 *      look), so existing users see no change.
 *   2. Warm Paper selection + persistence — `setEditorAppearance('warm-paper')`
 *      updates state immediately and persists under `n87-story-editor`.
 *   3. Immediate switching — the store value updates synchronously (no reload).
 *   4. Persistence survivability — a reload (fresh module reading the same
 *      storage) restores the chosen appearance.
 *   5. Legacy migration — a persisted blob WITHOUT `editorAppearance` (old user)
 *      merges to `default` and keeps their typography/layout untouched.
 *   6. Global-theme isolation — changing editor appearance never touches the
 *      app theme key (`n87-theme`), and vice-versa.
 *   7. Structural scoping — the editor surface carries `data-editor-appearance`
 *      and the Warm Paper CSS is scoped to that attribute (never to `:root`/
 *      `.dark`), so it cannot leak into Sidebar/Topbar/Dashboard.
 *   8. No-remount / soft-wrap invariants on the editor wiring.
 *
 * NOT claimed: pixel/browser visual verification (not performed here).
 *
 * Usage: npm run verify:editor-appearance
 */
const { importBundled, cleanupTemp } = require('./lib/p4-bundler.cjs');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
}
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  record(name, ok, ok ? undefined : `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}
function even(name, condition, detail) {
  record(name, Boolean(condition), detail);
}

/* -------------------------------------------------------------------------- */
/* Minimal in-memory localStorage shim (zustand `persist` needs it)           */
/* -------------------------------------------------------------------------- */

function installLocalStorage(seed = {}) {
  const store = new Map(Object.entries(seed));
  const localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => void store.set(key, String(value)),
    removeItem: (key) => void store.delete(key),
    clear: () => store.clear(),
    key: (i) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  globalThis.localStorage = localStorage;
  globalThis.window = globalThis.window ?? {};
  globalThis.window.localStorage = localStorage;
  return {
    read: (key) => (store.has(key) ? JSON.parse(store.get(key)) : null),
    raw: (key) => (store.has(key) ? store.get(key) : null),
    reset: () => store.clear(),
  };
}

const STORE_KEY = 'n87-story-editor';
const THEME_KEY = 'n87-theme';

async function loadStore(name) {
  const path = require('node:path');
  const alias = { '@': path.resolve(__dirname, '..', 'src') };
  // Bundle fresh each time so module-level `persist` re-reads the shimmed storage.
  return importBundled('src/stores/story-editor-store.ts', name, { alias });
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  const fs = require('node:fs');
  const path = require('node:path');

  /* ==================================================================== */
  /* 1 + 3. Default value + immediate selection                           */
  /* ==================================================================== */
  {
    const storage = installLocalStorage();
    storage.reset();
    const mod = await loadStore('appearance-default');
    const state = mod.useStoryEditorStore.getState();

    eq('default: initial editorAppearance is "default"', state.editorAppearance, 'default');
    eq('default: constant DEFAULT_EDITOR_APPEARANCE is "default"', mod.DEFAULT_EDITOR_APPEARANCE, 'default');
    eq('default: appearances list is [default, warm-paper]', mod.EDITOR_APPEARANCES, ['default', 'warm-paper']);

    // Immediate switch (no reload / no async).
    state.setEditorAppearance('warm-paper');
    eq('switch: selection applies immediately (state)', mod.useStoryEditorStore.getState().editorAppearance, 'warm-paper');

    // Persisted synchronously by zustand persist.
    const blob = storage.read(STORE_KEY);
    eq('switch: persisted to n87-story-editor', blob && blob.state && blob.state.editorAppearance, 'warm-paper');
  }

  /* ==================================================================== */
  /* 2 + 4. Persistence survives a reload (fresh module, same storage)    */
  /* ==================================================================== */
  {
    const storage = installLocalStorage();
    storage.reset();
    const first = await loadStore('appearance-persist-1');
    first.useStoryEditorStore.getState().setEditorAppearance('warm-paper');
    // Also nudge typography so we can prove it is preserved across reload.
    first.useStoryEditorStore.getState().updateTypography({ fontSize: 19 });

    // Simulate a reload: a brand-new module instance reads the SAME storage.
    const reloaded = await loadStore('appearance-persist-2');
    const state = reloaded.useStoryEditorStore.getState();
    eq('persist: warm-paper survives reload', state.editorAppearance, 'warm-paper');
    eq('persist: typography preserved alongside appearance', state.typography.fontSize, 19);

    // And switching back persists as default.
    state.setEditorAppearance('default');
    eq('persist: switching back persists "default"', storage.read(STORE_KEY).state.editorAppearance, 'default');
  }

  /* ==================================================================== */
  /* 5. Legacy migration — old users without the field                    */
  /* ==================================================================== */
  {
    const storage = installLocalStorage();
    storage.reset();
    // A blob written by an OLDER build: typography + layout, NO editorAppearance.
    globalThis.localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        version: 0,
        state: {
          manuscriptCollapsed: true,
          aiCollapsed: true,
          manuscriptWidth: 300,
          aiWidth: 320,
          typography: { fontFamily: 'sans', fontSize: 21, lineHeight: 'relaxed', indent: 'first', maxWidth: 640 },
        },
      }),
    );
    const mod = await loadStore('appearance-legacy');
    const state = mod.useStoryEditorStore.getState();

    eq('legacy: missing editorAppearance resolves to "default"', state.editorAppearance, 'default');
    eq('legacy: typography is NOT reset (fontFamily)', state.typography.fontFamily, 'sans');
    eq('legacy: typography is NOT reset (fontSize)', state.typography.fontSize, 21);
    eq('legacy: layout is NOT reset (manuscriptWidth)', state.manuscriptWidth, 300);
    eq('legacy: layout is NOT reset (aiCollapsed)', state.aiCollapsed, true);
  }

  /* ==================================================================== */
  /* 6. Global-theme isolation (editor appearance ⇄ app theme)            */
  /* ==================================================================== */
  {
    const storage = installLocalStorage();
    storage.reset();
    // Pre-seed the app theme (as the theme store would have written it).
    globalThis.localStorage.setItem(THEME_KEY, JSON.stringify({ state: { mode: 'dark' } }));
    const themeBefore = storage.raw(THEME_KEY);

    const mod = await loadStore('appearance-isolation');
    mod.useStoryEditorStore.getState().setEditorAppearance('warm-paper');

    const themeAfter = storage.raw(THEME_KEY);
    eq('isolation: app theme key is untouched by editor appearance', themeAfter, themeBefore);
    even(
      'isolation: editor appearance stored under its OWN key (not n87-theme)',
      storage.read(STORE_KEY) !== null && storage.read(STORE_KEY).state.editorAppearance === 'warm-paper',
    );
    // The app theme value itself is still 'dark'.
    eq('isolation: app theme mode still "dark"', storage.read(THEME_KEY).state.mode, 'dark');
  }

  /* ==================================================================== */
  /* 7. Structural scoping — writing surface attribute + CSS scoping      */
  /* ==================================================================== */
  {
    const root = path.resolve(__dirname, '..');

    // (a) EditorSurface applies `data-editor-appearance` on its wrapper.
    const surface = fs.readFileSync(path.join(root, 'src/modules/editor/EditorSurface.tsx'), 'utf8');
    even(
      'scope: EditorSurface sets data-editor-appearance',
      /data-editor-appearance=\{appearance\}/.test(surface),
    );
    even(
      'scope: EditorSurface defaults appearance to "default"',
      /appearance\s*=\s*'default'/.test(surface),
    );

    // (b) The only consumer that passes the appearance is the manuscript surface.
    const writing = fs.readFileSync(path.join(root, 'src/modules/editor/WritingPanel.tsx'), 'utf8');
    even(
      'scope: WritingPanel passes appearance to EditorSurface',
      /<EditorSurface[\s\S]*?appearance=\{editorAppearance\}/.test(writing),
    );

    // (c) Warm Paper CSS is scoped to the attribute — never to :root or .dark.
    const css = fs.readFileSync(path.join(root, 'src/styles/index.css'), 'utf8');
    even(
      'scope: Warm Paper CSS uses [data-editor-appearance=warm-paper] selectors',
      /\[data-editor-appearance='warm-paper'\]/.test(css),
    );

    // The warm-paper palette values must NOT be declared on :root or .dark.
    const paletteValues = ['#f3e9dc', '#e9d8c5', '#493d35', '#806b5c', '#a77d70', '#d8c7b5'];
    const rootDarkBlocks = (() => {
      const out = [];
      const re = /(\.dark|:root)\s*\{/g;
      let m;
      while ((m = re.exec(css))) {
        let depth = 0;
        let i = css.indexOf('{', m.index);
        const start = i;
        for (; i < css.length; i += 1) {
          if (css[i] === '{') depth += 1;
          else if (css[i] === '}') {
            depth -= 1;
            if (depth === 0) {
              out.push(css.slice(start, i + 1));
              break;
            }
          }
        }
      }
      return out.join('\n').toLowerCase();
    })();
    let leaked = false;
    for (const value of paletteValues) {
      if (rootDarkBlocks.includes(value.toLowerCase())) leaked = true;
    }
    even('scope: Warm Paper palette is NOT declared on :root/.dark (no global leak)', !leaked);
  }

  /* ==================================================================== */
  /* 8. No remount / wrap / data invariants on the editor wiring          */
  /* ==================================================================== */
  {
    const root = path.resolve(__dirname, '..');
    const writing = fs.readFileSync(path.join(root, 'src/modules/editor/WritingPanel.tsx'), 'utf8');

    // Appearance is passed as a PROP (no `key` change), so switching theme does
    // not remount the editor. The MarkdownEditor `key` must NOT include the
    // appearance (that would force a rebuild on switch).
    const mdKeyLine = (writing.match(/key=\{`\$\{chapterId\}[^`]*`\}/) || [''])[0];
    even('no-remount: editor key does not depend on appearance', mdKeyLine.length > 0 && !/ppearance/.test(mdKeyLine));

    // Soft-wrap declaration still present in the writing surface CSS.
    const css = fs.readFileSync(path.join(root, 'src/styles/index.css'), 'utf8');
    even('wrap: prose editor keeps white-space: pre-wrap (soft wrap)', /white-space:\s*pre-wrap/.test(css));
    even('wrap: prose editor keeps overflow-wrap: anywhere', /overflow-wrap:\s*anywhere/.test(css));
  }

  cleanupTemp();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length > 0) {
    console.error(`\n${failed.length} check(s) failed: ${failed.map((f) => f.name).join(', ')}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Editor appearance verification crashed:', error);
  process.exit(1);
});
