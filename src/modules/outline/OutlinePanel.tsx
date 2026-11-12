import { useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Layers,
  Link2,
  ListTree,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
  Users,
} from 'lucide-react';
import { Badge, Button, Card, IconButton } from '@/components/ui';
import type { Chapter, Volume } from '@/types';
import { useCharacters, useNarrative, useOutline } from '@/hooks';
import type { CreateChapterInput, CreateVolumeInput, UpdateChapterInput, UpdateVolumeInput } from '@/services';
import { ProjectDialog } from '@/modules/projects/components/ProjectDialog';
import { describeError } from '@/modules/projects/components/ProjectFormDialog';
import { CHAPTER_STATUS_META, chapterLabel } from './outline-meta';
import { ChapterFormDialog } from './components/ChapterFormDialog';
import { VolumeFormDialog } from './components/VolumeFormDialog';
import { ScenesPanel } from './components/ScenesPanel';

/**
 * Outline section of the project detail page.
 *
 * Renders volumes → chapters, with a selected chapter expanding to its scenes.
 * A chapter shows its linked PlotBeat title (read from the narrative plan) but
 * never stores a copy of the beat text.
 *
 * States: loading / error / empty / tree. All data flows through `useOutline`
 * (and `useNarrative` for beat labels), so a project only sees its own data.
 */
