import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import {
  AlertTriangle,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  History,
  Lock,
  Maximize2,
  Minimize2,
  PanelLeft,
  PanelRight,
  Save,
  Upload,
} from 'lucide-react';
import { Badge, Button, Card, EmptyState, IconButton } from '@/components/ui';
import { useOutline } from '@/hooks';
import type { Chapter, DraftVersion } from '@/types';
import { manuscriptService } from '@/services';
import { cn } from '@/utils/cn';
import { formatRelative } from '@/utils/date';
import { countWords, excerpt } from '@/utils/manuscript-text';
import { useStoryEditorStore, PANEL_WIDTH_BOUNDS } from '@/stores/story-editor-store';
import { MarkdownEditor } from './MarkdownEditor';
import { useChapterEditor } from './use-chapter-editor';
import { VersionHistoryDialog } from './VersionHistoryDialog';
import { ImportExportDialog } from './ImportExportDialog';
import { ManuscriptNav } from './ManuscriptNav';
import { StoryPanel } from './StoryPanel';
import { TypographyMenu } from './TypographyMenu';
import { ProjectSwitcher } from './ProjectSwitcher';
import { EditorSurface } from './EditorSurface';

export interface WritingPanelProps {
  projectId: string;
  /**
   * Optional chapter to open first (deep-link support). When provided and the
   * chapter exists in this project's outline, the editor opens it instead of the
   * default first chapter. Used by the Dashboard's "Continue Writing" action so
   * the author lands on the exact chapter they last edited. Ignored (falls back
   * to the first chapter) when the id is not present in the outline.
   */
  initialChapterId?: string | null;
  /**
   * Optional handler to switch to a different project. When provided, a compact
   * in-editor project selector (with "New Project") is shown in the header —
   * reusing the shared project services. Omitted inside surfaces that already
   * own a project selector (e.g. the Story Editor route header).
   */
  onSwitchProject?: (projectId: string) => void;
}

/**
 * Writing tab (P4 → upgraded): the three-panel story writing workspace.
 *
 * Layout (Normal mode): Manuscript panel (left) · editor (center, largest) ·
 * Story panel (right: AI / Links / Continuity / Ideas). Both side panels are
 * independently collapsible and resizable, returning space to the center when
 * collapsed. Focus Mode hides global chrome (via the shell) and peripheral UI,
 * keeping the SAME editor instance and data state — nothing is remounted.
 *
 * The editor never owns persistence — every keystroke goes through
 * `useChapterEditor`, which debounces, serialises and revision-checks the save.
 */
export function WritingPanel({ projectId, initialChapterId, onSwitchProject }: WritingPanelProps) {
  const { outline, status: outlineStatus, loading, refresh: refreshOutline } = useOutline(projectId);
  const [chapterId, setChapterId] = useState<string | null>(initialChapterId ?? null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);

  const chapters = outline.flatMap((entry) => entry.chapters);

  // Select the requested deep-link chapter once the outline has loaded.
  useEffect(() => {
    if (!initialChapterId) return;
    if (chapters.length === 0) return;
    if (chapters.some((chapter) => chapter.id === initialChapterId)) {
      setChapterId((current) => (current === initialChapterId ? current : initialChapterId));
    }
  }, [initialChapterId, chapters]);

  // Open the first chapter by default so the tab is never a dead end.
  useEffect(() => {
    if (!chapterId && chapters.length > 0) setChapterId(chapters[0].id);
  }, [chapterId, chapters]);

  // If the open chapter disappears (deleted in another tab), fall back.
  useEffect(() => {
    if (chapterId && !chapters.some((chapter) => chapter.id === chapterId)) {
      setChapterId(chapters[0]?.id ?? null);
    }
  }, [chapterId, chapters]);

  // Reset focus mode when this panel unmounts (e.g. navigating away), so the
  // shell never stays chromeless after leaving the editor.
  const setFocusMode = useStoryEditorStore((state) => state.setFocusMode);
  useEffect(() => () => setFocusMode(false), [setFocusMode]);

  if (outlineStatus === 'error') {
    return (
      <Card padding="lg">
        <p className="text-muted text-sm">The outline could not be loaded, so the editor is unavailable.</p>
      </Card>
    );
  }

  if (loading) {
    return (
      <Card padding="lg">
        <p className="text-subtle text-xs" role="status">
          Loading chapters…
        </p>
      </Card>
    );
  }

  if (chapters.length === 0) {
    return (
      <div className="space-y-4">
        <EmptyState
          icon={<BookOpen className="size-5" aria-hidden />}
          title="No chapters to write yet"
          description="Create a volume and chapter in the panel to start writing — or import a Markdown draft to create them in bulk."
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                iconLeft={<Upload className="size-3.5" />}
                onClick={() => setTransferOpen(true)}
              >
                Import Markdown
              </Button>
            </div>
          }
        />
        {/* The in-editor creator is still available so an empty project can be
            started without leaving the editor. */}
        <div className="mx-auto max-w-xs">
          <ManuscriptNav
            projectId={projectId}
            outline={outline}
            activeChapterId={chapterId}
            onSelectChapter={setChapterId}
            onChanged={(selectId) => {
              void refreshOutline().then(() => {
                if (selectId) setChapterId(selectId);
              });
            }}
          />
        </div>
        <ImportExportDialog
          open={transferOpen}
          projectId={projectId}
          onClose={() => setTransferOpen(false)}
          onImported={() => void refreshOutline()}
        />
      </div>
    );
  }

  return (
    <Workspace
      projectId={projectId}
      outline={outline}
      chapters={chapters}
      chapterId={chapterId}
      onSelectChapter={setChapterId}
      onOutlineChanged={(selectId) => {
        void refreshOutline().then(() => {
          if (selectId) setChapterId(selectId);
        });
      }}
      historyOpen={historyOpen}
      onHistoryOpenChange={setHistoryOpen}
      transferOpen={transferOpen}
      onTransferOpenChange={setTransferOpen}
      onSwitchProject={onSwitchProject}
    />
  );
}

