/**
 * Chapter Export page (P9 Batch B) — `/publishing/chapter-export`.
 *
 * A functional chapter-export workflow over the Batch A foundation:
 *
 *   project → volume → chapters → (shared preset) → preview → download/copy
 *
 * Every output path (preview, TXT/Markdown/HTML download, clipboard) derives from
 * the SAME `RenderedDocument` produced by the unchanged `FormattingPipeline`, and
 * every serialisation comes from the corresponding Batch A writer. No writer or
 * filename logic is re-implemented in this component.
 *
 * This page is READ-ONLY with respect to novel data: it never writes to the DB,
 * never creates versions/snapshots, and never mutates drafts. It only reads via
 * the existing hooks/services and assembles via `bookAssemblyService`.
 *
 * Selection rules (pure helpers in `chapter-selection.ts`):
 *   - Changing project or volume CLEARS stale selection.
 *   - Combined output is in CANONICAL order (not click order).
 *   - "Select all" selects the current volume's chapters.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ClipboardCopy,
  Download,
  FileDown,
  Files,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { Badge, Button, Card, EmptyState, PageHeader } from '@/components/ui';
import { useOutline, useProject, useProjects, usePublishingPresets } from '@/hooks';
import {
  FormattingPipeline,
  normalizeSelection,
  pruneToAllowed,
  summarizeSelection,
  toSelectableChapters,
  toggleSelection,
  selectAllInVolume,
  clearSelection,
  buildFileNameFromTemplate,
  renderTxt,
  type RenderedDocument,
} from '@/modules/publishing';
import { PresetPicker, PresetKindBadge } from './components/PresetPicker';
import { EXPORT_FORMATS, getExportFormat, type ExportFormat } from './components/export-formats';
import { assembleSelectedChapters, projectMetadataFrom } from './components/assemble-selection';

/** Preview text is capped so a very long selection cannot freeze the page. */
const PREVIEW_CHAR_CAP = 20_000;

interface PreviewState {
  readonly doc: RenderedDocument | null;
  readonly status: 'idle' | 'rendering' | 'ready' | 'error';
  readonly error: string | null;
  /** Full serialised preview text (capped for display separately). */
  readonly text: string;
}

const INITIAL_PREVIEW: PreviewState = { doc: null, status: 'idle', error: null, text: '' };

