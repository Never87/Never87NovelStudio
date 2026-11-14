import { useState } from 'react';
import { RotateCcw, ShieldAlert, Trash2 } from 'lucide-react';
import { Badge, Button } from '@/components/ui';
import type { DraftVersion } from '@/types';
import { formatRelative } from '@/utils/date';
import { excerpt } from '@/utils/manuscript-text';
import { ProjectDialog } from '@/modules/projects/components/ProjectDialog';

export interface VersionHistoryDialogProps {
  open: boolean;
  versions: DraftVersion[];
  onClose: () => void;
  /** Captures a labelled snapshot of the current content. */
  onCreateVersion: (label: string) => Promise<void>;
  /** Restores a snapshot as the new current content. */
  onRestore: (versionId: string) => Promise<void>;
  /** Live draft revision, used only to badge the matching snapshot as current. */
  currentRevision?: number | null;
}

/**
 * Manuscript version history (P4).
 *
 * Restoring is append-only for HISTORY but DESTRUCTIVE to the current draft:
 * `manuscriptService.restoreVersion` replaces the current draft's content with
 * the chosen snapshot (revision + 1) and records a `restore` entry, while every
 * existing snapshot is retained. It does NOT snapshot the replaced, currently
 * unsaved-to-version text — only content that already has a snapshot survives.
 *
 * Because the current draft is overwritten, a restore is a two-step action:
 * pressing Restore on a row opens an inline confirmation naming the snapshot,
 * and only the explicit confirm button issues the write. This prevents a
 * mis-click from silently rolling the manuscript back.
 */
export function VersionHistoryDialog({
  open,
  versions,
  onClose,
  onCreateVersion,
  onRestore,
  currentRevision,
}: VersionHistoryDialogProps) {
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Version id awaiting explicit confirmation, or `null`. */
  const [pendingRestoreId, setPendingRestoreId] = useState<string | null>(null);

  const pendingVersion = versions.find((version) => version.id === pendingRestoreId) ?? null;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The action failed.');
    } finally {
      setBusy(false);
    }
  };

  const confirmRestore = () =>
    void run(async () => {
      if (!pendingRestoreId) return;
      await onRestore(pendingRestoreId);
      setPendingRestoreId(null);
    });

  const close = () => {
    if (busy) return;
    setPendingRestoreId(null);
    onClose();
  };

  return (
    <ProjectDialog
      open={open}
      title="Version history"
      description="Snapshots are created automatically on save and can be created manually. Restoring replaces the current draft with a chosen snapshot and records a restore entry; existing snapshots are kept."
      onClose={close}
      dismissible={!busy}
      footer={
        <Button variant="secondary" size="sm" onClick={close} disabled={busy}>
          Done
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="flex items-end gap-2">
          <label className="min-w-0 flex-1">
            <span className="text-subtle text-2xs font-medium uppercase tracking-wide">
              Snapshot label
            </span>
            <input
              type="text"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="e.g. Before rewriting the ending"
              maxLength={200}
              className="bg-surface border-line-strong text-ink mt-1 h-9 w-full rounded-md border px-2.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            />
          </label>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || pendingVersion !== null}
            onClick={() => void run(async () => {
              await onCreateVersion(label.trim());
              setLabel('');
            })}
          >
            Create version
          </Button>
        </div>

        {error ? (
          <p className="text-danger text-xs" role="alert">
            {error}
          </p>
        ) : null}

        {/* Inline restore confirmation — replaces a silent rollback. */}
        {pendingVersion ? (
          <div
            className="border-warning bg-warning-soft/40 rounded-md border p-3"
            role="alertdialog"
            aria-label="Confirm restore"
          >
            <p className="text-ink flex items-center gap-1.5 text-xs font-medium">
              <ShieldAlert className="text-warning size-3.5 shrink-0" aria-hidden />
              Restore version r{pendingVersion.revision}?
            </p>
            <p className="text-muted mt-1 text-2xs leading-relaxed">
              Restoring replaces the current draft with this version. Existing snapshots are kept,
              and a restore entry is added to the history. Text you have typed since the last
              snapshot is not saved as a separate version, so create a snapshot first if you want to
              keep it.
            </p>
            <div className="mt-2 flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPendingRestoreId(null)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                iconLeft={<RotateCcw className="size-3.5" />}
                onClick={confirmRestore}
                loading={busy}
              >
                Restore this version
              </Button>
            </div>
          </div>
        ) : null}

        {versions.length === 0 ? (
          <p className="text-subtle text-xs italic">
            No versions yet. Saving the chapter or creating one above adds the first snapshot.
          </p>
        ) : (
          <ul className="divide-line divide-y">
            {versions.map((version) => {
              const isCurrent =
                typeof currentRevision === 'number' && version.revision === currentRevision;
              return (
              <li key={version.id} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <Badge tone={version.reason === 'manual' ? 'info' : 'neutral'} size="sm">
                      {version.reason}
                    </Badge>
                    {isCurrent ? (
                      <Badge tone="success" size="sm">
                        current
                      </Badge>
                    ) : null}
                    <span className="text-subtle text-2xs tabular-nums">
                      r{version.revision} · {version.wordCount.toLocaleString()} words ·{' '}
                      {formatRelative(version.createdAt)}
                    </span>
                  </div>
                  {version.label ? (
                    <p className="text-ink mt-0.5 truncate text-xs">{version.label}</p>
                  ) : null}
                  <p className="text-subtle mt-0.5 line-clamp-2 text-2xs">
                    {excerpt(version.content, 120) || 'Empty'}
                  </p>
                </div>
                <Button
                  variant={pendingRestoreId === version.id ? 'danger' : 'ghost'}
                  size="sm"
                  disabled={busy || pendingVersion !== null}
                  iconLeft={<RotateCcw className="size-3.5" />}
                  onClick={() => setPendingRestoreId(version.id)}
                >
                  Restore
                </Button>
              </li>
              );
            })}
          </ul>
        )}

        <p className="text-subtle flex items-center gap-1 text-2xs">
          <Trash2 className="size-3" aria-hidden />
          Older snapshots are pruned automatically, keeping the most recent ones.
        </p>
      </div>
    </ProjectDialog>
  );
}