/* ------------------------------- Workspace ------------------------------- */

interface WorkspaceProps {
  projectId: string;
  outline: ReturnType<typeof useOutline>['outline'];
  chapters: Chapter[];
  chapterId: string | null;
  onSelectChapter: (id: string) => void;
  onOutlineChanged: (selectId?: string) => void;
  historyOpen: boolean;
  onHistoryOpenChange: (open: boolean) => void;
  transferOpen: boolean;
  onTransferOpenChange: (open: boolean) => void;
  onSwitchProject?: (id: string) => void;
}

/**
 * The three-panel workspace shell. Owns the responsive/collapsible/resizable
 * layout and Focus Mode. The center editor + right Story panel live in
 * `ChapterEditorSurface`, which renders the SINGLE editor instance regardless of
 * mode — toggling Focus Mode only changes surrounding chrome, never the editor.
 */
function Workspace({
  projectId,
  outline,
  chapters,
  chapterId,
  onSelectChapter,
  onOutlineChanged,
  historyOpen,
  onHistoryOpenChange,
  transferOpen,
  onTransferOpenChange,
  onSwitchProject,
}: WorkspaceProps) {
  const manuscriptCollapsed = useStoryEditorStore((s) => s.manuscriptCollapsed);
  const manuscriptWidth = useStoryEditorStore((s) => s.manuscriptWidth);
  const toggleManuscript = useStoryEditorStore((s) => s.toggleManuscript);
  const setManuscriptWidth = useStoryEditorStore((s) => s.setManuscriptWidth);
  const focusMode = useStoryEditorStore((s) => s.focusMode);
  const toggleFocusMode = useStoryEditorStore((s) => s.toggleFocusMode);

  // Mobile drawers: on small screens the side panels become overlay drawers.
  const [mobileManuscriptOpen, setMobileManuscriptOpen] = useState(false);
  const [mobileAiOpen, setMobileAiOpen] = useState(false);

  // Track the viewport so panels use the VISUAL viewport height on mobile, so
  // the on-screen keyboard never covers the writing area (not just innerHeight).
  useVisualViewportHeight();

  const activeChapter = chapters.find((chapter) => chapter.id === chapterId) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Compact header: title + actions, no oversized chrome. */}
      <div className="border-line flex flex-wrap items-center justify-between gap-2 pb-2">
        <div className="flex min-w-0 items-center gap-2">
          {/* Mobile panel toggles */}
          <div className="flex items-center gap-0.5 md:hidden">
            <IconButton
              label="Manuscript panel"
              icon={<PanelLeft className="size-4" aria-hidden />}
              onClick={() => setMobileManuscriptOpen(true)}
            />
            <IconButton
              label="Story panel"
              icon={<PanelRight className="size-4" aria-hidden />}
              onClick={() => setMobileAiOpen(true)}
            />
          </div>
          <h2 className="text-ink shrink-0 text-sm font-semibold">Manuscript</h2>
          <span className="text-subtle shrink-0 text-2xs">{chapters.length} chapters</span>
          {onSwitchProject ? (
            <ProjectSwitcher
              currentProjectId={projectId}
              onSwitchProject={onSwitchProject}
              className="hidden sm:block"
            />
          ) : null}
        </div>

        <div className="flex items-center gap-1.5">
          <TypographyMenu />
          <Button
            variant="ghost"
            size="sm"
            iconLeft={<History className="size-3.5" />}
            onClick={() => onHistoryOpenChange(true)}
            disabled={!chapterId}
          >
            <span className="hidden sm:inline">Versions</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            iconLeft={<Download className="size-3.5" />}
            onClick={() => onTransferOpenChange(true)}
          >
            <span className="hidden sm:inline">Import / Export</span>
          </Button>
          <Button
            variant="secondary"
            size="sm"
            iconLeft={focusMode ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
            onClick={toggleFocusMode}
            aria-pressed={focusMode}
          >
            <span className="hidden sm:inline">{focusMode ? 'Exit Focus' : 'Focus'}</span>
          </Button>
        </div>
      </div>

      {/* Three panels */}
      <div className="flex min-h-0 flex-1 gap-0">
        {/* Left: manuscript (desktop inline, resizable/collapsible) */}
        <div
          className="hidden shrink-0 md:block"
          style={{ width: manuscriptCollapsed ? undefined : manuscriptWidth }}
        >
          <ManuscriptNav
            projectId={projectId}
            outline={outline}
            activeChapterId={chapterId}
            onSelectChapter={onSelectChapter}
            onChanged={onOutlineChanged}
            collapsed={manuscriptCollapsed}
            onToggleCollapsed={toggleManuscript}
          />
        </div>
        {!manuscriptCollapsed ? (
          <Resizer
            label="Resize manuscript panel"
            onDelta={(dx) => setManuscriptWidth(manuscriptWidth + dx)}
            getWidth={() => manuscriptWidth}
            min={PANEL_WIDTH_BOUNDS.min}
            max={PANEL_WIDTH_BOUNDS.max}
          />
        ) : null}

        {/* Center editor — owns its own right story panel + resize handle so the
            panel can share the live editor instance (no remount on toggle). */}
        <div className="min-w-0 flex-1">
          {chapterId ? (
            <ChapterEditorSurface
              projectId={projectId}
              chapterId={chapterId}
              activeChapter={activeChapter}
              siblings={chapters}
              onOpenChapter={onSelectChapter}
              historyOpen={historyOpen}
              onHistoryOpenChange={onHistoryOpenChange}
            />
          ) : null}
        </div>
      </div>

      {/* Mobile drawers */}
      <MobileDrawer
        open={mobileManuscriptOpen}
        side="left"
        onClose={() => setMobileManuscriptOpen(false)}
        title="Manuscript"
      >
        <ManuscriptNav
          projectId={projectId}
          outline={outline}
          activeChapterId={chapterId}
          onSelectChapter={(id) => {
            onSelectChapter(id);
            setMobileManuscriptOpen(false);
          }}
          onChanged={onOutlineChanged}
        />
      </MobileDrawer>
      <MobileDrawer open={mobileAiOpen} side="right" onClose={() => setMobileAiOpen(false)} title="Story panel">
        {chapterId ? (
          <ChapterStoryRail projectId={projectId} activeChapter={activeChapter} />
        ) : null}
      </MobileDrawer>

      <ImportExportDialog
        open={transferOpen}
        projectId={projectId}
        onClose={() => onTransferOpenChange(false)}
        onImported={() => onOutlineChanged()}
      />
    </div>
  );
}

