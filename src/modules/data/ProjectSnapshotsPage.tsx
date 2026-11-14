import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Eye,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { Badge, Button, Card, EmptyState, PageHeader } from '@/components/ui';
import { ProjectPicker } from '@/modules/ai/components/ProjectPicker';
import { ProjectDialog } from '@/modules/projects/components/ProjectDialog';
import { useProjects } from '@/hooks';
import { projectSnapshotService, type RestoreSnapshotResult } from '@/services';
import type { ProjectSnapshot } from '@/types';
import { formatRelative } from '@/utils/date';
import { cn } from '@/utils/cn';
import { SnapshotDetailsDialog } from './snapshots/SnapshotDetailsDialog';
import { RestoreSnapshotDialog } from './snapshots/RestoreSnapshotDialog';

/**
 * Window event broadcast after a successful full-project restore.
 *
 * A restore replaces an entire project. Writer pages (Story Editor, Outline,
 * Knowledge Base, …) each load their own data on mount and never share a global
 * cache, so they are refreshed simply by being (re)mounted/navigated to. This
 * event lets any currently-mounted listener — should one exist — invalidate its
 * own state. It is intentionally NOT a cross-tab lock or a data channel: other
 * browser tabs are told to reload via the UI note below.
 */
export const PROJECT_RESTORED_EVENT = 'n87:project-restored';

type ListStatus = 'idle' | 'loading' | 'success' | 'empty' | 'error';

/**
 * Project Snapshots (P9 B3-3).
 *
 * Capture point-in-time snapshots of an ENTIRE project and restore them. This
 * page is a thin UI over the B3-2 `SnapshotService` — it never serialises,
 * validates, hashes or writes project data itself:
 *   - Create  → `projectSnapshotService.createSnapshot`
 *   - List    → `projectSnapshotService.listSnapshots`
 *   - Delete  → `projectSnapshotService.deleteSnapshot`
 *   - Restore → `projectSnapshotService.restoreSnapshot` (service owns the
 *               pre-restore safety snapshot + atomic transaction)
 *
 * After a restore the whole project changes. Because every data page reads
 * fresh from IndexedDB on mount (there is no shared project-data store), the
 * page (a) reloads its own snapshot list and project identity and (b) broadcasts
 * `PROJECT_RESTORED_EVENT` so any mounted consumer can invalidate itself. The
 * service's optimistic-concurrency checks prevent a stale in-flight autosave
 * from another route/tab from silently overwriting restored prose.
 */