export function OutlinePanel({ projectId }: { projectId: string }) {
  const {
    outline,
    sceneCounts,
    status,
    loading,
    isEmpty,
    error,
    refresh,
    createVolume,
    updateVolume,
    deleteVolume,
    createChapter,
    updateChapter,
    moveChapter,
    deleteChapter,
  } = useOutline(projectId);

  // Beats come from the narrative plan (link targets); the cast powers the
  // chapter/scene character pickers.
  const { plan } = useNarrative(projectId);
  const { characters } = useCharacters(projectId);
  const beats = useMemo(() => plan?.beats ?? [], [plan]);

  const beatById = useMemo(() => {
    const map = new Map<string, { title: string; position: number }>();
    for (const beat of beats) map.set(beat.id, { title: beat.title, position: beat.position });
    return map;
  }, [beats]);

  const [expandedChapters, setExpandedChapters] = useState<Set<string>>(new Set());

  const [volumeFormOpen, setVolumeFormOpen] = useState(false);
  const [editingVolume, setEditingVolume] = useState<Volume | null>(null);
  const [deletingVolume, setDeletingVolume] = useState<Volume | null>(null);

  const [chapterFormOpen, setChapterFormOpen] = useState(false);
  const [chapterVolumeId, setChapterVolumeId] = useState<string | null>(null);
  const [editingChapter, setEditingChapter] = useState<Chapter | null>(null);
  const [deletingChapter, setDeletingChapter] = useState<Chapter | null>(null);

  // Drop expansion state for chapters that no longer exist.
  useEffect(() => {
    setExpandedChapters((prev) => {
      const live = new Set(outline.flatMap((group) => group.chapters.map((c) => c.id)));
      const kept = [...prev].filter((id) => live.has(id));
      return kept.length === prev.size ? prev : new Set(kept);
    });
  }, [outline]);

  const toggleChapter = (chapterId: string) => {
    setExpandedChapters((prev) => {
      const next = new Set(prev);
      if (next.has(chapterId)) next.delete(chapterId);
      else next.add(chapterId);
      return next;
    });
  };

  const openCreateVolume = () => {
    setEditingVolume(null);
    setVolumeFormOpen(true);
  };

  const openEditVolume = (volume: Volume) => {
    setEditingVolume(volume);
    setVolumeFormOpen(true);
  };

  const openCreateChapter = (volumeId: string) => {
    setEditingChapter(null);
    setChapterVolumeId(volumeId);
    setChapterFormOpen(true);
  };

  const openEditChapter = (chapter: Chapter) => {
    setEditingChapter(chapter);
    setChapterVolumeId(chapter.volumeId);
    setChapterFormOpen(true);
  };

  if (status === 'loading' && loading) {
    return (
      <Card padding="lg">
        <div className="text-subtle flex items-center justify-center gap-2 py-8 text-xs" role="status" aria-live="polite">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Loading outline…
        </div>
      </Card>
    );
  }

  if (status === 'error') {
    const message = error instanceof Error ? error.message : String(error);
    const name = error instanceof Error ? error.name : 'Error';
    return (
      <Card padding="lg" className="flex flex-col items-center text-center" role="alert">
        <span className="bg-danger-soft text-danger grid size-10 place-items-center rounded-lg">
          <TriangleAlert className="size-5" aria-hidden />
        </span>
        <h3 className="text-ink mt-3 text-sm font-semibold">Couldn’t load the outline</h3>
        <p className="text-muted mt-1 max-w-md text-xs">
          Something went wrong while reading this project’s outline. Your data has not been changed.
        </p>
        <pre className="bg-surface-muted text-subtle mt-3 max-h-24 w-full max-w-md overflow-auto rounded-md p-2 text-2xs whitespace-pre-wrap break-words">
          {name}: {message}
        </pre>
        <Button variant="primary" size="sm" className="mt-4" iconLeft={<RefreshCw className="size-3.5" />} onClick={() => void refresh()}>
          Retry
        </Button>
      </Card>
    );
  }

  const totalChapters = outline.reduce((sum, group) => sum + group.chapters.length, 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-subtle text-2xs">
          {isEmpty
            ? 'No volumes yet'
            : `${outline.length} volume${outline.length === 1 ? '' : 's'} · ${totalChapters} chapter${totalChapters === 1 ? '' : 's'}`}
          {loading ? ' · refreshing…' : ''}
        </p>
        <Button variant="primary" size="sm" iconLeft={<Plus className="size-3.5" />} onClick={openCreateVolume}>
          New volume
        </Button>
      </div>

      {isEmpty ? (
        <Card padding="lg" className="flex flex-col items-center text-center">
          <span className="bg-surface text-subtle border-line mb-3 grid size-11 place-items-center rounded-lg border">
            <ListTree className="size-5" aria-hidden />
          </span>
          <h3 className="text-ink text-sm font-semibold">No outline yet</h3>
          <p className="text-muted mt-1 max-w-md text-xs leading-relaxed">
            Build your story’s structure: create a volume, then add chapters and break each one into
            scenes. Chapters can link to the beats in your narrative plan.
          </p>
          <Button variant="primary" size="sm" className="mt-4" iconLeft={<Plus className="size-3.5" />} onClick={openCreateVolume}>
            Create your first volume
          </Button>
        </Card>
      ) : (
        <div className="space-y-3">
          {outline.map(({ volume, chapters }, volumeIndex) => (
            <VolumeBlock
              key={volume.id}
              volume={volume}
              index={volumeIndex}
              chapters={chapters}
              sceneCounts={sceneCounts}
              beatById={beatById}
              expandedChapters={expandedChapters}
              characters={characters}
              onToggleChapter={toggleChapter}
              onEditVolume={() => openEditVolume(volume)}
              onDeleteVolume={() => setDeletingVolume(volume)}
              onAddChapter={() => openCreateChapter(volume.id)}
              onEditChapter={openEditChapter}
              onDeleteChapter={(chapter) => setDeletingChapter(chapter)}
              onMoveChapter={(chapterId, direction) => void moveChapter(chapterId, direction)}
            />
          ))}
        </div>
      )}

      <VolumeFormDialog
        open={volumeFormOpen && editingVolume === null}
        onSubmit={async (input) => {
          await createVolume(input as CreateVolumeInput);
        }}
        onClose={() => setVolumeFormOpen(false)}
      />
      <VolumeFormDialog
        key={editingVolume?.id ?? 'edit-volume'}
        open={volumeFormOpen && editingVolume !== null}
        initialVolume={editingVolume}
        onSubmit={async (input) => {
          if (editingVolume) await updateVolume(editingVolume.id, input as UpdateVolumeInput);
        }}
        onClose={() => {
          setVolumeFormOpen(false);
          setEditingVolume(null);
        }}
      />

      <ChapterFormDialog
        open={chapterFormOpen && editingChapter === null}
        beats={beats}
        characters={characters}
        onSubmit={async (input) => {
          if (chapterVolumeId) await createChapter(chapterVolumeId, input as CreateChapterInput);
        }}
        onClose={() => {
          setChapterFormOpen(false);
          setChapterVolumeId(null);
        }}
      />
      <ChapterFormDialog
        key={editingChapter?.id ?? 'edit-chapter'}
        open={chapterFormOpen && editingChapter !== null}
        initialChapter={editingChapter}
        beats={beats}
        characters={characters}
        onSubmit={async (input) => {
          if (editingChapter) await updateChapter(editingChapter.id, input as UpdateChapterInput);
        }}
        onClose={() => {
          setChapterFormOpen(false);
          setEditingChapter(null);
          setChapterVolumeId(null);
        }}
      />

      <ProjectDialog
        open={deletingVolume !== null}
        title="Delete volume?"
        description={deletingVolume ? `“${deletingVolume.title}” and all its chapters and scenes will be removed.` : undefined}
        tone="danger"
        onClose={() => setDeletingVolume(null)}
        footer={
          <DeleteFooter
            label="Delete volume"
            onCancel={() => setDeletingVolume(null)}
            onConfirm={async () => {
              if (deletingVolume) await deleteVolume(deletingVolume.id);
            }}
            onDone={() => setDeletingVolume(null)}
          />
        }
      >
        <p className="text-muted text-xs">
          Every chapter in this volume and every scene inside those chapters will be permanently
          removed. This cannot be undone.
        </p>
      </ProjectDialog>

      <ProjectDialog
        open={deletingChapter !== null}
        title="Delete chapter?"
        description={deletingChapter ? `“${deletingChapter.title}” and its scenes will be removed.` : undefined}
        tone="danger"
        onClose={() => setDeletingChapter(null)}
        footer={
          <DeleteFooter
            label="Delete chapter"
            onCancel={() => setDeletingChapter(null)}
            onConfirm={async () => {
              if (deletingChapter) await deleteChapter(deletingChapter.id);
            }}
            onDone={() => setDeletingChapter(null)}
          />
        }
      >
        <p className="text-muted text-xs">
          Every scene inside this chapter will be permanently removed. This cannot be undone.
        </p>
      </ProjectDialog>
    </div>
  );
}

