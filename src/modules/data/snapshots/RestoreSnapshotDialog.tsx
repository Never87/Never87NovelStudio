import { useEffect, useState } from 'react';
import { AlertTriangle, RotateCcw, ShieldAlert } from 'lucide-react';
import { Badge, Button } from '@/components/ui';
import { ProjectDialog } from '@/modules/projects/components/ProjectDialog';
import type { ProjectSnapshot } from '@/types';
import { formatRelative } from '@/utils/date';

export interface RestoreSnapshotDialogProps {
  open: boolean;
  /** The snapshot about to be restored (shown so the user can confirm it is the right one). */
  snapshot: ProjectSnapshot | null;
  /** Human-readable project identifier (title) for the confirmation copy. */
  projectLabel: string;
  /** True while the restore transaction is in flight (blocks re-submission). */
  restoring: boolean;
  /** Error from the last failed restore attempt, if any. */
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Full-project restore confirmation (P9 B3-3).
 *
 * Restore is DESTRUCTIVE and whole-project (not an "undo" of one edit): the
 * current project root and every project-owned collection are replaced with the
 * snapshot's contents, and rows added after the snapshot are deleted. This
 * dialog makes that contract explicit, shows the target snapshot identity so the
 * wrong one cannot be chosen by mistake, and requires an explicit second-step
 * confirmation on a danger-styled button.
 *
 * It performs NO writes itself: `onConfirm` calls the B3-2
 * `restoreSnapshot(snapshotId, projectId)`, which owns the pre-restore safety
 * snapshot and the single atomic transaction. The dialog never creates a safety
 * snapshot of its own.
 */
export function RestoreSnapshotDialog({
  open,
  snapshot,
  projectLabel,
  restoring,
  error,
  onCancel,
  onConfirm,
}: RestoreSnapshotDialogProps) {
  // Two-step confirmation: the first click reveals the explicit confirm pane.
  const [acknowledged, setAcknowledged] = useState(false);

  // Reset the acknowledgement whenever the dialog opens for a (new) snapshot.
  useEffect(() => {
    if (open) setAcknowledged(false);
  }, [open, snapshot?.id]);

  if (!snapshot) return null;

  const shortId =
    snapshot.id.length > 20 ? `${snapshot.id.slice(0, 12)}…${snapshot.id.slice(-6)}` : snapshot.id;

  return (
    <ProjectDialog
      open={open}
      title="Restore this snapshot?"
      description="This replaces the ENTIRE current project with the snapshot. It is not an undo of a single edit."
      onClose={onCancel}
      dismissible={!restoring}
      tone="danger"
      footer={
        acknowledged ? (
          <>
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={restoring}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              iconLeft={<RotateCcw className="size-3.5" />}
              loading={restoring}
              onClick={onConfirm}
            >
              {restoring ? 'Restoring…' : 'Restore entire project'}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={restoring}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              iconLeft={<ShieldAlert className="size-3.5" />}
              onClick={() => setAcknowledged(true)}
            >
              I understand, continue
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        {/* Target identity — shown so the user can verify they picked the right snapshot. */}
        <div className="border-line bg-surface-muted/40 rounded-md border px-3 py-2.5">
          <p className="text-subtle text-2xs font-medium uppercase tracking-wide">Target snapshot</p>
          <div className="mt-1.5 space-y-1 text-xs">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone="info" size="sm">
                {snapshot.reason}
              </Badge>
              <span className="text-ink font-medium">{snapshot.projectTitle || projectLabel}</span>
              <span className="text-subtle">captured {formatRelative(snapshot.createdAt)}</span>
            </div>
            <p className="text-muted">
              <span className="text-subtle">Snapshot ID: </span>
              <span className="font-mono tabular-nums" title={snapshot.id}>
                {shortId}
              </span>
            </p>
            <p className="text-muted">
              <span className="text-subtle">Project: </span>
              {projectLabel}{' '}
              <span className="text-subtle font-mono text-2xs">({snapshot.projectId})</span>
            </p>
          </div>
        </div>

        {/* What restore actually does — stated plainly, no hidden surprises. */}
        <ul className="text-muted space-y-1.5 text-xs leading-relaxed">
          <li className="flex items-start gap-1.5">
            <AlertTriangle className="text-warning mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              <strong className="text-ink">Full project restore, not an undo.</strong> The current
              project’s root record and all of its data (outline, characters, world, drafts, notes and
              more) are replaced with the snapshot’s contents.
            </span>
          </li>
          <li className="flex items-start gap-1.5">
            <AlertTriangle className="text-warning mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              Data added or changed <strong className="text-ink">after</strong> this snapshot may be
              deleted, because it does not exist in the snapshot.
            </span>
          </li>
          <li className="flex items-start gap-1.5">
            <ShieldAlert className="text-accent mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              A <strong className="text-ink">pre-restore safety snapshot</strong> of the current state is
              captured automatically before the restore, so you can recover the previous state.
            </span>
          </li>
          <li className="flex items-start gap-1.5">
            <ShieldAlert className="text-accent mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              If the restore fails, it is rolled back and the current project is left intact. This
              snapshot itself is kept.
            </span>
          </li>
          <li className="text-subtle pl-5 text-2xs">
            API keys and provider credentials are not part of project data and are never touched by a
            restore.
          </li>
        </ul>

        {error ? (
          <p className="text-danger flex items-start gap-1.5 text-xs" role="alert">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {error}
          </p>
        ) : null}

        {acknowledged ? (
          <p
            className="border-danger/40 bg-danger-soft/40 text-danger rounded-md border px-3 py-2 text-xs font-medium"
            role="alert"
          >
            Click “Restore entire project” to confirm. This cannot be undone except by restoring the
            automatic pre-restore snapshot.
          </p>
        ) : null}
      </div>
    </ProjectDialog>
  );
}
