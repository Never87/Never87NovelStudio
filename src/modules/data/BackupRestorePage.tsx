import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  CheckCircle2,
  DatabaseBackup,
  Download,
  FileJson,
  FolderOpen,
  Info,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  Upload,
  X,
} from 'lucide-react';
import { Badge, Button, Card, EmptyState, PageHeader } from '@/components/ui';
import { ProjectPicker } from '@/modules/ai/components/ProjectPicker';
import { ProjectDialog } from '@/modules/projects/components/ProjectDialog';
import { useProjects } from '@/hooks';
import {
  backupService,
  backupPreviewService,
  MAX_BACKUP_FILE_BYTES,
  projectRestoreService,
  ProjectRestoreError,
  type BackupPreview,
  type BackupCollectionCount,
  type ValidatedBackupEntry,
  type ProjectRestoreResult,
} from '@/services';
import { flushProjectEditors, reloadProjectEditors } from '@/modules/editor/editor-registry';
import { formatRelative } from '@/utils/date';
/**
 * The window event broadcast after a successful full-project restore.
 *
 * Mirrors `PROJECT_RESTORED_EVENT` exported by the B3 snapshots page. Kept as a
 * string literal here to avoid importing a page module; it is the SAME event so
 * any mounted consumer responds identically. It is intentionally NOT a cross-tab
 * lock — other tabs are told to reload via the UI note.
 */
const PROJECT_RESTORED_EVENT = 'n87:project-restored';

/**
 * Backup & Restore — Project backup EXPORT (B4-1) + IMPORT preview (B4-2) +
 * RESTORE (B4-3).
 *
 * This page turns the `backup` navigation item into a real surface for:
 *   - EXPORTING a COMPLETE single-project backup file (B4-1),
 *   - INSPECTING a `.n87novel` backup file (B4-2) — parse + validate + preview, and
 *   - RESTORING a validated backup as a NEW project or by REPLACING one (B4-3).
 *
 * All paths are thin UI over the P9 foundation: export reuses
 * `backupService.exportProjectFile`; import reuses `backupPreviewService`; the
 * restore re-validates via `backupPreviewService.parseBackupEntry` and writes
 * through `projectRestoreService` (atomic, safety-snapshotted). No transfer
 * format, validation or integrity logic is re-implemented here.
 *
 * Scope:
 *   - SUPPORTED: download a full single-project JSON backup (`.n87novel`).
 *   - SUPPORTED: select + PREVIEW a backup file (read-only; no writes).
 *   - SUPPORTED: restore as a new project, or replace an explicitly-selected one.
 *   - NOT YET:   workspace (all-projects) backup (deferred — see B4 decision).
 *
 * Distinction the page makes explicit: PROJECT SNAPSHOTS are in-browser
 * snapshots (`/data/snapshots`); this page produces/receives a BACKUP FILE on
 * the user's device. They are different safety mechanisms.
 */
const DOWNLOAD_REVOKE_DELAY_MS = 0; // revoke immediately after the click is queued

interface LastExport {
  readonly fileName: string;
  readonly projectTitle: string;
  readonly totalRecords: number;
  readonly exportedAt: number;
}

/** Transient state for an in-flight / completed / failed restore operation. */
type RestoreUiState =
  | { readonly status: 'running'; readonly mode: 'new' | 'replace' }
  | { readonly status: 'success'; readonly mode: 'new' | 'replace'; readonly result: ProjectRestoreResult }
  | { readonly status: 'error'; readonly mode: 'new' | 'replace'; readonly message: string };

