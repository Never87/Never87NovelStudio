import { useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Download, FileJson, FolderOpen, Import, Info, Loader2, Upload } from 'lucide-react';
import { Badge, Button, Card, CardHeader, EmptyState, PageHeader } from '@/components/ui';
import { useProjects } from '@/hooks';
import { TransferRepositoryAdapter, TransferService } from '@/transfer';
import {
  backupPreviewService,
  MAX_BACKUP_FILE_BYTES,
  projectRestoreService,
  ProjectRestoreError,
  type BackupPreview,
} from '@/services';
import { formatRelative } from '@/utils/date';

/**
 * Import / Export Project (Round 1 — Version & Data Management, was PLACEHOLDER).
 *
 * WORKSPACE-level companion to Backup & Restore (which is per-project):
 *   - EXPORT: serialise THE WHOLE WORKSPACE (every project, all 19 project
 *     collections) into one portable `.n87novel` transfer package and download
 *     it. This reuses the exact `TransferService` code path that project backups
 *     and snapshots already trust — no new serialiser.
 *   - IMPORT: select a single-project `.n87novel` backup, VALIDATE + PREVIEW it
 *     (read-only), then import it AS A NEW PROJECT. Import does NOT re-implement
 *     a write path: it re-validates via `backupPreviewService.parseBackupEntry`
 *     and writes through `projectRestoreService.restoreAsNewProject` — the SAME
 *     atomic, id-remapping, rollback-safe restore that Backup & Restore uses.
 *     That is what keeps a single, well-tested restore implementation in the app.
 */
