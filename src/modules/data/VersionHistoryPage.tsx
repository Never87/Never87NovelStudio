import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, FileClock, Loader2, RefreshCw, RotateCcw, ShieldAlert } from 'lucide-react';
import { Badge, Button, Card, EmptyState, PageHeader } from '@/components/ui';
import { ProjectPicker } from '@/modules/ai/components/ProjectPicker';
import { Select } from '@/modules/ai/components/fields';
import { manuscriptHistoryService, manuscriptService, type ManuscriptHistoryEntry } from '@/services';
import { useProjects } from '@/hooks';
import { formatRelative } from '@/utils/date';
import { excerpt } from '@/utils/manuscript-text';

/**
 * Version History (P9 B2).
 *
 * Browse every stored snapshot of every chapter and scene in a project, with
 * each version's reason (auto / manual / restore), revision, word count and
 * timestamp. The live draft is shown as a distinct "Current" card because it is
 * NOT a version record: it lives in the draft row, while versions are the
 * immutable history log.
 *
 * Restoring reuses the editor's mechanism (`manuscriptService.restoreVersion`,
 * which is append-only), and is guarded by an explicit confirmation because it
 * replaces the current text. Restore here is coordinated with any open editor:
 * the editor flushes and rebinds on its own restore path, and this page reloads
 * its history afterwards so the new `restore` snapshot is visible immediately.
 */