export function BackupRestorePage() {
  const { projects, initialLoading, refresh: refreshProjects } = useProjects();
  const navigate = useNavigate();
  const [projectId, setProjectId] = useState('');
  const effectiveProjectId = projectId || projects[0]?.id || '';

  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastExport, setLastExport] = useState<LastExport | null>(null);
  // Guards against a double-click firing two downloads before React re-renders.
  const inFlight = useRef(false);

  const projectLabel = useMemo(() => {
    const match = projects.find((p) => p.id === effectiveProjectId);
    return match?.title ?? 'this project';
  }, [projects, effectiveProjectId]);

  /**
   * Downloads a file through the Blob + object-URL + anchor pattern used
   * elsewhere in the app. The object URL is always released, even when the
   * click throws, so no temporary resource leaks.
   */
  const downloadFile = useCallback((content: string, fileName: string, mimeType: string) => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    let anchor: HTMLAnchorElement | null = null;
    try {
      anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      anchor.rel = 'noopener';
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
    } finally {
      if (anchor && anchor.parentNode) anchor.parentNode.removeChild(anchor);
      // Release the object URL once the download has been queued.
      window.setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_REVOKE_DELAY_MS);
    }
  }, []);

  const handleExport = useCallback(async () => {
    if (!effectiveProjectId || inFlight.current) return;
    inFlight.current = true;
    setExporting(true);
    setError(null);
    setLastExport(null);
    try {
      const file = await backupService.exportProjectFile(effectiveProjectId);
      downloadFile(file.content, file.fileName, file.mimeType);
      setLastExport({
        fileName: file.fileName,
        projectTitle: file.projectTitle,
        totalRecords: file.totalRecords,
        exportedAt: file.exportedAt,
      });
    } catch (err) {
      // Never fake success on failure.
      setError(
        err instanceof Error
          ? err.message
          : 'The backup could not be created. No file was downloaded.',
      );
    } finally {
      inFlight.current = false;
      setExporting(false);
    }
  }, [effectiveProjectId, downloadFile]);

  /* ---- Import / preview (P9 Batch 4-2): READ-ONLY, no restore ----------- */
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  // The file's already-read text, kept so a restore can re-parse (via the REAL
  // service) to obtain the validated entry WITHOUT the display preview carrying
  // the raw payload. Cleared whenever the preview is cleared.
  const [previewText, setPreviewText] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Guards against re-reading/re-parsing the same file while a parse is running.
  const parseInFlight = useRef(false);

  /* ---- Restore (P9 Batch 4-3): the ONLY write path on this page ---------- */
  // One flag per in-flight operation so a double-click can never fire twice and
  // the two actions can never run concurrently.
  const restoringNew = useRef(false);
  const restoringReplace = useRef(false);
  const [restore, setRestore] = useState<RestoreUiState | null>(null);
  // The modal currently open: 'new' | 'replace' | null (closed).
  const [restoreDialog, setRestoreDialog] = useState<'new' | 'replace' | null>(null);
  // Explicit target project for replace mode — NEVER inferred from the backup.
  const [targetProjectId, setTargetProjectId] = useState('');
  // A short-lived success banner after a completed restore.
  const [restoredNotice, setRestoredNotice] = useState<string | null>(null);

  const resetRestoreState = useCallback(() => {
    setRestore(null);
    setRestoreDialog(null);
    setTargetProjectId('');
    setRestoredNotice(null);
  }, []);

  const resetPreview = useCallback(() => {
    setPreview(null);
    setImportError(null);
    setPreviewFile(null);
    setPreviewText(null);
    resetRestoreState();
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [resetRestoreState]);

  const handleFileSelected = useCallback(
    async (fileList: FileList | null) => {
      const file = fileList?.[0];
      if (!file || parseInFlight.current) return;
      // Reset any previous state so a failure never leaves a stale preview.
      setPreview(null);
      setImportError(null);
      setPreviewFile(file.name);
      setPreviewText(null);
      resetRestoreState();

      if (file.size > MAX_BACKUP_FILE_BYTES) {
        setImportError(
          `This file is ${(file.size / (1024 * 1024)).toFixed(1)} MB, which exceeds the 64 MB limit for a project backup.`,
        );
        return;
      }

      parseInFlight.current = true;
      setParsing(true);
      try {
        const text = await file.text();
        // The REAL parsing/validation service — no client-side shortcut.
        const result = await backupPreviewService.previewBackupFile(
          { text, name: file.name },
          { fileName: file.name },
        );
        setPreview(result);
        setPreviewText(text);
      } catch (err) {
        setPreview(null);
        setPreviewText(null);
        setImportError(
          err instanceof Error
            ? err.message
            : 'The selected file could not be read as a project backup.',
        );
      } finally {
        parseInFlight.current = false;
        setParsing(false);
      }
    },
    [resetRestoreState],
  );

  /**
   * Shared restore driver for BOTH modes.
   *
   * Ordering (per `BACKUP_RESTORE_UI_LIFECYCLE`):
   *   1. Re-parse the already-read bytes via the REAL service to obtain the
   *      validated entry (a stale preview is never authorisation — the restore
   *      service re-validates again anyway).
   *   2. REPLACE only: FLUSH every open editor for the TARGET project so no
   *      debounced autosave can land after the destructive write.
   *   3. Run the real `projectRestoreService` call (owns the atomic transaction
   *      and, for replace, the pre-restore safety snapshot).
   *   4. After success: RELOAD registered editors for the affected project,
   *      refresh the project list, broadcast PROJECT_RESTORED_EVENT, and clear
   *      the preview. Editors in OTHER tabs rely on optimistic concurrency and
   *      are told to reload via the UI note.
   */
  const runRestore = useCallback(
    async (mode: 'new' | 'replace') => {
      if (!preview || !previewText) return;
      const inflight = mode === 'new' ? restoringNew : restoringReplace;
      if (inflight.current) return;

      const targetForReplace = mode === 'replace' ? targetProjectId : '';
      if (mode === 'replace' && !targetForReplace) {
        setRestore({ status: 'error', mode, message: 'Select a target project before replacing.' });
        return;
      }

      inflight.current = true;
      setRestore({ status: 'running', mode });
      try {
        // (1) Re-validate the bytes to get the entry the service consumes.
        let validated: ValidatedBackupEntry;
        try {
          validated = await backupPreviewService.parseBackupEntry(
            { text: previewText, name: preview.fileName },
            { fileName: preview.fileName },
          );
        } catch (err) {
          setRestore({
            status: 'error',
            mode,
            message:
              err instanceof Error
                ? err.message
                : 'The backup could not be re-read and was not restored.',
          });
          return;
        }

        // (2) Replace: flush open editors for the TARGET before writing.
        if (mode === 'replace') {
          await flushProjectEditors(targetForReplace);
        }

        // (3) The real restore (atomic; replace captures the safety snapshot).
        let result: ProjectRestoreResult;
        if (mode === 'new') {
          result = await projectRestoreService.restoreAsNewProject(validated.entry);
        } else {
          result = await projectRestoreService.replaceExistingProject(
            validated.entry,
            targetForReplace,
          );
        }

        // (4) Post-success coordination + feedback.
        await reloadProjectEditors(result.projectId);
        await refreshProjects();

        window.dispatchEvent(
          new CustomEvent(PROJECT_RESTORED_EVENT, { detail: { projectId: result.projectId } }),
        );

        const snapshotSuffix =
          result.mode === 'replace' && result.safetySnapshot
            ? ` A pre-restore safety snapshot (${result.safetySnapshot.id.slice(0, 12)}…) was created.`
            : '';
        setRestoredNotice(
          result.mode === 'new'
            ? `Restored “${preview.projectTitle}” as a new project (${result.projectId}). Open it from the project list to start working.`
            : `Restored “${preview.projectTitle}” over the selected project.${snapshotSuffix}`,
        );
        setRestore({ status: 'success', mode, result });
        setRestoreDialog(null);
        setTargetProjectId('');
        // The preview is consumed by a completed restore; clear it so it cannot
        // be re-submitted against now-changed local state.
        setPreview(null);
        setPreviewText(null);
        setPreviewFile(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
      } catch (err) {
        // Never claim success on failure. Surface the typed error's message.
        const message =
          err instanceof ProjectRestoreError || err instanceof Error
            ? err.message
            : 'The restore failed. No project data was changed.';
        setRestore({ status: 'error', mode, message });
      } finally {
        inflight.current = false;
      }
    },
    [preview, previewText, targetProjectId, refreshProjects],
  );

  // Navigate to the restored project so it is immediately accessible.
  const goToRestoredProject = useCallback(
    (result: ProjectRestoreResult) => {
      navigate(`/projects/${result.projectId}`);
    },
    [navigate],
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Backup & Restore"
        description="Download a complete backup of a single project — its outline, characters, world, drafts, knowledge and imported documents — as one portable JSON file."
        icon={<DatabaseBackup className="size-4" aria-hidden />}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ProjectPicker
              projects={projects}
              value={effectiveProjectId}
              onChange={(id) => {
                setProjectId(id);
                setLastExport(null);
                setError(null);
              }}
              id="backup-project-picker"
            />
            <Button
              variant="primary"
              size="sm"
              iconLeft={<Download className="size-3.5" />}
              onClick={() => void handleExport()}
              loading={exporting}
              disabled={!effectiveProjectId || exporting}
            >
              {exporting ? 'Preparing…' : 'Download backup'}
            </Button>
          </div>
        }
      />

      {/* Success feedback (only shown after a real, completed download). */}
      {lastExport ? (
        <div
          className="border-success/40 bg-success-soft/50 text-success flex items-start gap-2 rounded-md border px-3 py-2 text-xs"
          role="status"
        >
          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            Backup downloaded for <strong>{lastExport.projectTitle}</strong> —{' '}
            <span className="font-mono">{lastExport.fileName}</span> (
            {lastExport.totalRecords.toLocaleString()} records, exported{' '}
            {formatRelative(lastExport.exportedAt)}).
          </span>
        </div>
      ) : null}

      {/* Error feedback (never masked as success). */}
      {error ? (
        <p className="text-danger flex items-start gap-1.5 text-xs" role="alert">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      ) : null}

      {/* Restore success banner (only after the service resolves successfully). */}
      {restoredNotice && restore?.status === 'success' ? (
        <div
          className="border-success/40 bg-success-soft/50 text-success flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs"
          role="status"
          data-testid="backup-restore-success"
        >
          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="flex-1">{restoredNotice}</span>
          <Button
            variant="secondary"
            size="sm"
            iconLeft={<DatabaseBackup className="size-3.5" />}
            onClick={() => goToRestoredProject(restore.result)}
          >
            Open project
          </Button>
        </div>
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
          icon={<FolderOpen className="size-5" aria-hidden />}
          title="No projects to back up"
          description="Create a project first. Once you have one, you can download a complete backup of it here."
        />
      ) : (
        <Card padding="md" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-subtle text-2xs font-medium uppercase tracking-wide">
              Selected project · {projectLabel}
            </span>
            <Badge tone="neutral" size="sm">
              Project backup
            </Badge>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <BackupFact
              icon={<FileJson className="size-3.5" aria-hidden />}
              title="One JSON file (.n87novel)"
              body="Portable, integrity-checked JSON containing the whole project."
            />
            <BackupFact
              icon={<DatabaseBackup className="size-3.5" aria-hidden />}
              title="All 19 project collections"
              body="Outline, characters, world, drafts, versions, prompt templates, context, knowledge, continuity, analysis and imported documents."
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              iconLeft={<Download className="size-3.5" />}
              onClick={() => void handleExport()}
              loading={exporting}
              disabled={!effectiveProjectId || exporting}
            >
              {exporting ? 'Preparing…' : 'Download backup'}
            </Button>
            <span className="text-subtle text-2xs">
              {exporting
                ? 'Building the backup…'
                : 'The file is saved to your device — nothing is uploaded.'}
            </span>
          </div>

          {/* Scope clarifications — required by the batch contract. */}
          <div className="border-line space-y-1.5 border-t pt-3">
            <p className="text-subtle flex items-start gap-1.5 text-2xs leading-relaxed">
              <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
              <span>
                <strong className="text-muted">Also supported:</strong> restoring a backup file — as
                a new project, or by replacing an existing one — in the Import section below.
              </span>
            </p>
            <p className="text-subtle flex items-start gap-1.5 text-2xs leading-relaxed">
              <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
              <span>
                <strong className="text-muted">Different from Project Snapshots:</strong> snapshots
                are automatic in-browser restore points (see Project Snapshots). This page creates a
                backup file you keep on your own device.
              </span>
            </p>
          </div>
        </Card>
      )}

      {/* ================= Import Backup / Preview / Restore (B4-2 + B4-3) == */}
      {/* Selecting a file only parses & previews it (read-only). A RESTORE is  */}
      {/* the only write path, reached through an explicit confirm dialog.     */}
      <Card padding="md" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-subtle text-2xs font-medium uppercase tracking-wide">
            Import &amp; restore
          </span>
          <Badge tone="neutral" size="sm">
            Preview, then restore
          </Badge>
        </div>

        <div>
          <p className="text-ink text-sm font-medium">Preview a backup file</p>
          <p className="text-subtle mt-1 text-2xs leading-relaxed">
            Choose a <span className="font-mono">.n87novel</span> project backup to validate it and
            see what it contains. This only <strong className="text-muted">inspects</strong> the
            file — nothing is imported, changed or restored yet.
          </p>
        </div>

        {/* Hidden real file input, triggered by the button. */}
        <input
          ref={fileInputRef}
          id="backup-import-file"
          type="file"
          accept=".n87novel,application/json"
          className="sr-only"
          onChange={(event) => void handleFileSelected(event.target.files)}
          data-testid="backup-import-input"
        />

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            iconLeft={<Upload className="size-3.5" />}
            onClick={() => fileInputRef.current?.click()}
            loading={parsing}
            disabled={parsing}
          >
            {parsing ? 'Inspecting…' : preview ? 'Choose another file' : 'Select backup file'}
          </Button>
          {preview || importError || previewFile ? (
            <Button
              variant="ghost"
              size="sm"
              iconLeft={<RotateCcw className="size-3.5" />}
              onClick={resetPreview}
              disabled={parsing}
            >
              Clear preview
            </Button>
          ) : null}
          <span className="text-subtle text-2xs">
            {parsing
              ? 'Validating the selected file…'
              : `Accepted: .n87novel · max ${(MAX_BACKUP_FILE_BYTES / (1024 * 1024)).toFixed(0)} MB`}
          </span>
        </div>

        {/* Import error (invalid file / validation failure) — recoverable. */}
        {importError ? (
          <div
            className="border-danger/40 bg-danger/10 text-danger flex items-start gap-2 rounded-md border px-3 py-2 text-xs"
            role="alert"
            data-testid="backup-import-error"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              <strong>This file could not be previewed.</strong> {importError}
            </span>
          </div>
        ) : null}

        {/* Preview panel. */}
        {preview ? <BackupPreviewPanel preview={preview} onDismiss={resetPreview} /> : null}

        {/* Restore actions — ONLY after a valid preview. Invalid/absent previews
            show no restore controls at all. */}
        {preview && previewText ? (
          <RestoreActions
            preview={preview}
            projects={projects}
            restoring={restore?.status === 'running' ? restore.mode : null}
            onRestoreNew={() => setRestoreDialog('new')}
            onRestoreReplace={() => setRestoreDialog('replace')}
          />
        ) : null}

        <p className="text-subtle border-line flex items-start gap-1.5 border-t pt-3 text-2xs leading-relaxed">
          <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span>
            <strong className="text-muted">Selecting a file never changes anything.</strong> A
            restore only happens after you choose an action above and confirm it. The backup is
            re-validated before writing, and replacement is applied atomically.
          </span>
        </p>
      </Card>

      {/* ======================= Restore confirmation dialogs ============= */}
      <RestoreNewDialog
        open={restoreDialog === 'new'}
        preview={preview}
        running={restore?.status === 'running' && restore.mode === 'new'}
        error={restore?.status === 'error' && restore.mode === 'new' ? restore.message : null}
        onCancel={() => {
          if (restore?.status === 'running') return;
          setRestoreDialog(null);
        }}
        onConfirm={() => void runRestore('new')}
      />

      <RestoreReplaceDialog
        open={restoreDialog === 'replace'}
        preview={preview}
        projects={projects}
        targetProjectId={targetProjectId}
        onTargetChange={setTargetProjectId}
        running={restore?.status === 'running' && restore.mode === 'replace'}
        error={restore?.status === 'error' && restore.mode === 'replace' ? restore.message : null}
        onCancel={() => {
          if (restore?.status === 'running') return;
          setRestoreDialog(null);
        }}
        onConfirm={() => void runRestore('replace')}
      />
    </div>
  );
}

