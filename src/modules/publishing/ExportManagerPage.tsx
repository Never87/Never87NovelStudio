/**
 * Full-book Export Manager page (P9 Batch C) — `/publishing/export-manager`.
 *
 * The whole-book counterpart to the Chapter Export page:
 *
 *   project → (shared preset) → export format → download
 *
 * Every output is produced by the Batch C `exportFullBook` service, which reuses
 * the EXACT same stack as the rest of the app — `bookAssemblyService` (read-only
 * whole book) → `FormattingPipeline` (the shared IR) → the format registry writer.
 * No writer, ordering or filename logic is re-implemented in this component.
 *
 * READ-ONLY: it never writes to the DB, never snapshots and never mutates drafts;
 * it reads the project list and assembles on demand only when the user downloads.
 *
 * PDF: needs the bundled CJK font. This page checks font availability up-front and
 * shows a clear, honest status (Loading / Available / Unavailable) so the user is
 * never surprised by a failed PDF export.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Download,
  Eye,
  FileDown,
  FileText,
  Loader2,
  Package,
  ShieldCheck,
} from 'lucide-react';
import { Badge, Button, Card, EmptyState, PageHeader } from '@/components/ui';
import { useProjects, usePublishingPresets } from '@/hooks';
import {
  EXPORT_FORMATS,
  DEFAULT_EXPORT_FORMAT,
  getExportFormat,
  buildFileNameFromTemplate,
  type ExportFormat,
} from '@/modules/publishing';
import {
  exportFullBook,
  previewFullBook,
  downloadExport,
  type FullBookExportResult,
  type FullBookPreviewResult,
} from '@/services';
import { loadPdfFontBytes } from '@/modules/publishing/pdf-font';
import { PresetPicker, PresetKindBadge } from './components/PresetPicker';

/** Font availability for PDF export. */
type FontStatus = 'unknown' | 'loading' | 'available' | 'unavailable';

