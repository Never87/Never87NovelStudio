/**
 * Story Editor — toolbar relocation verification (Node-level, no browser).
 *
 * The Minimal Toolbar was moved OUT of the chapter title row and INTO the
 * Manuscript top bar (the row with "Manuscript · N chapters · Project selector
 * … Versions · Import/Export · Focus"). Toolbar behaviour, commands, slash menu
 * and the editor instance are unchanged.
 *
 * A pixel/browser check belongs to the real-browser suite (verify:workspace:ui).
 * What is verifiable in Node is the SHIPPED STRUCTURE and WIRING, so this script
 * asserts (against the real source the app builds from):
 *
 *   1. There is EXACTLY ONE <EditorToolbar> in the WritingPanel tree (no second
 *      copy) — the "toolbar renders once" requirement.
 *   2. That single toolbar lives in the Workspace (Manuscript) header, and the
 *      chapter header no longer renders one.
 *   3. The toolbar is placed BETWEEN the project info and the right-hand actions,
 *      with responsive classes that keep it on one row on wide screens and let it
 *      wrap to its own full-width row on narrow ones (no overlap / no clipping /
 *      no horizontal overflow / Font selects stay usable).
 *   4. The editor is lifted up via a REFERENCE callback (`onEditorReady`) and the
 *      chapter's lock state via `onLockedChange` — the editor instance is NOT
 *      moved, and `MarkdownEditor`'s `key` does not depend on any of the new
 *      layout state, so toggling Focus/Normal never remounts the editor.
 *   5. Focus Mode visibility is unchanged (still handled by the shell /
 *      ProjectScopedPage; the header toolbar is rendered in BOTH modes because it
 *      lives on the same surface).
 *
 * Usage: npm run verify:editor-toolbar-layout
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WP = read('src/modules/editor/WritingPanel.tsx');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
}
function even(name, condition, detail) {
  record(name, Boolean(condition), detail);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** Returns the source between `start` marker and the matching next `end` marker. */
function sliceBetween(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start < 0) return '';
  const end = src.indexOf(endMarker, start + startMarker.length);
  if (end < 0) return src.slice(start);
  return src.slice(start, end);
}

/* -------------------------------------------------------------------------- */
/* 1. Exactly one toolbar in the whole writing panel                          */
/* -------------------------------------------------------------------------- */
{
  const renders = WP.match(/<EditorToolbar\b/g) || [];
  even('L1: exactly ONE <EditorToolbar> is rendered in WritingPanel', renders.length === 1, `count=${renders.length}`);
}

/* -------------------------------------------------------------------------- */
/* 2. The single toolbar lives in the Workspace (Manuscript) header, not the  */
/*    ChapterEditorSurface header.                                            */
/* -------------------------------------------------------------------------- */
{
  const workspaceBody = sliceBetween(WP, 'function Workspace(', 'function ChapterStoryRail(');
  const surfaceBody = sliceBetween(WP, 'function ChapterEditorSurface(', 'function Resizer(');

  even('L2: <EditorToolbar> is rendered inside the Workspace header', /<EditorToolbar\b/.test(workspaceBody));
  even('L3: <EditorToolbar> is NOT rendered inside ChapterEditorSurface', !/<EditorToolbar\b/.test(surfaceBody));

  // The Workspace header must still carry the "Manuscript" title + the right-hand
  // actions (Versions / Import / Focus) on the SAME top bar as the toolbar.
  even('L4: the Manuscript top bar still shows the "Manuscript" title', /Manuscript<\/h2>/.test(workspaceBody));
  even('L5: the top bar still shows the right-hand actions', /Versions/.test(workspaceBody) && /Import \/ Export/.test(workspaceBody) && /(Exit Focus|Focus)/.test(workspaceBody));

  // The chapter header keeps identity + word count + save (but no toolbar).
  even('L6: chapter header keeps the chapter title (h3)', /<h3 className="text-ink truncate text-sm font-semibold">/.test(surfaceBody));
  even('L7: chapter header keeps word count + save', /words/.test(surfaceBody) && /label="Save now"/.test(surfaceBody));
}