/** A read-only panel summarising a validated backup file. */
function BackupPreviewPanel({
  preview,
  onDismiss,
}: {
  preview: BackupPreview;
  onDismiss: () => void;
}) {
  return (
    <div
      className="border-line rounded-md border p-3"
      data-testid="backup-preview-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-ink flex items-center gap-1.5 text-sm font-medium">
            <FileJson className="size-3.5 text-accent" aria-hidden />
            <span className="break-all">{preview.fileName}</span>
          </p>
          <p className="text-subtle mt-0.5 text-2xs">
            Valid project backup · <span className="font-mono">{prettyBytes(preview.fileSizeBytes)}</span>
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          iconLeft={<X className="size-3.5" />}
          onClick={onDismiss}
          aria-label="Dismiss preview"
        >
          Dismiss
        </Button>
      </div>

      {/* Status line — validated, integrity verified, no restore done. */}
      <div
        className="border-success/40 bg-success-soft/50 text-success mt-3 flex items-start gap-2 rounded-md border px-3 py-2 text-xs"
        role="status"
      >
        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>
          <strong>Valid backup file.</strong> Structure, references and integrity digest all check
          out. No restore has been performed.
        </span>
      </div>

      {/* Existing-project warning (read-only detection). */}
      {preview.sourceProjectExistsLocally ? (
        <div
          className="border-warning/40 bg-warning-soft/50 text-warning mt-2 flex items-start gap-2 rounded-md border px-3 py-2 text-xs"
          role="status"
          data-testid="backup-existing-project-warning"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            A project with this id (<span className="font-mono">{preview.projectId}</span>) already
            exists locally. A future restore will offer choices (e.g. overwrite, duplicate); nothing
            has been changed now.
          </span>
        </div>
      ) : (
        <div
          className="border-line bg-surface-muted/40 text-subtle mt-2 flex items-start gap-2 rounded-md border px-3 py-2 text-xs"
          role="status"
          data-testid="backup-new-project-note"
        >
          <Search className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            This project does not currently exist locally. A future restore would create it as a new
            project.
          </span>
        </div>
      )}

      {/* Metadata grid. */}
      <dl className="mt-3 grid gap-2 text-2xs sm:grid-cols-2">
        <PreviewFact label="Source project" value={preview.projectTitle} />
        <PreviewFact label="Source project id" value={preview.projectId} mono />
        <PreviewFact
          label="Backup exported"
          value={
            preview.exportedAt > 0
              ? `${new Date(preview.exportedAt).toLocaleString()} (${formatRelative(preview.exportedAt)})`
              : 'Unknown'
          }
        />
        <PreviewFact
          label="Format / schema version"
          value={`format v${preview.formatVersion} · schema v${preview.schemaVersion}`}
        />
        <PreviewFact
          label="Integrity digest"
          value={`${preview.integrityDigest.slice(0, 16)}… (verified)`}
          mono
        />
        <PreviewFact
          label="Total records"
          value={`${preview.totalRecords.toLocaleString()} across ${preview.collections.length} collections`}
        />
      </dl>

      {/* Schema-version warning from real validation. */}
      {preview.warnings.length > 0 ? (
        <div className="mt-3 space-y-1">
          {preview.warnings.map((w, i) => (
            <p key={`${w.code}-${i}`} className="text-warning flex items-start gap-1.5 text-2xs">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
              {w.message}
            </p>
          ))}
        </div>
      ) : null}

      {/* Per-collection counts (all 19). */}
      <details className="mt-3" open>
        <summary className="text-subtle cursor-pointer text-2xs font-medium uppercase tracking-wide">
          Records per collection
        </summary>
        <div className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
          {preview.collections.map((c) => (
            <CollectionCountRow key={c.key} collection={c} />
          ))}
        </div>
      </details>

      <p className="text-subtle mt-3 border-line border-t pt-2 text-2xs leading-relaxed">
        <strong className="text-muted">Nothing has been restored yet.</strong> Use one of the restore
        actions below — each requires your explicit confirmation, and the file is re-validated before
        any project data is written.
      </p>
    </div>
  );
}