export function ChapterExportPage() {
  const { projects, initialLoading: projectsLoading } = useProjects();
  const presets = usePublishingPresets();

  const [projectId, setProjectId] = useState('');
  const effectiveProjectId = projectId || projects[0]?.id || '';

  const { project } = useProject(effectiveProjectId || undefined);
  const outlineState = useOutline(effectiveProjectId || undefined);

  const [volumeId, setVolumeId] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [preview, setPreview] = useState<PreviewState>(INITIAL_PREVIEW);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('txt');
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Prevent duplicate submissions per action.
  const exportingRef = useRef(false);
  const copyingRef = useRef(false);
  const [busy, setBusy] = useState<'export' | 'copy' | null>(null);

  const outline = outlineState.outline;
  const rows = useMemo(
    () => toSelectableChapters(outline, outlineState.sceneCounts),
    [outline, outlineState.sceneCounts],
  );

  // Keep `volumeId` valid for the current project's outline.
  useEffect(() => {
    if (outline.length === 0) {
      if (volumeId !== '') setVolumeId('');
      return;
    }
    const stillExists = outline.some((v) => v.volume.id === volumeId);
    if (!stillExists) setVolumeId(outline[0].volume.id);
  }, [outline, volumeId]);

  // The chapter ids belonging to the currently selected volume (canonical order).
  const currentVolumeRows = useMemo(
    () => rows.filter((r) => r.volumeId === volumeId),
    [rows, volumeId],
  );
  const currentVolumeIds = useMemo(
    () => currentVolumeRows.map((r) => r.id),
    [currentVolumeRows],
  );

  /**
   * Clear stale selection whenever the project or volume changes. Selecting a
   * different project/volume must never carry a prior selection across.
   */
  useEffect(() => {
    setSelected(new Set());
    setPreview(INITIAL_PREVIEW);
  }, [effectiveProjectId, volumeId]);

  // Also prune if the outline changes such that selected ids no longer exist.
  useEffect(() => {
    setSelected((prev) => {
      const pruned = pruneToAllowed(prev, currentVolumeIds);
      if (pruned.size === prev.size && [...prev].every((id) => pruned.has(id))) return prev;
      return pruned;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentVolumeIds.join('|')]);

  const summary = summarizeSelection(selected, currentVolumeIds);
  const hasSelection = summary.count > 0;

  /* ------------------------- preview generation ------------------------- */

  /**
   * Builds the RenderedDocument for the current selection ONCE and stores it.
   * Both preview and export reuse this exact document when it is current.
   */
  const buildDocument = useCallback(async (): Promise<RenderedDocument> => {
    if (!effectiveProjectId || !project || currentVolumeIds.length === 0) {
      throw new Error('Select a project, volume and at least one chapter.');
    }
    const canonicalIds = normalizeSelection(currentVolumeIds, selected);
    if (canonicalIds.length === 0) {
      throw new Error('Select at least one chapter to export.');
    }
    const model = await assembleSelectedChapters(
      effectiveProjectId,
      canonicalIds,
      { id: volumeId, title: currentVolumeRows[0]?.volumeTitle ?? '' },
      projectMetadataFrom(project),
    );
    return new FormattingPipeline().render(model, presets.active);
  }, [
    effectiveProjectId,
    project,
    currentVolumeIds,
    selected,
    volumeId,
    currentVolumeRows,
    presets.active,
  ]);

  // Re-render the preview whenever the selection, project/volume or preset change.
  useEffect(() => {
    if (!hasSelection) {
      setPreview(INITIAL_PREVIEW);
      return;
    }
    let cancelled = false;
    setPreview((prev) => ({ ...prev, status: 'rendering', error: null }));
    void (async () => {
      try {
        const doc = await buildDocument();
        if (cancelled) return;
        // Preview uses the TXT writer as a representative plain rendering; the
        // document is the same IR every download/copy uses.
        const text = renderTxt(doc);
        setPreview({ doc, status: 'ready', error: null, text });
      } catch (err) {
        if (cancelled) return;
        setPreview({
          doc: null,
          status: 'error',
          error: err instanceof Error ? err.message : 'The preview could not be generated.',
          text: '',
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hasSelection, buildDocument]);

  /* ----------------------------- interactions --------------------------- */

  const handleSelectChange = useCallback((id: string) => {
    setSelected((prev) => toggleSelection(prev, id));
    setActionMessage(null);
    setActionError(null);
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelected(selectAllInVolume(currentVolumeIds));
    setActionMessage(null);
    setActionError(null);
  }, [currentVolumeIds]);

  const handleClear = useCallback(() => {
    setSelected(clearSelection());
    setActionMessage(null);
    setActionError(null);
  }, []);

  /** Serialises the current document for a format via the Batch A writer. */
  const serialize = useCallback(
    async (format: ExportFormat): Promise<{ content: string; fileName: string; mimeType: string }> => {
      // Always rebuild from current state so the export matches what is selected
      // NOW (never a stale preview after a rapid change).
      const doc = await buildDocument();
      const descriptor = getExportFormat(format);
      const content = descriptor.render(doc);
      const fileName = buildFileNameFromTemplate(
        presets.active.fileNameTemplate,
        { title: doc.metadata.title, author: doc.metadata.author },
        descriptor.extension,
      );
      return { content, fileName, mimeType: descriptor.mimeType };
    },
    [buildDocument, presets.active.fileNameTemplate],
  );

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
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }, []);

  const handleDownload = useCallback(
    async (format: ExportFormat) => {
      if (exportingRef.current || !hasSelection) return;
      exportingRef.current = true;
      setBusy('export');
      setActionError(null);
      setActionMessage(null);
      try {
        const { content, fileName, mimeType } = await serialize(format);
        downloadFile(content, fileName, mimeType);
        const label = getExportFormat(format).label;
        setActionMessage(`Downloaded ${label} as ${fileName}.`);
      } catch (err) {
        setActionError(
          err instanceof Error ? err.message : 'The file could not be produced. Nothing was downloaded.',
        );
      } finally {
        exportingRef.current = false;
        setBusy(null);
      }
    },
    [hasSelection, serialize, downloadFile],
  );

  const handleCopy = useCallback(async () => {
    if (copyingRef.current || !hasSelection) return;
    copyingRef.current = true;
    setBusy('copy');
    setActionError(null);
    setActionMessage(null);
    try {
      // Clipboard is plain text: use the TXT writer for a clean, pasteable body.
      const { content } = await serialize('txt');
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard is not available in this browser.');
      }
      await navigator.clipboard.writeText(content);
      setActionMessage(
        summary.count === 1
          ? 'Copied the chapter to the clipboard.'
          : `Copied ${summary.count} chapters (in order) to the clipboard.`,
      );
    } catch (err) {
      setActionError(
        err instanceof Error
          ? `Could not copy to the clipboard: ${err.message}`
          : 'Could not copy to the clipboard (permission may be denied).',
      );
    } finally {
      copyingRef.current = false;
      setBusy(null);
    }
  }, [hasSelection, serialize, summary.count]);

  /* -------------------------------- render ------------------------------ */

  const previewText = preview.text.length > PREVIEW_CHAR_CAP
    ? `${preview.text.slice(0, PREVIEW_CHAR_CAP)}`
    : preview.text;
  const previewTruncated = preview.text.length > PREVIEW_CHAR_CAP;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Chapter Export"
        description="Select chapters, preview them with the shared preset, and export as TXT, Markdown or HTML — or copy to the clipboard. Everything is generated locally; nothing is uploaded."
        icon={<Files className="size-4" aria-hidden />}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <PresetPicker
              presets={presets.presets}
              value={presets.activeId}
              onChange={(id) => presets.selectPreset(id)}
              isBuiltin={presets.isBuiltin}
              id="export-preset-picker"
            />
            <PresetKindBadge builtin={presets.isBuiltin(presets.activeId)} />
          </div>
        }
      />

      {projectsLoading ? (
        <Card padding="lg">
          <p className="text-subtle flex items-center gap-2 text-xs" role="status">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            Loading projects…
          </p>
        </Card>
      ) : projects.length === 0 ? (
        <EmptyState
          icon={<Files className="size-5" aria-hidden />}
          title="No projects to export"
          description="Create a project and write at least one chapter, then return here to export."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          {/* Selection column */}
          <Card padding="md" className="space-y-3" data-testid="export-selection-panel">
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <label htmlFor="export-project" className="text-subtle text-2xs font-medium uppercase tracking-wide">
                  Project
                </label>
                <select
                  id="export-project"
                  data-testid="export-project-select"
                  value={effectiveProjectId}
                  onChange={(e) => {
                    setProjectId(e.target.value);
                    setVolumeId('');
                    setActionMessage(null);
                    setActionError(null);
                  }}
                  className="border-line bg-surface text-ink rounded-md border px-2 py-1.5 text-xs"
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="export-volume" className="text-subtle text-2xs font-medium uppercase tracking-wide">
                  Volume
                </label>
                <select
                  id="export-volume"
                  data-testid="export-volume-select"
                  value={volumeId}
                  onChange={(e) => {
                    setVolumeId(e.target.value);
                    setActionMessage(null);
                    setActionError(null);
                  }}
                  disabled={outline.length === 0}
                  className="border-line bg-surface text-ink rounded-md border px-2 py-1.5 text-xs disabled:opacity-60"
                >
                  {outline.length === 0 ? <option value="">No volumes</option> : null}
                  {outline.map(({ volume }) => (
                    <option key={volume.id} value={volume.id}>
                      {volume.title}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Toolbar: select all / clear + selection count */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleSelectAll}
                  disabled={currentVolumeIds.length === 0 || summary.allSelected}
                  data-testid="select-all"
                >
                  Select all
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleClear}
                  disabled={summary.noneSelected}
                  data-testid="clear-selection"
                >
                  Clear
                </Button>
              </div>
              <span data-testid="selection-count">
                <Badge tone={hasSelection ? 'accent' : 'neutral'} size="sm">
                  {summary.count} selected
                </Badge>
              </span>
            </div>

            {/* Chapter list */}
            {outlineState.status === 'loading' ? (
              <p className="text-subtle flex items-center gap-2 text-xs" role="status">
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                Loading chapters…
              </p>
            ) : outlineState.status === 'error' ? (
              <p className="text-danger flex items-center gap-2 text-xs" role="alert">
                <AlertTriangle className="size-3.5" aria-hidden />
                The outline could not be loaded.
              </p>
            ) : currentVolumeRows.length === 0 ? (
              <p className="text-subtle text-xs" data-testid="no-chapters">
                This volume has no chapters. Add chapters in the Outline first.
              </p>
            ) : (
              <ul className="max-h-80 space-y-1 overflow-y-auto pr-1" data-testid="chapter-list">
                {currentVolumeRows.map((chapter, index) => {
                  const checked = selected.has(chapter.id);
                  return (
                    <li key={chapter.id}>
                      <label
                        className="hover:bg-surface-muted/60 flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5"
                        data-testid="chapter-row"
                        data-chapter-id={chapter.id}
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={checked}
                          onChange={() => handleSelectChange(chapter.id)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="text-ink block truncate text-xs font-medium">
                            {index + 1}. {chapter.title}
                          </span>
                          <span className="text-subtle text-2xs">
                            {chapter.sceneCount} scene{chapter.sceneCount === 1 ? '' : 's'}
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {/* Preview column */}
          <Card padding="md" className="space-y-3" data-testid="export-preview-panel">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-ink text-sm font-medium">Preview</p>
                <p className="text-subtle text-2xs">
                  Preset: <strong className="text-muted">{presets.active.label}</strong>
                  {volumeId ? ` · ${currentVolumeRows[0]?.volumeTitle ?? ''}` : ''}
                  {' · '}
                  {summary.count} chapter{summary.count === 1 ? '' : 's'}
                </p>
              </div>
              {preview.status === 'rendering' ? (
                <span className="text-subtle flex items-center gap-1.5 text-2xs" role="status">
                  <Loader2 className="size-3 animate-spin" aria-hidden />
                  Rendering…
                </span>
              ) : null}
            </div>

            {!hasSelection ? (
              <p className="text-subtle py-8 text-center text-xs" data-testid="preview-empty">
                Select one or more chapters to see a formatted preview.
              </p>
            ) : preview.status === 'error' ? (
              <p className="text-danger flex items-center gap-1.5 text-xs" role="alert">
                <AlertTriangle className="size-3.5" aria-hidden />
                {preview.error}
              </p>
            ) : preview.status === 'rendering' && !preview.text ? (
              <p className="text-subtle py-8 text-center text-xs">Building preview…</p>
            ) : (
              <div className="space-y-2">
                <pre
                  className="bg-surface-muted/60 max-h-[22rem] overflow-auto whitespace-pre-wrap break-words rounded-md p-3 text-2xs leading-relaxed"
                  data-testid="preview-text"
                >
                  {previewText || '(empty content)'}
                </pre>
                {previewTruncated ? (
                  <p className="text-subtle text-2xs">
                    Preview truncated for display. The downloaded file contains the full content.
                  </p>
                ) : null}
              </div>
            )}

            {/* Actions */}
            <div className="border-line flex flex-wrap items-center gap-1.5 border-t pt-3">
              <label htmlFor="export-format" className="sr-only">
                Download format
              </label>
              <select
                id="export-format"
                data-testid="export-format"
                value={exportFormat}
                onChange={(e) => setExportFormat(e.target.value as ExportFormat)}
                disabled={!hasSelection || busy !== null}
                className="border-line bg-surface text-ink rounded-md border px-2 py-1.5 text-xs disabled:opacity-60"
              >
                {EXPORT_FORMATS.map((f) => (
                  <option key={f.format} value={f.format}>
                    {f.label}
                  </option>
                ))}
              </select>
              <Button
                variant="primary"
                size="sm"
                iconLeft={<Download className="size-3.5" />}
                onClick={() => void handleDownload(exportFormat)}
                loading={busy === 'export'}
                disabled={!hasSelection || busy !== null}
                data-testid="download-button"
              >
                Download
              </Button>
              <Button
                variant="secondary"
                size="sm"
                iconLeft={<ClipboardCopy className="size-3.5" />}
                onClick={() => void handleCopy()}
                loading={busy === 'copy'}
                disabled={!hasSelection || busy !== null}
                data-testid="copy-button"
              >
                Copy
              </Button>
            </div>

            {actionMessage ? (
              <p className="text-success flex items-center gap-1.5 text-2xs" role="status" data-testid="export-message">
                <Check className="size-3.5 shrink-0" aria-hidden />
                {actionMessage}
              </p>
            ) : null}
            {actionError ? (
              <p className="text-danger flex items-center gap-1.5 text-2xs" role="alert" data-testid="export-error">
                <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
                {actionError}
              </p>
            ) : null}
          </Card>
        </div>
      )}

      {/* Footer: what this page does / does not do */}
      <Card padding="md" className="space-y-1.5">
        <p className="text-subtle flex items-start gap-1.5 text-2xs leading-relaxed">
          <FileDown className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span>
            Exports use the <strong className="text-muted">shared active preset</strong> and the same
            pipeline as the whole-book export. Changing the preset here updates the preview and every
            download. Selecting a different project or volume clears the current selection.
          </span>
        </p>
        <p className="text-subtle flex items-start gap-1.5 text-2xs leading-relaxed">
          <RefreshCw className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span>
            Nothing is uploaded and no novel data is changed — chapters are read from your saved
            drafts and rendered entirely in this browser.
          </span>
        </p>
      </Card>
    </div>
  );
}