/** Human-readable file size. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function ExportManagerPage() {
  const { projects, initialLoading: projectsLoading, error: projectsError } = useProjects();
  const presets = usePublishingPresets();

  const [projectId, setProjectId] = useState('');
  const effectiveProjectId = projectId || projects[0]?.id || '';
  const activeProject = useMemo(
    () => projects.find((p) => p.id === effectiveProjectId) ?? null,
    [projects, effectiveProjectId],
  );

  const [format, setFormat] = useState<ExportFormat>(DEFAULT_EXPORT_FORMAT);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<FullBookExportResult | null>(null);
  const busyRef = useRef(false);

  // PDF font availability (checked lazily — only once the user selects PDF).
  const [fontStatus, setFontStatus] = useState<FontStatus>('unknown');
  const [fontError, setFontError] = useState<string | null>(null);

  const selectedFormat = getExportFormat(format);

  // Clear any stale status message when the project/format changes.
  useEffect(() => {
    setMessage(null);
    setError(null);
  }, [effectiveProjectId, format]);

  // Probe the font the first time PDF is selected (once). A ref guards against
  // re-entry so the resolving promise is never orphaned by an effect re-run that
  // also depends on `fontStatus` — that self-cancel bug would leave the status
  // stuck on "Preparing" forever.
  const fontProbeStarted = useRef(false);
  useEffect(() => {
    if (format !== 'pdf') return;
    if (fontProbeStarted.current) return;
    fontProbeStarted.current = true;
    let cancelled = false;
    setFontStatus('loading');
    setFontError(null);
    void (async () => {
      try {
        await loadPdfFontBytes();
        if (!cancelled) setFontStatus('available');
      } catch (err) {
        if (cancelled) return;
        setFontStatus('unavailable');
        setFontError(err instanceof Error ? err.message : 'The bundled Chinese font could not be loaded.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [format]);

  /* ---- Content preview (P9 Batch C acceptance) ------------------------- */
  // The preview is built from the SAME IR the download uses (`previewFullBook`
  // runs assembleBook → pipeline.render, then the existing HTML writer). It is
  // fetched whenever the project or the active preset changes. A request counter
  // discards stale responses so a slow earlier fetch can never overwrite a newer
  // one (and never shows one project's text under another project's title).
  const [preview, setPreview] = useState<FullBookPreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewRequestId = useRef(0);

  useEffect(() => {
    if (!effectiveProjectId) {
      setPreview(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }
    const requestId = ++previewRequestId.current;
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    void (async () => {
      try {
        const result = await previewFullBook(effectiveProjectId, { preset: presets.active });
        if (cancelled || requestId !== previewRequestId.current) return;
        setPreview(result);
      } catch (err) {
        if (cancelled || requestId !== previewRequestId.current) return;
        setPreview(null);
        setPreviewError(
          err instanceof Error ? err.message : 'The preview could not be produced.',
        );
      } finally {
        if (!cancelled && requestId === previewRequestId.current) setPreviewLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [effectiveProjectId, presets.active]);

  /** The file name that WILL be produced (preview only — the service is authoritative). */
  const predictedFileName = useMemo(() => {
    const title = activeProject?.title ?? '';
    const author = activeProject?.settings.author ?? '';
    return buildFileNameFromTemplate(
      presets.active.fileNameTemplate,
      { title, author },
      selectedFormat.extension,
    );
  }, [activeProject, presets.active.fileNameTemplate, selectedFormat.extension]);

  const canExport = Boolean(effectiveProjectId) && !busy && !(format === 'pdf' && fontStatus === 'unavailable');

  const handleDownload = useCallback(async () => {
    if (busyRef.current || !effectiveProjectId) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setMessage(null);
    setLastResult(null);
    try {
      const result = await exportFullBook(effectiveProjectId, {
        preset: presets.active,
        format,
      });
      downloadExport(result);
      setLastResult(result);
      setMessage(`Exported “${result.fileName}” (${formatBytes(result.bytes.byteLength)}).`);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'The file could not be produced. Nothing was downloaded.',
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [effectiveProjectId, presets.active, format]);

  /* -------------------------------- render ------------------------------ */

  if (projectsLoading) {
    return (
      <div className="space-y-5">
        <PageHeader
          title="Export Manager"
          description="Export your whole manuscript to TXT, Markdown, HTML, Word (DOCX), EPUB or PDF — with your Chinese font embedded correctly."
          icon={<Package className="size-4" aria-hidden />}
        />
        <Card padding="lg">
          <p className="text-subtle flex items-center gap-2 text-xs" role="status">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            Loading projects…
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Export Manager"
        description="Export your whole manuscript to TXT, Markdown, HTML, Word (DOCX), EPUB or PDF — with your Chinese font embedded correctly. Everything is generated locally; nothing is uploaded."
        icon={<Package className="size-4" aria-hidden />}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <PresetPicker
              presets={presets.presets}
              value={presets.activeId}
              onChange={(id) => presets.selectPreset(id)}
              isBuiltin={presets.isBuiltin}
              id="export-manager-preset-picker"
            />
            <PresetKindBadge builtin={presets.isBuiltin(presets.activeId)} />
          </div>
        }
      />

      {projectsError ? (
        <Card padding="md">
          <p className="text-danger flex items-center gap-1.5 text-xs" role="alert">
            <AlertTriangle className="size-3.5" aria-hidden />
            The project list could not be loaded. {projectsError instanceof Error ? projectsError.message : ''}
          </p>
        </Card>
      ) : projects.length === 0 ? (
        <EmptyState
          icon={<Package className="size-5" aria-hidden />}
          title="No projects to export"
          description="Create a project and write at least one chapter, then return here to export the whole book."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          {/* Configuration column */}
          <Card padding="md" className="space-y-4" data-testid="export-config-panel">
            <div className="flex flex-col gap-1">
              <label htmlFor="export-manager-project" className="text-subtle text-2xs font-medium uppercase tracking-wide">
                Project
              </label>
              <select
                id="export-manager-project"
                data-testid="export-manager-project"
                value={effectiveProjectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="border-line bg-surface text-ink rounded-md border px-2 py-1.5 text-xs"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
              {activeProject ? (
                <p className="text-subtle text-2xs">
                  By <strong className="text-muted">{activeProject.settings.author || 'unknown author'}</strong>
                  {' · '}
                  {activeProject.settings.language || 'unspecified language'}
                </p>
              ) : null}
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="export-manager-format" className="text-subtle text-2xs font-medium uppercase tracking-wide">
                Format
              </label>
              <select
                id="export-manager-format"
                data-testid="export-manager-format"
                value={format}
                onChange={(e) => setFormat(e.target.value as ExportFormat)}
                disabled={busy}
                className="border-line bg-surface text-ink rounded-md border px-2 py-1.5 text-xs disabled:opacity-60"
              >
                {EXPORT_FORMATS.map((f) => (
                  <option key={f.format} value={f.format}>
                    {f.label}
                  </option>
                ))}
              </select>
              <p className="text-subtle text-2xs leading-relaxed">{selectedFormat.description}</p>
            </div>

            {/* PDF font status — only meaningful for PDF. */}
            {format === 'pdf' ? (
              <div data-testid="pdf-font-status">
                {fontStatus === 'loading' || fontStatus === 'unknown' ? (
                  <p className="text-subtle flex items-center gap-1.5 text-2xs" role="status">
                    <Loader2 className="size-3 animate-spin" aria-hidden />
                    Preparing the bundled Chinese font…
                  </p>
                ) : fontStatus === 'available' ? (
                  <p className="text-success flex items-center gap-1.5 text-2xs" role="status">
                    <ShieldCheck className="size-3 shrink-0" aria-hidden />
                    Chinese font ready — the PDF will render Chinese text (no tofu).
                  </p>
                ) : (
                  <p className="text-danger flex items-center gap-1.5 text-2xs" role="alert">
                    <AlertTriangle className="size-3 shrink-0" aria-hidden />
                    PDF font unavailable{fontError ? `: ${fontError}` : '.'} Other formats still work.
                  </p>
                )}
              </div>
            ) : null}

            <div className="border-line space-y-2 border-t pt-3">
              <p className="text-subtle text-2xs">
                File name:{' '}
                <strong className="text-muted" data-testid="predicted-file-name">
                  {predictedFileName}
                </strong>
              </p>
              <Button
                variant="primary"
                size="sm"
                iconLeft={<Download className="size-3.5" />}
                onClick={() => void handleDownload()}
                loading={busy}
                disabled={!canExport}
                data-testid="export-manager-download"
              >
                Export “{activeProject?.title ?? 'book'}”
              </Button>
            </div>

            {message ? (
              <p className="text-success flex items-center gap-1.5 text-2xs" role="status" data-testid="export-manager-message">
                <Check className="size-3.5 shrink-0" aria-hidden />
                {message}
              </p>
            ) : null}
            {error ? (
              <p className="text-danger flex items-center gap-1.5 text-2xs" role="alert" data-testid="export-manager-error">
                <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
                {error}
              </p>
            ) : null}
          </Card>

          {/* Format overview column */}
          <Card padding="md" className="space-y-3" data-testid="export-format-panel">
            <div>
              <p className="text-ink text-sm font-medium">All export formats</p>
              <p className="text-subtle text-2xs">
                The whole book is reformatted by the active preset, then written in the format you pick.
              </p>
            </div>
            <ul className="space-y-1.5">
              {EXPORT_FORMATS.map((f) => {
                const active = f.format === format;
                return (
                  <li key={f.format}>
                    <button
                      type="button"
                      onClick={() => setFormat(f.format)}
                      data-testid="export-format-card"
                      data-format={f.format}
                      aria-pressed={active}
                      className={`w-full rounded-md border px-2.5 py-2 text-left text-xs transition-colors ${
                        active
                          ? 'border-accent bg-surface-muted/60'
                          : 'border-line hover:bg-surface-muted/40'
                      }`}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-ink font-medium">{f.label}</span>
                        <span className="flex items-center gap-1">
                          {f.requiresFont ? (
                            <Badge tone="neutral" size="sm">
                              CJK font
                            </Badge>
                          ) : null}
                          <Badge tone={active ? 'accent' : 'neutral'} size="sm">
                            .{f.extension}
                          </Badge>
                        </span>
                      </span>
                      <span className="text-subtle mt-0.5 block text-2xs leading-relaxed">{f.description}</span>
                    </button>
                  </li>
                );
              })}
            </ul>

            {lastResult ? (
              <div className="border-line border-t pt-2.5" data-testid="export-result-summary">
                <p className="text-subtle flex items-center gap-1.5 text-2xs">
                  <FileDown className="size-3 shrink-0" aria-hidden />
                  Last export: <strong className="text-muted">{lastResult.fileName}</strong> ·{' '}
                  {formatBytes(lastResult.bytes.byteLength)} · {lastResult.mimeType}
                </p>
              </div>
            ) : null}
          </Card>
        </div>
      )}

      {/* Content preview — the REAL formatted document, from the shared IR. */}
      {projects.length > 0 && effectiveProjectId ? (
        <Card padding="md" className="space-y-3" data-testid="export-preview-panel">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-ink flex items-center gap-1.5 text-sm font-medium">
                <Eye className="size-3.5 text-accent" aria-hidden />
                Content preview
              </p>
              <p className="text-subtle mt-0.5 text-2xs leading-relaxed">
                Exactly what will be exported — the same formatted document
                ({(preview?.stats.chapters ?? 0)} chapter
                {preview?.stats.chapters === 1 ? '' : 's'}, active preset applied), not a mock-up.
              </p>
            </div>
            {preview ? (
              <div className="flex flex-wrap items-center gap-1.5" data-testid="export-preview-stats">
                <Badge tone="neutral" size="sm">{preview.stats.volumes} volume{preview.stats.volumes === 1 ? '' : 's'}</Badge>
                <Badge tone="neutral" size="sm">{preview.stats.chapters} chapter{preview.stats.chapters === 1 ? '' : 's'}</Badge>
                <Badge tone="neutral" size="sm">{preview.stats.words.toLocaleString()} words</Badge>
              </div>
            ) : null}
          </div>

          {previewLoading ? (
            <div className="border-line flex items-center gap-2 rounded-md border px-3 py-8 text-xs" role="status">
              <Loader2 className="text-subtle size-3.5 animate-spin" aria-hidden />
              <span className="text-subtle">Assembling the preview from your saved drafts…</span>
            </div>
          ) : previewError ? (
            <p className="text-danger flex items-center gap-1.5 text-2xs" role="alert" data-testid="export-preview-error">
              <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
              {previewError}
            </p>
          ) : preview ? (
            preview.stats.chapters === 0 ? (
              <div className="border-line flex items-center gap-2 rounded-md border px-3 py-6 text-xs" role="status">
                <FileText className="text-subtle size-3.5 shrink-0" aria-hidden />
                <span className="text-subtle">
                  This project has no chapters yet — the export would be empty. Add a chapter and its
                  content will appear here.
                </span>
              </div>
            ) : (
              // The preview HTML is produced by the Batch A HTML writer, which
              // escapes ALL manuscript text (no raw HTML survives). It is shown in
              // a sandboxed iframe so its <style> is scoped and it can never run
              // script or reach the parent document — no dangerouslySetInnerHTML.
              <iframe
                title="Export content preview"
                data-testid="export-preview-frame"
                sandbox=""
                className="border-line bg-white h-[28rem] w-full rounded-md border"
                srcDoc={preview.html}
              />
            )
          ) : null}

          <p className="text-subtle border-line flex items-start gap-1.5 border-t pt-2.5 text-2xs leading-relaxed">
            <ShieldCheck className="mt-0.5 size-3 shrink-0" aria-hidden />
            <span>
              The preview and the download are formatted by the <strong className="text-muted">same
              pipeline</strong> from the same intermediate document, so chapter order and preset
              formatting are identical.
            </span>
          </p>
        </Card>
      ) : null}

      {/* Footer: guarantees */}
      <Card padding="md" className="space-y-1.5">
        <p className="text-subtle flex items-start gap-1.5 text-2xs leading-relaxed">
          <ShieldCheck className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span>
            Exports are <strong className="text-muted">read-only</strong>: your manuscript is assembled
            from saved drafts and rendered entirely in this browser. Nothing is uploaded and no data is
            changed.
          </span>
        </p>
        <p className="text-subtle flex items-start gap-1.5 text-2xs leading-relaxed">
          <FileDown className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span>
            Every format derives from the same formatted document, so the chapter order and the active
            preset are identical across TXT, Markdown, HTML, DOCX, EPUB and PDF.
          </span>
        </p>
      </Card>
    </div>
  );
}