interface VolumeBlockProps {
  volume: Volume;
  index: number;
  chapters: Chapter[];
  sceneCounts: Record<string, number>;
  beatById: Map<string, { title: string; position: number }>;
  expandedChapters: Set<string>;
  characters: ReturnType<typeof useCharacters>['characters'];
  onToggleChapter: (chapterId: string) => void;
  onEditVolume: () => void;
  onDeleteVolume: () => void;
  onAddChapter: () => void;
  onEditChapter: (chapter: Chapter) => void;
  onDeleteChapter: (chapter: Chapter) => void;
  onMoveChapter: (chapterId: string, direction: -1 | 1) => void;
}

function VolumeBlock({
  volume,
  index,
  chapters,
  sceneCounts,
  beatById,
  expandedChapters,
  characters,
  onToggleChapter,
  onEditVolume,
  onDeleteVolume,
  onAddChapter,
  onEditChapter,
  onDeleteChapter,
  onMoveChapter,
}: VolumeBlockProps) {
  const chapterTotal = chapters.length;

  return (
    <Card padding="md">
      <div className="flex items-start gap-2">
        <span className="bg-accent-soft text-accent-soft-text mt-0.5 grid size-6 shrink-0 place-items-center rounded text-2xs font-semibold">
          <Layers className="size-3.5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-ink text-sm font-semibold break-words">{volume.title}</h3>
            <Badge tone="neutral" size="sm">
              Volume {index + 1}
            </Badge>
            <span className="text-subtle text-2xs">
              {chapterTotal} chapter{chapterTotal === 1 ? '' : 's'}
            </span>
          </div>
          {volume.summary.trim() ? (
            <p className="text-muted mt-1 text-xs whitespace-pre-line">{volume.summary}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center">
          <IconButton
            variant="ghost"
            size="sm"
            label={`Edit volume ${volume.title}`}
            icon={<Pencil className="size-3.5" aria-hidden />}
            onClick={onEditVolume}
          />
          <IconButton
            variant="ghost"
            size="sm"
            label={`Delete volume ${volume.title}`}
            icon={<Trash2 className="size-3.5" aria-hidden />}
            onClick={onDeleteVolume}
          />
        </div>
      </div>

      <div className="mt-3 space-y-2">
        {chapters.length === 0 ? (
          <p className="text-subtle border-line rounded-md border border-dashed px-3 py-3 text-center text-2xs">
            No chapters in this volume yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {chapters.map((chapter, chapterIndex) => (
              <li key={chapter.id}>
                <ChapterRow
                  chapter={chapter}
                  index={chapterIndex}
                  total={chapters.length}
                  sceneCount={sceneCounts[chapter.id] ?? 0}
                  beat={chapter.plotBeatId ? beatById.get(chapter.plotBeatId) : undefined}
                  expanded={expandedChapters.has(chapter.id)}
                  characters={characters}
                  projectId={volume.projectId}
                  onToggle={() => onToggleChapter(chapter.id)}
                  onEdit={() => onEditChapter(chapter)}
                  onDelete={() => onDeleteChapter(chapter)}
                  onMove={(direction) => onMoveChapter(chapter.id, direction)}
                />
              </li>
            ))}
          </ul>
        )}

        <Button variant="ghost" size="sm" iconLeft={<Plus className="size-3.5" />} onClick={onAddChapter}>
          Add chapter
        </Button>
      </div>
    </Card>
  );
}

interface ChapterRowProps {
  chapter: Chapter;
  index: number;
  total: number;
  sceneCount: number;
  beat?: { title: string; position: number };
  expanded: boolean;
  characters: ReturnType<typeof useCharacters>['characters'];
  projectId: string;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onMove: (direction: -1 | 1) => void;
}

function ChapterRow({
  chapter,
  index,
  total,
  sceneCount,
  beat,
  expanded,
  characters,
  projectId,
  onToggle,
  onEdit,
  onDelete,
  onMove,
}: ChapterRowProps) {
  const statusMeta = CHAPTER_STATUS_META[chapter.status];
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <div className="border-line bg-surface-muted/30 rounded-md border">
      <div className="flex items-start gap-2 p-2.5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${chapterLabel(chapter.order)}`}
          className="text-subtle hover:text-ink hover:bg-surface -ml-0.5 mt-0.5 grid size-5 shrink-0 place-items-center rounded"
        >
          <Chevron className="size-3.5" aria-hidden />
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-subtle text-2xs font-medium">{chapterLabel(chapter.order)}</span>
            <h4 className="text-ink text-xs font-semibold break-words">{chapter.title}</h4>
            <Badge tone={statusMeta.tone} size="sm" dot>
              {statusMeta.label}
            </Badge>
            {sceneCount > 0 ? (
              <span className="text-subtle text-2xs">
                {sceneCount} scene{sceneCount === 1 ? '' : 's'}
              </span>
            ) : null}
            {chapter.characterIds.length > 0 ? (
              <span className="text-subtle flex items-center gap-0.5 text-2xs">
                <Users className="size-3" aria-hidden />
                {chapter.characterIds.length}
              </span>
            ) : null}
          </div>

          {chapter.summary.trim() ? (
            <p className="text-muted mt-1 line-clamp-2 text-2xs">{chapter.summary}</p>
          ) : null}

          {beat ? (
            <p className="text-subtle mt-1 flex items-center gap-1 text-2xs">
              <Link2 className="size-3 shrink-0" aria-hidden />
              <span className="truncate">
                {beat.position}% · {beat.title}
              </span>
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center">
          <IconButton
            variant="ghost"
            size="sm"
            label={`Move ${chapterLabel(chapter.order)} up`}
            icon={<ArrowUp className="size-3.5" aria-hidden />}
            onClick={() => onMove(-1)}
            disabled={index === 0}
          />
          <IconButton
            variant="ghost"
            size="sm"
            label={`Move ${chapterLabel(chapter.order)} down`}
            icon={<ArrowDown className="size-3.5" aria-hidden />}
            onClick={() => onMove(1)}
            disabled={index === total - 1}
          />
          <IconButton
            variant="ghost"
            size="sm"
            label={`Edit ${chapter.title}`}
            icon={<Pencil className="size-3.5" aria-hidden />}
            onClick={onEdit}
          />
          <IconButton
            variant="ghost"
            size="sm"
            label={`Delete ${chapter.title}`}
            icon={<Trash2 className="size-3.5" aria-hidden />}
            onClick={onDelete}
          />
        </div>
      </div>

      {expanded ? (
        <div className="border-line border-t p-2.5">
          <div className="mb-2 grid gap-2 sm:grid-cols-2">
            {chapter.goal.trim() ? (
              <div className="min-w-0">
                <p className="text-subtle text-2xs font-medium uppercase tracking-wide">Goal</p>
                <p className="text-muted text-2xs whitespace-pre-line">{chapter.goal}</p>
              </div>
            ) : null}
            {chapter.endingHook.trim() ? (
              <div className="min-w-0">
                <p className="text-subtle text-2xs font-medium uppercase tracking-wide">Ending hook</p>
                <p className="text-muted text-2xs whitespace-pre-line">{chapter.endingHook}</p>
              </div>
            ) : null}
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-subtle text-2xs">Scenes</p>
          </div>
          <ScenesPanel projectId={projectId} chapterId={chapter.id} characters={characters} />
        </div>
      ) : null}
    </div>
  );
}

function DeleteFooter({
  label,
  onCancel,
  onConfirm,
  onDone,
}: {
  label: string;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await onConfirm();
      onDone();
    } catch (error) {
      setFailure(describeError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex w-full flex-col gap-2">
      {failure ? (
        <p className="text-danger text-2xs" role="alert">
          {failure}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="danger" size="sm" loading={busy} onClick={() => void run()}>
          {label}
        </Button>
      </div>
    </div>
  );
}
