import { useState } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
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
}

/**
 * Manuscript version history (P4).
 *
 * Restoring never mutates history: the Service writes the snapshot back as a
 * NEW revision and records a `restore` entry, so the replaced text stays
 * recoverable.
 */
export function VersionHistoryDialog({
  open,
  versions,
  onClose,
  onCreateVersion,
  onRestore,
}: VersionHistoryDialogProps) {
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <ProjectDialog
      open={open}
      title="Version history"
      description="Snapshots are created automatically on save and can be created manually. Restoring keeps the replaced text as a new version."
      onClose={onClose}
      dismissible={!busy}
      footer={
        <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
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
            disabled={busy}
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

        {versions.length === 0 ? (
          <p className="text-subtle text-xs italic">
            No versions yet. Saving the chapter or creating one above adds the first snapshot.
          </p>
        ) : (
          <ul className="divide-line divide-y">
            {versions.map((version) => (
              <li key={version.id} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <Badge tone={version.reason === 'manual' ? 'info' : 'neutral'} size="sm">
                      {version.reason}
                    </Badge>
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
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  iconLeft={<RotateCcw className="size-3.5" />}
                  onClick={() => void run(() => onRestore(version.id))}
                >
                  Restore
                </Button>
              </li>
            ))}
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