/**
 * The right rail wrapper. It needs the live editor + prose, which live in
 * `ChapterEditorSurface`. To avoid lifting the editor into the Workspace (which
 * would re-render the editor on every layout change), the StoryPanel is rendered
 * INSIDE `ChapterEditorSurface`. This rail is the desktop container only; it
 * renders a placeholder that the surface portals into is overkill — instead we
 * share state via a small context-free approach: the surface renders the
 * StoryPanel in its own right-hand slot.
 *
 * To keep a single source of truth we render the Desktop StoryPanel inside the
 * surface (see `ChapterEditorSurface`'s `desktopRail`), and this component is
 * used only for the MOBILE drawer, where it recomputes the same data.
 */
function ChapterStoryRail({
  projectId,
  activeChapter,
  aiCollapsed,
  toggleAi,
}: {
  projectId: string;
  activeChapter: Chapter | null;
  aiCollapsed?: boolean;
  toggleAi?: () => void;
}) {
  // The desktop rail needs editor + prose; those are provided by the surface.
  // This fallback rail (mobile drawer) does not have the editor instance, so it
  // renders the panel with a null editor — AI actions degrade gracefully while
  // Links/Continuity/Ideas remain fully functional.
  if (!activeChapter) return null;
  return (
    <StoryPanel
      projectId={projectId}
      chapter={activeChapter}
      prose=""
      editor={null}
      chapterTitle={activeChapter.title}
      locked={activeChapter.status === 'final'}
      collapsed={aiCollapsed}
      onToggleCollapsed={toggleAi}
    />
  );
}