export function ProjectIOPage() {
  const { projects, initialLoading, refresh: refreshProjects } = useProjects();
  const transfer = useMemo(() => new TransferService(new TransferRepositoryAdapter()), []);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [lastExport, setLastExport] = useState<{ fileName: string; projectCount: number; records: number; at: number } | null>(null);
  const exportInFlight = useRef(false);

  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  // The already-read file text, kept so an import can RE-PARSE at confirm time.
  // A stale preview can therefore never authorise a write — the restore service
  // re-validates anyway.
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ projectId: string; title: string } | null>(null);
  const importInFlight = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const downloadFile = (content: string, fileName: string, mime: string) => {
    const blob = new Blob([content], { type: mime });
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
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  };

  const handleExport = async () => {
    if (exportInFlight.current || projects.length === 0) return;
    exportInFlight.current = true;
    setExporting(true);
    setExportError(null);
    setLastExport(null);
    try {
      const pkg = await transfer.exportWorkspace({ appVersion: '0.0.0' });
      const content = transfer.serialize(pkg);
      const fileName = `novel-studio-workspace-${new Date().toISOString().slice(0, 10)}.n87novel`;
      downloadFile(content, fileName, 'application/json');
      const records = pkg.projects.reduce((sum, entry) => sum + countRecords(entry), 0);
      setLastExport({ fileName, projectCount: pkg.projects.length, records, at: Date.now() });
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'The workspace export could not be created. No file was downloaded.');
    } finally {
      exportInFlight.current = false;
      setExporting(false);
    }
  };

  const handleFile = async (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    setPreview(null);
    setPreviewText(null);
    setImportError(null);
    setImportResult(null);
    setPreviewFile(file.name);
    if (file.size > MAX_BACKUP_FILE_BYTES) {
      setImportError(`This file is ${(file.size / (1024 * 1024)).toFixed(1)} MB, which exceeds the ${(MAX_BACKUP_FILE_BYTES / (1024 * 1024)).toFixed(0)} MB limit.`);
      return;
    }
    setParsing(true);
    try {
      const text = await file.text();
      const result = await backupPreviewService.previewBackupFile({ text, name: file.name }, { fileName: file.name });
      setPreview(result);
      setPreviewText(text);
    } catch (err) {
      setPreview(null);
      setImportError(err instanceof Error ? err.message : 'The selected file could not be read as a transfer package.');
    } finally {
      setParsing(false);
    }
  };

  /**
   * Imports the validated file as a NEW project.
   *
   * Re-parses the retained bytes (so a stale preview never authorises a write)
   * then hands the validated entry to the SAME `restoreAsNewProject` path the
   * Backup & Restore page uses: fresh ids, atomic insert, rollback on failure.
   */
  const handleImport = async () => {
    if (importInFlight.current || !previewText || !preview) return;
    importInFlight.current = true;
    setImporting(true);
    setImportError(null);
    setImportResult(null);
    try {
      const validated = await backupPreviewService.parseBackupEntry(
        { text: previewText, name: preview.fileName },
        { fileName: preview.fileName },
      );
      const result = await projectRestoreService.restoreAsNewProject(validated.entry);
      setImportResult({ projectId: result.projectId, title: result.project.title });
      await refreshProjects();
    } catch (err) {
      if (err instanceof ProjectRestoreError) {
        setImportError(err.message);
      } else {
        setImportError(err instanceof Error ? err.message : 'The project could not be imported. No data was changed.');
      }
    } finally {
      importInFlight.current = false;
      setImporting(false);
    }
  };

  const resetPreview = () => {
    setPreview(null);
    setPreviewText(null);
    setPreviewFile(null);
    setImportError(null);
    setImportResult(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Import className="size-4" />}
        eyebrow="Version & Data"
        title="Import / Export Project"
        description="Export your entire workspace as one portable package, or inspect a package file before restoring it."
      />

      {initialLoading ? (
        <Card padding="lg">
          <p className="text-subtle flex items-center gap-2 text-xs" role="status">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            Loading projects…
          </p>
        </Card>
      ) : (
        <>
          {/* ---------------------------- EXPORT ---------------------------- */}
          <Card padding="md" className="space-y-3">
            <CardHeader
              title="Export workspace"
              description="One .n87novel file containing every project and its content"
              icon={<Download className="size-4" />}
            />
            {projects.length === 0 ? (
              <EmptyState
                icon={<FolderOpen className="size-5" aria-hidden />}
                title="No projects to export"
                description="Create a project first; then you can export the whole workspace."
              />
            ) : (
              <>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Fact icon={<FileJson className="size-3.5" />} title="Portable JSON (.n87novel)" body="Integrity-checked, deterministic JSON across all projects." />
                  <Fact icon={<FolderOpen className="size-3.5" />} title={`${projects.length} ${projects.length === 1 ? 'project' : 'projects'}`} body="Every project, with all 19 owned collections each." />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    iconLeft={<Download className="size-3.5" />}
                    onClick={() => void handleExport()}
                    loading={exporting}
                    disabled={exporting}
                  >
                    {exporting ? 'Preparing…' : 'Download workspace'}
                  </Button>
                  <span className="text-subtle text-2xs">Saved to your device — nothing is uploaded.</span>
                </div>

                {lastExport ? (
                  <div className="border-success/40 bg-success-soft/50 text-success flex items-start gap-2 rounded-md border px-3 py-2 text-xs" role="status">
                    <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                    <span>
                      Workspace exported — <span className="font-mono">{lastExport.fileName}</span> (
                      {lastExport.projectCount} projects, {lastExport.records.toLocaleString()} records, {formatRelative(lastExport.at)}).
                    </span>
                  </div>
                ) : null}

                {exportError ? (
                  <p className="text-danger flex items-start gap-1.5 text-xs" role="alert">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                    {exportError}
                  </p>
                ) : null}
              </>
            )}
          </Card>

          {/* ---------------------------- IMPORT ---------------------------- */}
          <Card padding="md" className="space-y-3">
            <CardHeader
              title="Import a project backup"
              description="Validate a single-project .n87novel backup, preview it, then import it as a new project"
              icon={<Upload className="size-4" />}
            />
            <p className="text-subtle text-2xs leading-relaxed">
              Select a single-project <span className="font-mono">.n87novel</span> backup to validate and preview it
              (read-only), then import it as a <strong className="text-muted">new project</strong>. Import uses the same
              atomic, validated restore path as{' '}
              <a className="text-accent underline" href="/data/backup-restore">Backup &amp; Restore</a> — it is
              all-or-nothing and never overwrites an existing project. Workspace exports are for safekeeping and are not
              importable here.
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".n87novel,application/json"
              className="sr-only"
              onChange={(e) => void handleFile(e.target.files)}
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
                {parsing ? 'Inspecting…' : preview ? 'Choose another file' : 'Select package file'}
              </Button>
              {preview || importError || previewFile ? (
                <Button variant="ghost" size="sm" onClick={resetPreview} disabled={parsing}>
                  Clear
                </Button>
              ) : null}
              <span className="text-subtle text-2xs">Accepted: .n87novel · max {(MAX_BACKUP_FILE_BYTES / (1024 * 1024)).toFixed(0)} MB</span>
            </div>

            {importError ? (
              <div className="border-danger/40 bg-danger/10 text-danger flex items-start gap-2 rounded-md border px-3 py-2 text-xs" role="alert">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>

                  <strong>Import failed.</strong> {importError}
                </span>
              </div>
            ) : null}

            {importResult ? (
              <div className="border-success/40 bg-success-soft/50 text-success flex items-start gap-2 rounded-md border px-3 py-2 text-xs" role="status">
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>
                  Imported <strong>{importResult.title}</strong> as a new project.{' '}
                  <a className="underline" href={`/projects/${importResult.projectId}`}>Open it</a>.
                </span>
              </div>
            ) : null}

            {preview ? (
              <div className="border-line rounded-md border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-ink flex items-center gap-1.5 text-sm font-medium">
                    <FileJson className="text-accent size-3.5" aria-hidden />
                    <span className="break-all">{preview.fileName}</span>
                  </p>
                  <Badge tone="success" size="sm" dot>Valid package</Badge>
                </div>
                <dl className="mt-3 grid gap-2 text-2xs sm:grid-cols-2">
                  <PreviewFact label="Source project" value={preview.projectTitle} />
                  <PreviewFact label="Total records" value={`${preview.totalRecords.toLocaleString()} across ${preview.collections.length} collections`} />
                  <PreviewFact label="Format / schema" value={`format v${preview.formatVersion} · schema v${preview.schemaVersion}`} />
                  <PreviewFact label="Exported" value={preview.exportedAt > 0 ? new Date(preview.exportedAt).toLocaleString() : 'Unknown'} />
                </dl>
                <div className="mt-3 flex flex-wrap items-center gap-2 border-line border-t pt-3">
                  <Button
                    variant="primary"
                    size="sm"
                    iconLeft={<Import className="size-3.5" />}
                    onClick={() => void handleImport()}
                    loading={importing}
                    disabled={importing || !previewText || Boolean(importResult)}
                  >
                    {importing ? 'Importing…' : 'Import as new project'}
                  </Button>
                  <span className="text-subtle text-2xs leading-relaxed">
                    <Info className="mr-1 inline size-3 align-text-bottom" aria-hidden />
                    Creates a separate project with fresh ids. Nothing existing is overwritten.
                  </span>
                </div>
              </div>
            ) : null}
          </Card>
        </>
      )}
    </div>
  );
}

/** Counts the records carried by one transfer project entry across its collections. */
function countRecords(entry: { data: Record<string, unknown> }): number {
  let total = 0;
  for (const rows of Object.values(entry.data)) {
    if (Array.isArray(rows)) total += rows.length;
  }
  return total;
}

function PreviewFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-subtle uppercase tracking-wide">{label}</dt>
      <dd className="text-ink mt-0.5 break-all">{value}</dd>
    </div>
  );
}

function Fact({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="border-line bg-surface-muted/40 rounded-md border px-3 py-2">
      <p className="text-ink flex items-center gap-1.5 text-xs font-medium">
        <span className="text-accent" aria-hidden>{icon}</span>
        {title}
      </p>
      <p className="text-subtle mt-1 text-2xs leading-relaxed">{body}</p>
    </div>
  );
}