/* -------------------------------------------------------------------------- */
/* 3. Responsive placement: one row on wide screens, own row on narrow ones.  */
/*    The toolbar wrapper must sit BETWEEN left info and right actions in DOM  */
/*    order, grow in the middle on wide screens, and drop to a full-width row   */
/*    below `lg` without clipping (max-w-full) or horizontal overflow.          */
/* -------------------------------------------------------------------------- */
{
  const workspaceBody = sliceBetween(WP, 'function Workspace(', 'function ChapterStoryRail(');

  // The toolbar wrapper carries the responsive contract.
  const wrapper = (workspaceBody.match(/<div className="order-last[^"]*"[\s\S]*?<EditorToolbar/) || [''])[0];
  even('L8: toolbar wrapper exists and wraps <EditorToolbar>', wrapper.length > 0);
  even('L9: toolbar drops to its own row below lg (order-last + w-full)', /order-last/.test(wrapper) && /w-full/.test(wrapper));
  even('L10: toolbar grows in the middle on wide screens (lg:flex-1)', /lg:flex-1/.test(wrapper));
  even('L11: toolbar is capped to its container (max-w-full, no horizontal overflow)', /max-w-full/.test(wrapper));
  even('L12: wide-screen order places it between info and actions (lg:order-none)', /lg:order-none/.test(wrapper));

  // The toolbar itself may wrap on narrow screens (no clipped controls) but keeps
  // its width-stable nowrap layout on wide screens.
  const toolbarProps = (workspaceBody.match(/<EditorToolbar[\s\S]*?\/>/) || [''])[0];
  even('L13: toolbar is allowed to wrap on narrow screens (max-lg:flex-wrap)', /max-lg:flex-wrap/.test(toolbarProps));
  even('L14: toolbar is full-width on narrow screens, auto on wide', /w-full/.test(toolbarProps) && /lg:w-auto/.test(toolbarProps));

  // DOM order in the top bar: left info block, then toolbar wrapper, then the
  // right-hand actions. Use distinctive JSX markers (not comment words like
  // "Versions" which also appear in the header comment) so the order is real.
  const topBar = sliceBetween(workspaceBody, 'Manuscript top bar', 'Three panels');
  const leftIdx = topBar.indexOf('>Manuscript</h2>');
  const toolbarIdx = topBar.indexOf('<EditorToolbar');
  const actionsIdx = topBar.indexOf('<TypographyMenu'); // first right-hand action control
  even(
    'L15: toolbar sits between project info and right-hand actions in DOM order',
    leftIdx >= 0 && toolbarIdx > leftIdx && actionsIdx > toolbarIdx,
    `left=${leftIdx} toolbar=${toolbarIdx} actions=${actionsIdx}`,
  );
}

/* -------------------------------------------------------------------------- */
/* 4. Editor is lifted by REFERENCE only; toggling layout never remounts.     */
/* -------------------------------------------------------------------------- */
{
  // Workspace holds the editor in state and passes it to the toolbar.
  const workspaceBody = sliceBetween(WP, 'function Workspace(', 'function ChapterStoryRail(');
  even('L16: Workspace holds the editor reference in state', /const \[editor, setEditor\] = useState<Editor \| null>\(null\)/.test(workspaceBody));
  even('L17: Workspace passes the editor ref to the toolbar', /<EditorToolbar\s*\n?\s*editor=\{editor\}/.test(workspaceBody.replace(/\s+/g, ' ')) || /editor=\{editor\}/.test(workspaceBody));
  even('L18: Workspace passes onEditorReady={setEditor} down to the surface', /onEditorReady=\{setEditor\}/.test(workspaceBody));
  even('L19: Workspace passes onLockedChange={setLocked} down to the surface', /onLockedChange=\{setLocked\}/.test(workspaceBody));

  // The surface mirrors the editor/lock UP via callbacks (no lifting the editor).
  const surfaceBody = sliceBetween(WP, 'function ChapterEditorSurface(', 'function Resizer(');
  even('L20: surface mirrors the editor up via onEditorReady(editor)', /onEditorReady\(editor\)/.test(surfaceBody));
  even('L21: surface mirrors the lock state up via onLockedChange', /onLockedChange\(documentLocked\)|onLockedChange\(/.test(surfaceBody));

  // CRITICAL no-remount invariant: the MarkdownEditor key must not depend on any
  // of the new layout state (editor/locked/slashSignal/focusMode/toolbar). It
  // stays keyed by chapter identity + new/open only.
  const keyMatch = (surfaceBody.match(/<MarkdownEditor[\s\S]*?key=\{`[^`]*`\}/) || [''])[0];
  even('L22: MarkdownEditor key does not depend on layout/editor state', keyMatch.length > 0 && !/editor|locked|slashSignal|focusMode/.test(keyMatch), keyMatch.replace(/\s+/g, ' ').slice(0, 90));

  // The old per-surface slashSignal state must be gone (now owned by Workspace).
  even('L23: ChapterEditorSurface no longer owns slashSignal state', !/const \[slashSignal, setSlashSignal\]/.test(surfaceBody));
  even('L24: Workspace owns slashSignal and forwards it to the surface', /slashSignal=\{slashSignal\}/.test(workspaceBody));
}

/* -------------------------------------------------------------------------- */
/* 5. Behaviour preserved: same commands, slash menu, single toolbar.         */
/* -------------------------------------------------------------------------- */
{
  // The toolbar still opens the slash menu via onOpenSlashMenu (same flow).
  even('L25: toolbar wired to open the slash menu', /onOpenSlashMenu=\{\(\) => setSlashSignal\(\(n\) => n \+ 1\)\}/.test(WP));
  // The toolbar still receives `disabled` from the chapter's lock state.
  even('L26: toolbar is disabled for a locked chapter (disabled={locked})', /disabled=\{locked\}/.test(WP));
  // Slash menu still rendered inside the surface, using the forwarded signal.
  const surfaceBody = sliceBetween(WP, 'function ChapterEditorSurface(', 'function Resizer(');
  even('L27: SlashMenu still rendered over the writing surface', /<SlashMenu\b/.test(surfaceBody));
  even('L28: SlashMenu uses the forwarded slashSignal', /<SlashMenu editor=\{editor\} openSignal=\{slashSignal\}/.test(surfaceBody));
}

/* -------------------------------------------------------------------------- */
/* 6. Focus Mode visibility rules unchanged.                                  */
/* -------------------------------------------------------------------------- */
{
  // The header (with toolbar) is rendered unconditionally in the Workspace tree
  // (both modes); Focus Mode only hides shell chrome in AppShell/ProjectScopedPage.
  const workspaceBody = sliceBetween(WP, 'function Workspace(', 'function ChapterStoryRail(');
  const headerBlock = sliceBetween(workspaceBody, 'Manuscript top bar', 'Three panels');
  // The top-bar wrapper must NOT be hidden/omitted by a focusMode guard. Assert
  // the wrapper <div> itself is plain (not preceded by a `{!focusMode &&`/ternary).
  const wrapperOpen = (headerBlock.match(/<div className="border-line flex flex-wrap[^"]*"/) || [''])[0];
  even('L29: Manuscript header wrapper is rendered unconditionally (no focusMode guard on the container)', wrapperOpen.length > 0 && !/\{!focusMode\s*&&/.test(headerBlock.slice(0, headerBlock.indexOf(wrapperOpen) + 1)) && !/\{focusMode\s*\?/.test(headerBlock.slice(0, headerBlock.indexOf(wrapperOpen) + 1)), wrapperOpen.slice(0, 60));

  const appShell = read('src/components/layout/AppShell.tsx');
  even('L30: shell still hides sidebar/topbar in Focus Mode (unchanged rules)', /!focusMode \? \(/.test(appShell) || /focusMode \? /.test(appShell));

  // The toolbar component itself is unchanged in behaviour (renders once, same
  // controls): Font family, Font size, H1/H2/H3, Bold, Italic, Undo, Redo, Slash.
  const toolbar = read('src/modules/editor/EditorToolbar.tsx');
  const controls = ['aria-label="Font family"', 'aria-label="Font size"', 'text="H1"', 'text="H2"', 'text="H3"', 'label="Bold"', 'label="Italic"', 'label="Undo"', 'label="Redo"', 'label="Insert command"'];
  const missing = controls.filter((c) => !toolbar.includes(c));
  even('L31: every toolbar control is still present (Font/Size/H1-3/B/I/Undo/Redo/Slash)', missing.length === 0, missing.join(',') || 'all present');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length > 0) {
  console.error(`\n${failed.length} check(s) failed: ${failed.map((f) => f.name).join(', ')}`);
  process.exit(1);
}
