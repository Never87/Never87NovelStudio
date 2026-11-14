import { useCallback, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  DatabaseBackup,
  Download,
  FileJson,
  FolderOpen,
  Info,
  Loader2,
} from 'lucide-react';
import { Badge, Button, Card, EmptyState, PageHeader } from '@/components/ui';
import { ProjectPicker } from '@/modules/ai/components/ProjectPicker';
import { useProjects } from '@/hooks';
import { backupService } from '@/services';
import { formatRelative } from '@/utils/date';

/**
 * Backup & Restore — Project backup EXPORT (P9 Batch 4-1).
 *
 * This page turns the `backup` navigation item into a real surface for
 * downloading a COMPLETE single-project backup file. It is a thin UI over
 * `backupService.exportProjectFile`, which itself reuses the P9 B1 transfer
 * foundation (serialise / validate / integrity / 19-collection selection).
 *
 * Scope for this batch is deliberately narrow:
 *   - SUPPORTED:  download a full single-project JSON backup (`.n87novel`).
 *   - NOT YET:    file upload / parse / preview / restore (later batches).
 *   - NOT YET:    workspace (all-projects) backup (deferred — see B4 decision).
 *
 * Distinction the page makes explicit: PROJECT SNAPSHOTS are in-browser
 * snapshots (`/data/snapshots`); this page produces a BACKUP FILE downloaded to
 * the user's device. They are different safety mechanisms.
 */
const DOWNLOAD_REVOKE_DELAY_MS = 0; // revoke immediately after the click is queued

interface LastExport {
  readonly fileName: string;
  readonly projectTitle: string;
  readonly totalRecords: number;
  readonly exportedAt: number;
}

export function BackupRestorePage() {
  const { projects, initialLoading } = useProjects();
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
                <strong className="text-muted">Currently supported:</strong> complete single-project
                JSON backup download. File restore (upload &amp; import) will be available in a
                later batch.
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
    </div>
  );
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