export function VersionHistoryPage() {
  const { projects, initialLoading } = useProjects();
  const [projectId, setProjectId] = useState('');
  const effectiveProjectId = projectId || projects[0]?.id || '';

  const [entries, setEntries] = useState<ManuscriptHistoryEntry[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'empty' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [selectedDraftId, setSelectedDraftId] = useState<string>('');

  const load = useCallback(async () => {
    if (!effectiveProjectId) {
      setEntries([]);
      setStatus('idle');
      setSelectedDraftId('');
      return;
    }
    setStatus('loading');
    setError(null);
    try {
      const history = await manuscriptHistoryService.listProjectHistory(effectiveProjectId);
      setEntries(history.entries);
      setStatus(history.entries.length > 0 ? 'success' : 'empty');
      setSelectedDraftId((current) =>
        history.entries.some((entry) => entry.draftId === current)
          ? current
          : (history.entries[0]?.draftId ?? ''),
      );
    } catch (err) {
      setEntries([]);
      setStatus('error');
      setError(err instanceof Error ? err.message : 'The version history could not be loaded.');
    }
  }, [effectiveProjectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(
    () => entries.find((entry) => entry.draftId === selectedDraftId) ?? null,
    [entries, selectedDraftId],
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Version History"
        description="Every snapshot of your chapter and scene prose. Restoring replaces the current draft with a chosen snapshot and records a restore entry; existing snapshots are kept."
        icon={<FileClock className="size-4" aria-hidden />}
        actions={
          <ProjectPicker projects={projects} value={effectiveProjectId} onChange={setProjectId} id="vh-project-picker" />
        }
      />

      {initialLoading ? (
        <Card padding="lg">
          <p className="text-subtle flex items-center gap-2 text-xs" role="status">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            Loading projects…
          </p>
        </Card>
      ) : projects.length === 0 ? (
        <EmptyState
          icon={<FileClock className="size-5" aria-hidden />}
          title="No projects yet"
          description="Version history is per project. Create a project and start writing to build up history."
        />
      ) : (
        <Card padding="md" className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="vh-manuscript" className="text-subtle text-2xs font-medium uppercase tracking-wide">
              Manuscript
            </label>
            <Select
              id="vh-manuscript"
              value={selectedDraftId}
              onChange={(event) => setSelectedDraftId(event.target.value)}
              className="min-w-56"
              disabled={entries.length === 0}
            >
              {entries.length === 0 ? <option value="">No manuscripts with history</option> : null}
              {entries.map((entry) => (
                <option key={entry.draftId} value={entry.draftId}>
                  {entry.kind === 'chapter' ? 'Chapter · ' : 'Scene · '}
                  {entry.ownerTitle} ({entry.versions.length} version
                  {entry.versions.length === 1 ? '' : 's'})
                </option>
              ))}
            </Select>
            <Button
              variant="ghost"
              size="sm"
              iconLeft={<RefreshCw className="size-3.5" />}
              onClick={() => void load()}
              disabled={status === 'loading'}
            >
              Refresh
            </Button>
          </div>

          {status === 'error' ? (
            <p className="text-danger flex items-center gap-1.5 text-xs" role="alert">
              <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
              {error}
            </p>
          ) : status === 'loading' && entries.length === 0 ? (
            <p className="text-subtle flex items-center gap-2 text-xs" role="status">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              Loading version history…
            </p>
          ) : status === 'empty' ? (
            <EmptyState
              icon={<FileClock className="size-5" aria-hidden />}
              title="No versions recorded"
              description="Version snapshots appear here after you save chapters or scenes. Open the editor and start writing."
            />
          ) : selected ? (
            <ManuscriptHistory
              entry={selected}
              onRestored={() => void load()}
            />
          ) : null}
        </Card>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function ManuscriptHistory({
  entry,
  onRestored,
}: {
  entry: ManuscriptHistoryEntry;
  onRestored: () => void;
}) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  // Reset transient restore state whenever the selected manuscript changes.
  useEffect(() => {
    setPendingId(null);
    setRestoringId(null);
    setRestoreError(null);
  }, [entry.draftId]);

  const pending = entry.versions.find((version) => version.id === pendingId) ?? null;

  const restore = async (versionId: string) => {
    setRestoringId(versionId);
    setRestoreError(null);
    try {
      // Coordination note: the Story Editor and this page are never mounted at
      // the same time (single-route app). The editor flushes its pending
      // autosave on route change/unmount (`flushOnCleanup`), so a queued save
      // cannot land after we navigate here. Restore therefore goes straight to
      // the append-only service; the editor's own restore path additionally
      // flushes+rebinds because it restores WHILE editing.
      await manuscriptService.restoreVersion(versionId);
      setPendingId(null);
      onRestored();
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : 'The version could not be restored.');
    } finally {
      setRestoringId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="border-line flex flex-wrap items-center justify-between gap-2 rounded-md border bg-surface-muted/40 px-3 py-2">
        <div className="flex items-center gap-2">
          <Badge tone={entry.kind === 'chapter' ? 'accent' : 'info'} size="sm">
            {entry.kind}
          </Badge>
          <h2 className="text-ink text-sm font-semibold">{entry.ownerTitle}</h2>
        </div>
        <span className="text-subtle text-2xs tabular-nums">
          {entry.versions.length} snapshot{entry.versions.length === 1 ? '' : 's'}
        </span>
      </div>

      {restoreError ? (
        <p className="text-danger text-2xs" role="alert">
          {restoreError}
        </p>
      ) : null}

      {pending ? (
        <div className="border-warning bg-warning-soft/40 rounded-md border p-3" role="alertdialog" aria-label="Confirm restore">
          <p className="text-ink flex items-center gap-1.5 text-xs font-medium">
            <ShieldAlert className="text-warning size-3.5 shrink-0" aria-hidden />
            Restore version r{pending.revision} of “{entry.ownerTitle}”?
          </p>
          <p className="text-muted mt-1 text-2xs leading-relaxed">
            Restoring replaces the current draft with this version. Existing snapshots are kept, and
            a restore entry is added to the history. Text typed since the last snapshot is not saved
            as a separate version, so create a snapshot first if you want to keep it.
          </p>
          <div className="mt-2 flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setPendingId(null)} disabled={restoringId !== null}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              iconLeft={<RotateCcw className="size-3.5" />}
              onClick={() => void restore(pending.id)}
              loading={restoringId === pending.id}
            >
              Restore this version
            </Button>
          </div>
        </div>
      ) : null}

      <ul className="space-y-2">
        {/* The live draft is not a version: it is shown separately. */}
        <li>
          <Card padding="sm" className="border-accent/40 bg-accent-soft/30">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone="success" size="sm" dot>
                    Current draft
                  </Badge>
                  <span className="text-subtle text-2xs tabular-nums">
                    r{entry.currentRevision ?? 0} · {entry.currentWordCount.toLocaleString()} words
                  </span>
                </div>
                <p className="text-subtle mt-1 line-clamp-2 text-2xs">
                  {excerpt(entry.currentContent, 160) || 'Empty'}
                </p>
              </div>
            </div>
          </Card>
        </li>

        {entry.versions.map((version) => {
          const isCurrent = version.revision === entry.currentRevision;
          return (
            <li key={version.id}>
              <Card padding="sm" interactive={false}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={reasonTone(version.reason)} size="sm">
                        {version.reason}
                      </Badge>
                      {isCurrent ? (
                        <Badge tone="neutral" size="sm">
                          matches current
                        </Badge>
                      ) : null}
                      <span className="text-subtle text-2xs tabular-nums">
                        r{version.revision} · {version.wordCount.toLocaleString()} words ·{' '}
                        {formatRelative(version.createdAt)}
                      </span>
                    </div>
                    {version.label ? (
                      <p className="text-ink mt-1 truncate text-xs font-medium">{version.label}</p>
                    ) : null}
                    <p className="text-subtle mt-1 line-clamp-2 text-2xs">
                      {excerpt(version.content, 160) || 'Empty'}
                    </p>
                  </div>
                  <Button
                    variant={pendingId === version.id ? 'danger' : 'ghost'}
                    size="sm"
                    disabled={restoringId !== null || pending !== null}
                    iconLeft={<RotateCcw className="size-3.5" />}
                    onClick={() => setPendingId(version.id)}
                  >
                    Restore
                  </Button>
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function reasonTone(reason: string) {
  if (reason === 'manual') return 'info' as const;
  if (reason === 'restore') return 'warning' as const;
  return 'neutral' as const;
}