function PreviewFact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-subtle uppercase tracking-wide">{label}</dt>
      <dd className={`text-ink mt-0.5 break-all ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  );
}

function CollectionCountRow({ collection }: { collection: BackupCollectionCount }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-subtle truncate font-mono text-[11px]">{collection.table}</span>
      <span className="text-ink tabular-nums text-[11px]">{collection.count.toLocaleString()}</span>
    </div>
  );
}

/**
 * The two restore choices, shown ONLY after a valid preview.
 *
 * Both launch a confirmation dialog; neither writes anything itself. The source
 * project name is always shown; the replace action requires an explicit target
 * (selected in its dialog) and never infers it from the backup.
 */
function RestoreActions({
  preview,
  restoring,
  onRestoreNew,
  onRestoreReplace,
}: {
  preview: BackupPreview;
  projects: Array<{ id: string; title: string }>;
  restoring: 'new' | 'replace' | null;
  onRestoreNew: () => void;
  onRestoreReplace: () => void;
}) {
  const busy = restoring !== null;
  return (
    <div
      className="border-line space-y-3 rounded-md border p-3"
      data-testid="backup-restore-actions"
    >
      <div>
        <p className="text-ink text-sm font-medium">Restore this backup</p>
        <p className="text-subtle mt-1 text-2xs leading-relaxed">
          Source project: <strong className="text-muted">{preview.projectTitle}</strong> (
          <span className="font-mono">{preview.projectId}</span>). Both options re-validate the file
          before writing and require confirmation.
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="border-line bg-surface-muted/40 flex flex-col justify-between gap-2 rounded-md border px-3 py-2.5">
          <div>
            <p className="text-ink flex items-center gap-1.5 text-xs font-medium">
              <FileJson className="size-3.5 text-accent" aria-hidden />
              Restore as new project
            </p>
            <p className="text-subtle mt-1 text-2xs leading-relaxed">
              Creates a brand-new project with a fresh ID. Existing projects are never touched.
            </p>
          </div>
          <Button
            variant="primary"
            size="sm"
            iconLeft={<Download className="size-3.5 rotate-180" />}
            onClick={onRestoreNew}
            disabled={busy}
            loading={restoring === 'new'}
            data-testid="backup-restore-new"
          >
            {restoring === 'new' ? 'Restoring…' : 'Restore as new project'}
          </Button>
        </div>

        <div className="border-danger/40 bg-danger-soft/20 flex flex-col justify-between gap-2 rounded-md border px-3 py-2.5">
          <div>
            <p className="text-danger flex items-center gap-1.5 text-xs font-medium">
              <AlertTriangle className="size-3.5" aria-hidden />
              Replace existing project
            </p>
            <p className="text-subtle mt-1 text-2xs leading-relaxed">
              Deletes the target’s current content across all 19 collections and replaces it with
              this backup. A pre-restore safety snapshot is created first.
            </p>
          </div>
          <Button
            variant="danger"
            size="sm"
            iconLeft={<RefreshCw className="size-3.5" />}
            onClick={onRestoreReplace}
            disabled={busy}
            loading={restoring === 'replace'}
            data-testid="backup-restore-replace"
          >
            {restoring === 'replace' ? 'Replacing…' : 'Replace existing project'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Confirmation for RESTORE-AS-NEW. Two-step: first click reveals the confirm pane. */
function RestoreNewDialog({
  open,
  preview,
  running,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  preview: BackupPreview | null;
  running: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  // Reset the two-step acknowledgement whenever the dialog (re)opens.
  useEffect(() => {
    if (open) setAcknowledged(false);
  }, [open]);
  if (!preview) return null;

  return (
    <ProjectDialog
      open={open}
      title="Restore as a new project?"
      description="A new project with a fresh ID will be created from this backup. Existing projects are not affected."
      onClose={onCancel}
      dismissible={!running}
      footer={
        acknowledged ? (
          <>
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={running}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              iconLeft={<Download className="size-3.5 rotate-180" />}
              loading={running}
              onClick={onConfirm}
              data-testid="backup-restore-new-confirm"
            >
              {running ? 'Restoring…' : 'Create new project'}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={running}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => setAcknowledged(true)}
              data-testid="backup-restore-new-acknowledge"
            >
              Continue
            </Button>
          </>
        )
      }
    >
      <RestoreConfirmBody
        preview={preview}
        error={error}
        acknowledged={acknowledged}
        ackText="Click “Create new project” to confirm. No existing project will be modified."
        facts={
          <ul className="text-muted space-y-1.5 text-xs leading-relaxed">
            <li className="flex items-start gap-1.5">
              <CheckCircle2 className="text-success mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>
                A <strong className="text-ink">new project</strong> is created with a{' '}
                <strong className="text-ink">fresh ID</strong> — the source project id (
                <span className="font-mono">{preview.projectId}</span>) is not reused.
              </span>
            </li>
            <li className="flex items-start gap-1.5">
              <CheckCircle2 className="text-success mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>Existing projects, including the source, are left untouched.</span>
            </li>
            <li className="text-subtle pl-5 text-2xs">
              Provider credentials / API keys are never part of a backup and are never restored.
            </li>
          </ul>
        }
      />
    </ProjectDialog>
  );
}

/** Confirmation for REPLACE-EXISTING. Requires an explicit target + destructive two-step. */
function RestoreReplaceDialog({
  open,
  preview,
  projects,
  targetProjectId,
  onTargetChange,
  running,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  preview: BackupPreview | null;
  projects: Array<{ id: string; title: string }>;
  targetProjectId: string;
  onTargetChange: (id: string) => void;
  running: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  // Reset the destructive two-step acknowledgement whenever the dialog (re)opens.
  useEffect(() => {
    if (open) setAcknowledged(false);
  }, [open]);
  if (!preview) return null;

  const target = projects.find((p) => p.id === targetProjectId) ?? null;
  const canConfirm = target !== null;

  return (
    <ProjectDialog
      open={open}
      title="Replace an existing project?"
      description="This DESTROYS the selected project’s current content and replaces it with this backup. It is not an undo of a single edit."
      onClose={onCancel}
      dismissible={!running}
      tone="danger"
      footer={
        acknowledged ? (
          <>
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={running}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              iconLeft={<RefreshCw className="size-3.5" />}
              loading={running}
              disabled={running || !canConfirm}
              onClick={onConfirm}
              data-testid="backup-restore-replace-confirm"
            >
              {running ? 'Replacing…' : 'Replace project'}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={running}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              iconLeft={<AlertTriangle className="size-3.5" />}
              disabled={!canConfirm}
              onClick={() => setAcknowledged(true)}
              data-testid="backup-restore-replace-acknowledge"
            >
              I understand, continue
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        {/* Source vs target identity, shown together for an explicit decision. */}
        <div className="border-line bg-surface-muted/40 rounded-md border px-3 py-2.5 text-xs">
          <div className="grid gap-1.5 sm:grid-cols-2">
            <div>
              <p className="text-subtle text-2xs font-medium uppercase tracking-wide">Source (from backup)</p>
              <p className="text-ink mt-0.5 font-medium">{preview.projectTitle}</p>
              <p className="text-subtle font-mono text-2xs">{preview.projectId}</p>
            </div>
            <div>
              <p className="text-subtle text-2xs font-medium uppercase tracking-wide">Target (will be replaced)</p>
              {target ? (
                <>
                  <p className="text-ink mt-0.5 font-medium">{target.title}</p>
                  <p className="text-subtle font-mono text-2xs">{target.id}</p>
                </>
              ) : (
                <p className="text-warning mt-0.5 text-2xs">No target selected yet</p>
              )}
            </div>
          </div>
        </div>

        {/* Explicit target selection — NEVER inferred from the backup. */}
        <div>
          <label
            htmlFor="restore-replace-target"
            className="text-ink mb-1 block text-xs font-medium"
          >
            Select the project to replace
          </label>
          <select
            id="restore-replace-target"
            data-testid="backup-restore-replace-target"
            value={targetProjectId}
            onChange={(event) => {
              onTargetChange(event.target.value);
              setAcknowledged(false);
            }}
            disabled={running}
            className="border-line bg-surface text-ink w-full rounded-md border px-2 py-1.5 text-xs"
          >
            <option value="">Choose a target project…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title} ({p.id})
              </option>
            ))}
          </select>
        </div>

        <RestoreConfirmBody
          preview={preview}
          error={error}
          acknowledged={acknowledged}
          ackText="Click “Replace project” to confirm. This cannot be undone except by restoring the automatic pre-restore snapshot."
          facts={
            <ul className="text-muted space-y-1.5 text-xs leading-relaxed">
              <li className="flex items-start gap-1.5">
                <AlertTriangle className="text-warning mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>
                  All <strong className="text-ink">19 project collections</strong> of the target
                  (world, characters, outline, drafts, notes and more) are replaced by the backup’s
                  content.
                </span>
              </li>
              <li className="flex items-start gap-1.5">
                <ShieldAlertIcon />
                <span>
                  A <strong className="text-ink">pre-restore safety snapshot</strong> of the target’s
                  current state is created first, so you can recover it.
                </span>
              </li>
              <li className="flex items-start gap-1.5">
                <ShieldAlertIcon />
                <span>
                  If the restore fails it is rolled back; the target is left unchanged. Other
                  projects are never touched.
                </span>
              </li>
              <li className="text-subtle pl-5 text-2xs">
                Provider credentials / API keys are never part of a backup and are never touched.
              </li>
            </ul>
          }
        />
      </div>
    </ProjectDialog>
  );
}

/** Shared: source summary + warning facts + error + acknowledgement banner. */
function RestoreConfirmBody({
  preview,
  error,
  acknowledged,
  ackText,
  facts,
}: {
  preview: BackupPreview;
  error: string | null;
  acknowledged: boolean;
  ackText: string;
  facts: React.ReactNode;
}) {
  return (
    <div className="space-y-4">
      <div className="border-line bg-surface-muted/40 rounded-md border px-3 py-2.5">
        <p className="text-subtle text-2xs font-medium uppercase tracking-wide">Backup source</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
          <FileJson className="text-accent size-3.5" aria-hidden />
          <span className="text-ink font-medium">{preview.projectTitle}</span>
          <span className="text-subtle">
            · {preview.totalRecords.toLocaleString()} records ·{' '}
            <span className="font-mono">{prettyBytes(preview.fileSizeBytes)}</span>
          </span>
        </div>
      </div>

      {facts}

      {error ? (
        <p
          className="text-danger flex items-start gap-1.5 text-xs"
          role="alert"
          data-testid="backup-restore-error"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      ) : null}

      {acknowledged ? (
        <p className="border-warning/40 bg-warning-soft/40 text-warning rounded-md border px-3 py-2 text-xs font-medium" role="alert">
          {ackText}
        </p>
      ) : null}
    </div>
  );
}

/** Small shield-alert glyph used in the safety-snapshot bullet. */
function ShieldAlertIcon() {
  return <span className="bg-accent/20 text-accent mt-0.5 grid size-3.5 shrink-0 place-items-center rounded-full text-[9px] font-bold" aria-hidden>!</span>;
}

function prettyBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function BackupFact({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="border-line bg-surface-muted/40 rounded-md border px-3 py-2">
      <p className="text-ink flex items-center gap-1.5 text-xs font-medium">
        <span className="text-accent" aria-hidden>
          {icon}
        </span>
        {title}
      </p>
      <p className="text-subtle mt-1 text-2xs leading-relaxed">{body}</p>
    </div>
  );
}