export function ProjectSnapshotsPage() {
  const { projects, initialLoading, refresh: refreshProjects } = useProjects();
  const [projectId, setProjectId] = useState('');
  const effectiveProjectId = projectId || projects[0]?.id || '';

  const [snapshots, setSnapshots] = useState<ProjectSnapshot[]>([]);
  const [status, setStatus] = useState<ListStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  // Per-row transient state.
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProjectSnapshot | null>(null);
  const [pendingRestore, setPendingRestore] = useState<ProjectSnapshot | null>(null);
  const [detailsSnapshot, setDetailsSnapshot] = useState<ProjectSnapshot | null>(null);

  // Create state.
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Restore state.
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  // A short-lived success banner (e.g. "Snapshot created", "Project restored").
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flashNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 4000);
  }, []);

  useEffect(() => {
    return () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, []);

  const load = useCallback(async () => {
    if (!effectiveProjectId) {
      setSnapshots([]);
      setStatus('idle');
      return;
    }
    setStatus('loading');
    setError(null);
    try {
      const list = await projectSnapshotService.listSnapshots(effectiveProjectId);
      setSnapshots(list);
      setStatus(list.length > 0 ? 'success' : 'empty');
    } catch (err) {
      setSnapshots([]);
      setStatus('error');
      setError(err instanceof Error ? err.message : 'The snapshots could not be loaded.');
    }
  }, [effectiveProjectId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Reset cross-project transient state whenever the selected project changes.
  useEffect(() => {
    setCreateError(null);
    setRestoreError(null);
    setPendingRestore(null);
    setPendingDelete(null);
    setDetailsSnapshot(null);
    setNotice(null);
  }, [effectiveProjectId]);

  const projectLabel = useMemo(() => {
    const match = projects.find((p) => p.id === effectiveProjectId);
    return match?.title ?? 'this project';
  }, [projects, effectiveProjectId]);

  /* --------------------------------- Create ------------------------------- */
  const createSnapshot = useCallback(async () => {
    if (!effectiveProjectId || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      await projectSnapshotService.createSnapshot(effectiveProjectId);
      await load();
      flashNotice('Snapshot created.');
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'The snapshot could not be created.');
    } finally {
      setCreating(false);
    }
  }, [effectiveProjectId, creating, load, flashNotice]);

  /* --------------------------------- Delete ------------------------------- */
  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setDeletingId(target.id);
    try {
      await projectSnapshotService.deleteSnapshot(target.id, effectiveProjectId);
      setPendingDelete(null);
      await load();
      flashNotice('Snapshot deleted.');
    } catch (err) {
      // Surface inline on the row is not possible after close; keep dialog open
      // and report via the list error area so the user can retry.
      setError(err instanceof Error ? err.message : 'The snapshot could not be deleted.');
    } finally {
      setDeletingId(null);
    }
  }, [pendingDelete, effectiveProjectId, load, flashNotice]);

  /* -------------------------------- Restore ------------------------------- */
  const confirmRestore = useCallback(async () => {
    if (!pendingRestore || restoring) return;
    const target = pendingRestore;
    setRestoring(true);
    setRestoreError(null);
    try {
      const result: RestoreSnapshotResult = await projectSnapshotService.restoreSnapshot(
        target.id,
        effectiveProjectId,
      );
      // The project may have been replaced (e.g. its title) — reload the picker
      // list so the workspace reflects the restored project identity, and reload
      // this page's snapshots (a new pre-restore safety snapshot now exists).
      await Promise.all([load(), refreshProjects()]);
      // Notify any mounted consumer that project data changed wholesale.
      window.dispatchEvent(
        new CustomEvent(PROJECT_RESTORED_EVENT, { detail: { projectId: effectiveProjectId } }),
      );
      setPendingRestore(null);
      flashNotice(
        `Project restored from snapshot. A pre-restore safety snapshot (${result.safetySnapshot.id.slice(0, 12)}…) was created.`,
      );
    } catch (err) {
      setRestoreError(
        err instanceof Error
          ? err.message
          : 'The restore failed. The project was left unchanged and your data is safe.',
      );
    } finally {
      setRestoring(false);
    }
  }, [pendingRestore, restoring, effectiveProjectId, load, refreshProjects, flashNotice]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Project Snapshots"
        description="Capture the whole project — outline, characters, world and drafts — at a point in time, and restore it later. Restoring replaces the entire current project with the snapshot."
        icon={<Camera className="size-4" aria-hidden />}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ProjectPicker
              projects={projects}
              value={effectiveProjectId}
              onChange={setProjectId}
              id="ps-project-picker"
            />
            <Button
              variant="primary"
              size="sm"
              iconLeft={<Camera className="size-3.5" />}
              onClick={() => void createSnapshot()}
              loading={creating}
              disabled={!effectiveProjectId || creating}
            >
              {creating ? 'Creating…' : 'Create Snapshot'}
            </Button>
          </div>
        }
      />

      {notice ? (
        <div
          className="border-success/40 bg-success-soft/50 text-success flex items-start gap-2 rounded-md border px-3 py-2 text-xs"
          role="status"
        >
          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{notice}</span>
        </div>
      ) : null}

      {createError ? (
        <p className="text-danger flex items-start gap-1.5 text-xs" role="alert">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {createError}
        </p>
      ) : null}

      {initialLoading ? (
        <Card padding="lg">
          <p className="text-subtle flex items-center gap-2 text-xs" role="status">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            Loading projects…
          </p>
        </Card>
      ) : projects.length === 0 ? (
        <EmptyState
          icon={<Camera className="size-5" aria-hidden />}
          title="No projects yet"
          description="Snapshots are per project. Create a project first, then capture a point-in-time copy of it here."
        />
      ) : (
        <Card padding="md" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-subtle text-2xs font-medium uppercase tracking-wide">
                Snapshots · {projectLabel}
              </span>
              {status === 'success' ? (
                <Badge tone="neutral" size="sm">
                  {snapshots.length}
                </Badge>
              ) : null}
            </div>
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
          ) : status === 'loading' && snapshots.length === 0 ? (
            <p className="text-subtle flex items-center gap-2 text-xs" role="status">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              Loading snapshots…
            </p>
          ) : status === 'empty' ? (
            <EmptyState
              icon={<Camera className="size-5" aria-hidden />}
              title="No snapshots taken"
              description="A snapshot freezes the whole project at one moment. Create your first snapshot to be able to restore this state later."
              action={
                <Button
                  variant="primary"
                  size="sm"
                  iconLeft={<Camera className="size-3.5" />}
                  onClick={() => void createSnapshot()}
                  loading={creating}
                >
                  Create Snapshot
                </Button>
              }
            />
          ) : (
            <ul className="space-y-2">
              {snapshots.map((snapshot) => (
                <li key={snapshot.id}>
                  <SnapshotRow
                    snapshot={snapshot}
                    deleting={deletingId === snapshot.id}
                    busy={restoring}
                    onDetails={() => setDetailsSnapshot(snapshot)}
                    onRestore={() => {
                      setRestoreError(null);
                      setPendingRestore(snapshot);
                    }}
                    onDelete={() => setPendingDelete(snapshot)}
                  />
                </li>
              ))}
            </ul>
          )}

          <p className="text-subtle flex items-start gap-1.5 text-2xs leading-relaxed">
            <ShieldAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
            Restoring replaces the whole project. If you have this project open in another browser tab,
            reload that tab afterwards — snapshots do not coordinate live tabs.
          </p>
        </Card>
      )}

      {/* Details */}
      <SnapshotDetailsDialog
        open={detailsSnapshot !== null}
        snapshot={detailsSnapshot}
        onClose={() => setDetailsSnapshot(null)}
      />

      {/* Delete confirmation */}
      <DeleteSnapshotDialog
        snapshot={pendingDelete}
        deleting={deletingId !== null}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
      />

      {/* Restore confirmation */}
      <RestoreSnapshotDialog
        open={pendingRestore !== null}
        snapshot={pendingRestore}
        projectLabel={projectLabel}
        restoring={restoring}
        error={restoreError}
        onCancel={() => {
          if (restoring) return;
          setPendingRestore(null);
          setRestoreError(null);
        }}
        onConfirm={() => void confirmRestore()}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function SnapshotRow({
  snapshot,
  deleting,
  busy,
  onDetails,
  onRestore,
  onDelete,
}: {
  snapshot: ProjectSnapshot;
  deleting: boolean;
  busy: boolean;
  onDetails: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const totalRows = Object.values(snapshot.counts).reduce((sum, n) => sum + n, 0);
  const populated = Object.values(snapshot.counts).filter((n) => n > 0).length;
  const shortId =
    snapshot.id.length > 18 ? `${snapshot.id.slice(0, 10)}…${snapshot.id.slice(-5)}` : snapshot.id;

  return (
    <Card padding="sm" interactive={false}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={snapshot.reason === 'pre-restore' ? 'warning' : 'info'} size="sm">
              {snapshot.reason}
            </Badge>
            <span className="text-ink text-xs font-medium tabular-nums">
              {formatRelative(snapshot.createdAt)}
            </span>
            <span className="text-subtle font-mono text-2xs" title={snapshot.id}>
              {shortId}
            </span>
          </div>
          <p className="text-muted mt-1 truncate text-2xs">
            {snapshot.projectTitle || 'Untitled project'}
          </p>
          <div className="text-subtle mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs tabular-nums">
            <span title="Total records across all collections">
              {totalRows.toLocaleString()} records
            </span>
            <span>{populated} collections populated</span>
            <span>{snapshot.wordCount.toLocaleString()} words</span>
          </div>
          <div className="mt-1.5 flex items-center gap-1.5">
            <Badge tone="success" size="sm" dot>
              Integrity verified
            </Badge>
            <span
              className="text-subtle font-mono text-2xs"
              title={snapshot.integrity.digest}
            >
              {snapshot.integrity.digest.slice(0, 12)}…
            </span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            iconLeft={<Eye className="size-3.5" />}
            onClick={onDetails}
            disabled={busy || deleting}
          >
            Details
          </Button>
          <Button
            variant="ghost"
            size="sm"
            iconLeft={<RotateCcw className="size-3.5" />}
            onClick={onRestore}
            disabled={busy || deleting}
          >
            Restore
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-danger hover:bg-danger-soft/50"
            iconLeft={<Trash2 className="size-3.5" />}
            onClick={onDelete}
            loading={deleting}
            disabled={busy || deleting}
          >
            Delete
          </Button>
        </div>
      </div>
    </Card>
  );
}

function DeleteSnapshotDialog({
  snapshot,
  deleting,
  onCancel,
  onConfirm,
}: {
  snapshot: ProjectSnapshot | null;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ProjectDialog
      open={snapshot !== null}
      title="Delete this snapshot?"
      description="The snapshot will be permanently removed. The project data itself is NOT affected."
      onClose={onCancel}
      dismissible={!deleting}
      tone="danger"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={deleting}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            iconLeft={<Trash2 className="size-3.5" />}
            loading={deleting}
            onClick={onConfirm}
          >
            {deleting ? 'Deleting…' : 'Delete snapshot'}
          </Button>
        </>
      }
    >
      {snapshot ? (
        <div className={cn('text-muted space-y-1 text-xs')}>
          <p>
            <span className="text-subtle">Snapshot: </span>
            <span className="font-mono break-all" title={snapshot.id}>
              {snapshot.id}
            </span>
          </p>
          <p>
            <span className="text-subtle">Captured: </span>
            {formatRelative(snapshot.createdAt)}
          </p>
          <p className="text-subtle pt-1">
            Only this snapshot record is deleted. Your current project data and other snapshots are
            untouched.
          </p>
        </div>
      ) : null}
    </ProjectDialog>
  );
}