/* --------------------------- Chapter editor ------------------------------ */

function ChapterEditorSurface({
  projectId,
  chapterId,
  activeChapter,
  siblings,
  onOpenChapter,
  historyOpen,
  onHistoryOpenChange,
}: {
  projectId: string;
  chapterId: string;
  activeChapter: Chapter | null;
  siblings: Array<{ id: string; title: string }>;
  onOpenChapter: (chapterId: string) => void;
  historyOpen: boolean;
  onHistoryOpenChange: (open: boolean) => void;
}) {
  const { document, status, error, autosave, onChange, saveNow, flushBeforeAnalysis, retry, reload, createVersion, restoreVersion } =
    useChapterEditor(projectId, chapterId);
  const typography = useStoryEditorStore((s) => s.typography);
  const editorAppearance = useStoryEditorStore((s) => s.editorAppearance);
  const focusMode = useStoryEditorStore((s) => s.focusMode);
  const aiCollapsed = useStoryEditorStore((s) => s.aiCollapsed);
  const aiWidth = useStoryEditorStore((s) => s.aiWidth);
  const toggleAi = useStoryEditorStore((s) => s.toggleAi);
  const setAiWidth = useStoryEditorStore((s) => s.setAiWidth);

  const [liveWords, setLiveWords] = useState(0);
  const [versions, setVersions] = useState<DraftVersion[]>([]);
  const [editor, setEditor] = useState<Editor | null>(null);
  // Deferred prose for the Links/Continuity tabs — updated on a short debounce so
  // we never recompute link detection on every keystroke.
  const [prose, setProse] = useState('');
  const proseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (document) {
      setLiveWords(document.draft.wordCount);
      setProse(document.draft.content);
    }
  }, [document]);

  useEffect(() => {
    if (!document) return;
    let cancelled = false;
    void manuscriptService
      .listVersions(document.draft.id)
      .then((rows) => {
        if (!cancelled) setVersions(rows);
      })
      .catch(() => {
        if (!cancelled) setVersions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [document, autosave.lastSavedAt]);

  // Cleanup the prose debounce on unmount.
  useEffect(() => {
    return () => {
      if (proseTimer.current) clearTimeout(proseTimer.current);
    };
  }, []);

  if (status === 'not-found') {
    return (
      <Card padding="lg">
        <p className="text-muted text-sm">This chapter no longer exists. Pick another one.</p>
      </Card>
    );
  }

  if (status === 'error') {
    return (
      <Card padding="lg">
        <p className="text-muted text-sm">The manuscript could not be loaded.</p>
        <p className="text-subtle mt-1 text-xs">{error instanceof Error ? error.message : ''}</p>
        <Button variant="secondary" size="sm" className="mt-3" onClick={() => void reload()}>
          Retry
        </Button>
      </Card>
    );
  }

  if (!document) {
    return (
      <Card padding="lg">
        <p className="text-subtle text-xs" role="status">
          Opening chapter…
        </p>
      </Card>
    );
  }

  const index = siblings.findIndex((chapter) => chapter.id === chapterId);
  const previous = index > 0 ? siblings[index - 1] : null;
  const next = index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : null;
  const locked = document.locked;
  const storyChapter: Chapter | null = activeChapter;

  const handleChange = (markdown: string) => {
    onChange(markdown);
    setLiveWords(countWords(markdown));
    if (proseTimer.current) clearTimeout(proseTimer.current);
    proseTimer.current = setTimeout(() => setProse(markdown), 500);
  };

  return (
    <Card padding="none" className={cn('flex h-full flex-col overflow-hidden', !focusMode && 'min-h-[520px]')}>
      {/* Editor header: title, counts, autosave status, actions */}
      <div className="border-line flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-subtle shrink-0 text-2xs tabular-nums">{document.chapterOrder + 1}</span>
          <h3 className="text-ink truncate text-sm font-semibold">{document.title}</h3>
          {locked ? (
            <Badge tone="warning" size="sm" dot>
              <Lock className="mr-1 size-3" aria-hidden />
              Locked
            </Badge>
          ) : null}
        </div>

        <div className="flex items-center gap-3">
          <span className="text-subtle text-2xs tabular-nums">
            {liveWords.toLocaleString()} words
            {document.projectWordCount > 0 ? (
              <span className="text-subtle/70"> · project {document.projectWordCount.toLocaleString()}</span>
            ) : null}
          </span>
          <AutosaveIndicator autosave={autosave} onRetry={() => void retry()} />
          <IconButton
            label="Save now"
            icon={<Save className="size-3.5" aria-hidden />}
            onClick={() => void saveNow()}
            disabled={locked}
          />
          <div className="flex items-center gap-0.5">
            <IconButton
              label="Previous chapter"
              icon={<ChevronLeft className="size-4" aria-hidden />}
              onClick={() => previous && onOpenChapter(previous.id)}
              disabled={!previous}
            />
            <IconButton
              label="Next chapter"
              icon={<ChevronRight className="size-4" aria-hidden />}
              onClick={() => next && onOpenChapter(next.id)}
              disabled={!next}
            />
          </div>
          {/* Collapse story panel (desktop) */}
          <div className="hidden md:block">
            <IconButton
              label={aiCollapsed ? 'Show story panel' : 'Hide story panel'}
              icon={aiCollapsed ? <PanelRight className="size-4" aria-hidden /> : <PanelRight className="size-4 rotate-180" aria-hidden />}
              onClick={toggleAi}
            />
          </div>
        </div>
      </div>

      {locked ? (
        <div className="border-line bg-surface-muted/50 text-muted flex items-center gap-2 border-b px-4 py-2 text-xs">
          <Lock className="size-3.5 shrink-0" aria-hidden />
          This chapter is marked <strong className="text-ink">Final</strong>, which locks it. Set a
          different status in the Outline tab to edit again.
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {/* Center writing surface — always present; typography applied here. */}
        <EditorSurface typography={typography} appearance={editorAppearance} className="min-h-0 min-w-0 flex-1">
          <MarkdownEditor
            key={`${chapterId}:${document.draft.revision === 0 ? 'new' : 'open'}`}
            editorKey={document.draft.id}
            value={document.draft.content}
            onChange={handleChange}
            editable={!locked}
            onSaveShortcut={() => void saveNow()}
            onEditorReady={setEditor}
            className="h-full"
          />
        </EditorSurface>

        {/* Right story panel (desktop inline). Shares the SINGLE editor instance.
            A resize handle lets the author trade space between prose and panel. */}
        {!aiCollapsed && storyChapter ? (
          <Resizer
            label="Resize story panel"
            onDelta={(dx) => setAiWidth(aiWidth - dx)}
            getWidth={() => aiWidth}
            min={PANEL_WIDTH_BOUNDS.min}
            max={PANEL_WIDTH_BOUNDS.max}
          />
        ) : null}
        {!aiCollapsed && storyChapter ? (
          <div className="border-line hidden shrink-0 border-l md:block" style={{ width: aiWidth }}>
            <StoryPanel
              projectId={projectId}
              chapter={storyChapter}
              prose={prose}
              editor={editor}
              chapterTitle={document.title}
              locked={locked}
              collapsed={false}
              onToggleCollapsed={undefined}
              beforeAnalyze={flushBeforeAnalysis}
            />
          </div>
        ) : null}
      </div>

      <VersionHistoryDialog
        open={historyOpen}
        versions={versions}
        currentRevision={document.draft.revision}
        onClose={() => onHistoryOpenChange(false)}
        onCreateVersion={async (label) => {
          await createVersion(label);
        }}
        onRestore={async (versionId) => {
          await restoreVersion(versionId);
        }}
      />
    </Card>
  );
}

/* ------------------------------- Resizer --------------------------------- */

/**
 * A thin drag handle that reports horizontal drag deltas. Uses pointer events so
 * it works with mouse, pen and touch. Keyboard users can nudge with arrow keys.
 */
function Resizer({
  label,
  onDelta,
  getWidth,
  min,
  max,
}: {
  label: string;
  onDelta: (dx: number) => void;
  getWidth: () => number;
  min: number;
  max: number;
}) {
  const dragging = useRef(false);
  const lastX = useRef(0);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    lastX.current = event.clientX;
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const dx = event.clientX - lastX.current;
    lastX.current = event.clientX;
    onDelta(dx);
  };
  const end = (event: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    try {
      (event.target as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {
      /* pointer already released */
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={(event) => {
        const step = 16;
        if (event.key === 'ArrowLeft') onDelta(-step);
        else if (event.key === 'ArrowRight') onDelta(step);
        else return;
        event.preventDefault();
      }}
      className="group hidden w-1.5 shrink-0 cursor-col-resize items-stretch md:flex"
      title={label}
    >
      <span className="bg-line group-hover:bg-accent group-focus-visible:bg-accent mx-auto my-1 w-px rounded transition-colors" />
      <span className="sr-only">
        Current width {Math.round(getWidth())} pixels, between {min} and {max}.
      </span>
    </div>
  );
}

/* --------------------------- Mobile drawer ------------------------------- */

function MobileDrawer({
  open,
  side,
  title,
  onClose,
  children,
}: {
  open: boolean;
  side: 'left' | 'right';
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Do not mount the drawer (or its expensive children) until it is opened.
  // Otherwise a second StoryPanel would live in the DOM on desktop, duplicating
  // tab roles and data queries behind a hidden overlay.
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 md:hidden">
      <div onClick={onClose} className="absolute inset-0 bg-[#0b1220]/50" />
      <div
        className={cn(
          'bg-surface absolute inset-y-0 w-[80vw] max-w-xs shadow-[var(--n87-shadow-popover)]',
          side === 'left' ? 'left-0' : 'right-0',
        )}
      >
        <div className="border-line flex items-center justify-between border-b px-3 py-2">
          <h2 className="text-ink text-xs font-semibold">{title}</h2>
          <IconButton label="Close" icon={<ChevronLeft className="size-4" aria-hidden />} onClick={onClose} />
        </div>
        <div className="h-[calc(100%-2.5rem)] p-2">{children}</div>
      </div>
    </div>
  );
}

/* ---------------------------- Visual viewport ---------------------------- */

/**
 * Sets a CSS variable `--n87-vvh` to the VISUAL viewport height and keeps it in
 * sync with `window.visualViewport` (so a mobile keyboard shrinking the viewport
 * is honoured). The writing area can then size against `--n87-vvh` instead of a
 * static `innerHeight`, which keeps the editor visible above the keyboard.
 */
function useVisualViewportHeight() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const apply = () => {
      document.documentElement.style.setProperty('--n87-vvh', `${vv.height}px`);
    };
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
      document.documentElement.style.removeProperty('--n87-vvh');
    };
  }, []);
}

/* --------------------------- Autosave pill ------------------------------- */

function AutosaveIndicator({
  autosave,
  onRetry,
}: {
  autosave: ReturnType<typeof useChapterEditor>['autosave'];
  onRetry: () => void;
}) {
  if (autosave.status === 'error') {
    return (
      <button
        type="button"
        onClick={onRetry}
        className="text-danger hover:bg-danger/10 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs"
        title={autosave.error instanceof Error ? autosave.error.message : 'Save failed'}
      >
        <AlertTriangle className="size-3" aria-hidden />
        Save failed — retry
      </button>
    );
  }

  if (autosave.status === 'saving') {
    return (
      <span className="text-subtle inline-flex items-center gap-1 text-2xs" role="status">
        <span className="bg-accent size-1.5 animate-pulse rounded-full" aria-hidden />
        Saving…
      </span>
    );
  }

  if (autosave.dirty) {
    return (
      <span className="text-subtle text-2xs" role="status">
        Unsaved changes
      </span>
    );
  }

  if (autosave.status === 'saved') {
    return (
      <span className="text-success inline-flex items-center gap-1 text-2xs" role="status">
        <Check className="size-3" aria-hidden />
        Saved{autosave.lastSavedAt ? ` ${formatRelative(autosave.lastSavedAt)}` : ''}
      </span>
    );
  }

  return null;
}

/** Re-exported for tests: renders the excerpt used by import previews. */
export const __previewExcerpt = excerpt;
