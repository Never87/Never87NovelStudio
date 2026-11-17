import { useState } from 'react';
import { BookPlus, ChevronRight, Check, X, Lock, FolderPlus } from 'lucide-react';
import { Card, IconButton } from '@/components/ui';
import type { VolumeWithChapters } from '@/services';
import { outlineService } from '@/services';
import { cn } from '@/utils/cn';

export interface ManuscriptNavProps {
  projectId: string;
  outline: VolumeWithChapters[];
  activeChapterId: string | null;
  onSelectChapter: (chapterId: string) => void;
  /** Called after a volume/chapter is created so the panel refreshes and can select. */
  onChanged: (selectChapterId?: string) => void;
  /** Collapsed rail mode. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

/**
 * Left manuscript panel: the volume/chapter tree PLUS lightweight in-editor
 * creation (item 3 of the UX brief).
 *
 * The create controls call the SAME `outlineService` the Outline tab uses (no
 * parallel write path); after a write we tell the parent to refresh its
 * `useOutline` state and, for a new chapter, to auto-open it in the center
 * editor so it is immediately writable.
 *
 * Forms are intentionally minimal: a volume needs only a title; a chapter needs
 * only a title (defaults fill the rest). Empty projects and volumes are handled
 * with clear inline prompts rather than dead ends.
 */
export function ManuscriptNav({
  projectId,
  outline,
  activeChapterId,
  onSelectChapter,
  onChanged,
  collapsed,
  onToggleCollapsed,
}: ManuscriptNavProps) {
  // Which inline creator is open: a new volume, or a new chapter under a volume.
  const [creating, setCreating] = useState<{ type: 'volume' } | { type: 'chapter'; volumeId: string } | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openCreate = (target: { type: 'volume' } | { type: 'chapter'; volumeId: string }) => {
    setCreating(target);
    setTitle('');
    setError(null);
  };
  const closeCreate = () => {
    setCreating(null);
    setTitle('');
    setError(null);
  };

  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      if (creating?.type === 'volume') {
        await outlineService.createVolume(projectId, { title: trimmed, summary: '' });
        onChanged();
      } else if (creating?.type === 'chapter') {
        const chapter = await outlineService.createChapter(projectId, creating.volumeId, {
          title: trimmed,
        });
        onChanged(chapter.id);
      }
      closeCreate();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create.');
    } finally {
      setBusy(false);
    }
  };

  if (collapsed) {
    return (
      <div className="flex h-full flex-col items-center gap-1 py-2">
        <IconButton
          label="Expand manuscript panel"
          icon={<ChevronRight className="size-4" aria-hidden />}
          onClick={onToggleCollapsed}
        />
        <IconButton
          label="New volume"
          icon={<FolderPlus className="size-4" aria-hidden />}
          onClick={() => {
            onToggleCollapsed?.();
            openCreate({ type: 'volume' });
          }}
        />
      </div>
    );
  }

  return (
    <Card padding="sm" className="flex h-full flex-col overflow-hidden">
      <div className="mb-2 flex items-center justify-between gap-1">
        <h2 className="text-ink truncate text-xs font-semibold">Manuscript</h2>
        <div className="flex items-center gap-0.5">
          <IconButton
            label="New volume"
            icon={<FolderPlus className="size-3.5" aria-hidden />}
            onClick={() => openCreate({ type: 'volume' })}
          />
        </div>
      </div>

      {creating?.type === 'volume' || (outline.length === 0 && !creating) ? null : null}

      <div className="n87-scroll-fade min-h-0 flex-1 space-y-3 overflow-y-auto pr-0.5">
        {outline.length === 0 ? (
          <div className="space-y-2 px-1 py-2">
            <p className="text-subtle text-2xs leading-relaxed">
              No volumes yet. Create a volume, then add chapters to start writing.
            </p>
            {!creating ? (
              <button
                type="button"
                onClick={() => openCreate({ type: 'volume' })}
                className="text-accent-soft-text bg-accent-soft hover:bg-accent-soft/80 inline-flex items-center gap-1 rounded-md px-2 py-1 text-2xs font-medium"
              >
                <FolderPlus className="size-3" aria-hidden />
                New volume
              </button>
            ) : null}
          </div>
        ) : null}

        {outline.map(({ volume, chapters }) => (
          <div key={volume.id}>
            <div className="group flex items-center justify-between gap-1">
              <p className="text-subtle truncate text-2xs font-medium uppercase tracking-wide">
                {volume.title}
              </p>
              <IconButton
                label="New chapter"
                icon={<BookPlus className="size-3" aria-hidden />}
                size="sm"
                onClick={() => openCreate({ type: 'chapter', volumeId: volume.id })}
              />
            </div>
            <ul className="mt-0.5 space-y-0.5">
              {chapters.map((chapter) => {
                const active = chapter.id === activeChapterId;
                const locked = chapter.status === 'final';
                return (
                  <li key={chapter.id}>
                    <button
                      type="button"
                      onClick={() => onSelectChapter(chapter.id)}
                      aria-current={active ? 'true' : undefined}
                      className={cn(
                        'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                        active
                          ? 'bg-accent/10 text-ink font-medium'
                          : 'text-muted hover:bg-surface-muted hover:text-ink',
                      )}
                    >
                      <span className="text-subtle w-4 shrink-0 tabular-nums">{chapter.order + 1}</span>
                      <span className="min-w-0 flex-1 truncate">{chapter.title}</span>
                      {locked ? <Lock className="text-subtle size-3 shrink-0" aria-label="Locked" /> : null}
                    </button>
                  </li>
                );
              })}
              {chapters.length === 0 ? (
                <li className="text-subtle px-2 text-2xs italic">Empty volume</li>
              ) : null}
            </ul>
          </div>
        ))}

        {/* Inline creator */}
        {creating ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
            className="border-line bg-surface-muted/60 mt-1 space-y-1.5 rounded-md border p-2"
          >
            <label className="text-subtle text-2xs font-medium">
              {creating.type === 'volume' ? 'New volume title' : 'New chapter title'}
            </label>
            <input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={creating.type === 'volume' ? 'e.g. Volume One' : 'e.g. Chapter 1'}
              className="border-line bg-surface text-ink focus:border-accent w-full rounded border px-2 py-1 text-xs outline-none"
            />
            {error ? <p className="text-danger text-2xs">{error}</p> : null}
            <div className="flex items-center justify-end gap-1">
              <IconButton label="Cancel" icon={<X className="size-3.5" aria-hidden />} onClick={closeCreate} />
              <IconButton
                label={creating.type === 'volume' ? 'Create volume' : 'Create chapter'}
                icon={<Check className="size-3.5" aria-hidden />}
                onClick={() => void submit()}
                disabled={busy || !title.trim()}
              />
            </div>
          </form>
        ) : null}
      </div>
    </Card>
  );
}
