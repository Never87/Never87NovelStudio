/**
 * Book Covers page (P9 Batch D) — `/publishing/book-covers`.
 *
 * Lets the user pick a project, view its current cover, upload a new cover
 * image (validated), set an external cover, or remove the cover. All persistence
 * goes through the shared `useCover` hook → `coverService` → repositories; this
 * component never touches the DB or re-implements the validation rules.
 *
 * Guarantees surfaced to the user:
 *   - The image is CHECKED BEFORE it is stored: real format (PNG/JPEG/WebP),
 *     byte-size limit and pixel-dimension limits. A rejected image stores
 *     nothing and shows the specific reason.
 *   - A non-blocking aspect-ratio WARNING is shown when the image is off the
 *     recommended 2:3 book-cover ratio, but the user can still upload.
 *   - The stored bytes are embedded into EPUB/PDF exports that support a cover.
 *   - Everything is local (IndexedDB); nothing is uploaded anywhere.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Image as ImageIcon,
  Info,
  Link2,
  Loader2,
  Trash2,
  Upload,
} from 'lucide-react';
import { Badge, Button, Card, EmptyState, PageHeader } from '@/components/ui';
import { useCover, useProjects } from '@/hooks';
import { formatRelative } from '@/utils/date';
import {
  MAX_COVER_BYTES,
  MAX_COVER_DIMENSION,
  MIN_COVER_DIMENSION,
} from '@/schemas/cover-asset';
import {
  precheckImageFile,
  classifyAspect,
  type AspectSeverity,
} from '@/modules/publishing/covers/image-validation';
import { cn } from '@/utils/cn';

/** Recommended book-cover aspect ratio (width / height), e.g. 1200×1800. */
const RECOMMENDED_COVER_ASPECT = 2 / 3;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function severityTone(severity: AspectSeverity): 'success' | 'warning' | 'danger' {
  if (severity === 'ok') return 'success';
  if (severity === 'warning') return 'warning';
  return 'danger';
}

export function BookCoversPage() {
  const { projects, initialLoading: projectsLoading, error: projectsError } = useProjects();

  const [projectId, setProjectId] = useState('');
  const effectiveProjectId = projectId || projects[0]?.id || '';
  const activeProject = useMemo(
    () => projects.find((p) => p.id === effectiveProjectId) ?? null,
    [projects, effectiveProjectId],
  );

  const cover = useCover(effectiveProjectId || null);

  const [externalUrl, setExternalUrl] = useState('');
  const [showExternal, setShowExternal] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const busyRef = useRef(false);

  // Clear transient messages when the project changes.
  useEffect(() => {
    setMessage(null);
    setActionError(null);
    setWarnings([]);
  }, [effectiveProjectId]);

  /* ----------------------------- upload -------------------------------- */

  const handleFile = useCallback(
    async (file: File) => {
      if (busyRef.current) return;
      // Cheap decode-free checks FIRST so a huge/empty file is rejected before
      // we read it into memory.
      const pre = precheckImageFile(file);
      if (!pre.ok) {
        setActionError(pre.message);
        setMessage(null);
        setWarnings([]);
        return;
      }
      busyRef.current = true;
      setActionError(null);
      setMessage(null);
      setWarnings([]);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        await cover.uploadCover(bytes, {
          targetAspectRatio: RECOMMENDED_COVER_ASPECT,
          fileName: file.name,
        });
        setMessage(`Cover uploaded — “${file.name}”.`);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'The cover could not be uploaded.');
      } finally {
        busyRef.current = false;
      }
    },
    [cover],
  );

  const onFileInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Reset so selecting the same file again still fires onChange.
      event.target.value = '';
      if (file) void handleFile(file);
    },
    [handleFile],
  );

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragActive(false);
      const file = event.dataTransfer.files?.[0];
      if (file) void handleFile(file);
    },
    [handleFile],
  );

  const handleRemove = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setActionError(null);
    setMessage(null);
    setWarnings([]);
    try {
      await cover.removeCover();
      setMessage('Cover removed.');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'The cover could not be removed.');
    } finally {
      busyRef.current = false;
    }
  }, [cover]);

  const handleExternal = useCallback(async () => {
    if (busyRef.current) return;
    const value = externalUrl.trim();
    if (!value) {
      setActionError('Enter an image URL first.');
      return;
    }
    busyRef.current = true;
    setActionError(null);
    setMessage(null);
    setWarnings([]);
    try {
      await cover.setExternalCover(value);
      setMessage('External cover set.');
      setExternalUrl('');
      setShowExternal(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'The external cover could not be set.');
    } finally {
      busyRef.current = false;
    }
  }, [cover, externalUrl]);

  /* ----------------------------- render -------------------------------- */

  if (projectsLoading) {
    return (
      <div className="space-y-5">
        <PageHeader
          title="Book Covers"
          description="Upload and manage a cover image for each project. Covers are embedded into EPUB and PDF exports."
          icon={<ImageIcon className="size-4" aria-hidden />}
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

  const resolution = cover.resolution;
  const hasCover = resolution !== null && resolution.kind !== 'none';
  const currentAsset = resolution?.kind === 'asset' ? resolution.asset : null;
  const aspect = currentAsset ? classifyAspect(currentAsset.width, currentAsset.height, RECOMMENDED_COVER_ASPECT) : null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Book Covers"
        description="Upload and manage a cover image for each project. Covers are validated locally and embedded into EPUB and PDF exports. Nothing is uploaded anywhere."
        icon={<ImageIcon className="size-4" aria-hidden />}
        actions={
          projects.length > 0 ? (
            <div className="flex flex-col gap-1">
              <label htmlFor="cover-project" className="text-subtle text-2xs font-medium uppercase tracking-wide">
                Project
              </label>
              <select
                id="cover-project"
                data-testid="cover-project"
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
            </div>
          ) : null
        }
      />

      {projectsError ? (
        <Card padding="md">
          <p className="text-danger flex items-center gap-1.5 text-xs" role="alert">
            <AlertTriangle className="size-3.5" aria-hidden />
            The project list could not be loaded.{' '}
            {projectsError instanceof Error ? projectsError.message : ''}
          </p>
        </Card>
      ) : projects.length === 0 ? (
        <EmptyState
          icon={<ImageIcon className="size-5" aria-hidden />}
          title="No projects to cover"
          description="Create a project first, then return here to upload its cover art."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
          {/* ---------------------- Preview column ---------------------- */}
          <Card padding="md" className="space-y-3" data-testid="cover-preview-panel">
            <p className="text-ink text-sm font-medium">Current cover</p>

            {cover.initialLoading ? (
              <div className="bg-surface-muted grid aspect-[2/3] place-items-center rounded-md border border-line">
                <Loader2 className="text-subtle size-5 animate-spin" aria-hidden />
              </div>
            ) : hasCover && cover.displayUrl ? (
              <div className="bg-surface-muted overflow-hidden rounded-md border border-line">
                {/* eslint-disable-next-line jsx-a11y/img-redundant-alt */}
                <img
                  src={cover.displayUrl}
                  alt={`Cover of ${activeProject?.title ?? 'the project'}`}
                  className="mx-auto block max-h-[420px] w-auto max-w-full object-contain"
                  data-testid="cover-image"
                />
              </div>
            ) : hasCover && resolution?.kind === 'external' ? (
              <div className="bg-surface-muted overflow-hidden rounded-md border border-line">
                <img
                  src={resolution.value}
                  alt={`Cover of ${activeProject?.title ?? 'the project'}`}
                  className="mx-auto block max-h-[420px] w-auto max-w-full object-contain"
                  data-testid="cover-image"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = 'none';
                  }}
                />
              </div>
            ) : (
              <div
                className="bg-surface-muted text-subtle grid aspect-[2/3] place-items-center rounded-md border border-dashed border-line-strong text-center"
                data-testid="cover-placeholder"
              >
                <div className="space-y-1 px-4">
                  <ImageIcon className="mx-auto size-7" aria-hidden />
                  <p className="text-xs">{resolution?.kind === 'asset-missing' ? 'Cover image missing on this device' : 'No cover yet'}</p>
                  {resolution?.kind === 'asset-missing' ? (
                    <p className="text-2xs leading-relaxed">
                      Covers are stored per device. Upload this project's cover again to restore it.
                    </p>
                  ) : null}
                </div>
              </div>
            )}

            {currentAsset ? (
              <dl className="text-2xs text-subtle grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <dt className="text-muted">Dimensions</dt>
                <dd data-testid="cover-dimensions">
                  {currentAsset.width}×{currentAsset.height}px
                </dd>
                <dt className="text-muted">Format</dt>
                <dd>{currentAsset.mimeType.replace('image/', '').toUpperCase()}</dd>
                <dt className="text-muted">Size</dt>
                <dd>{formatBytes(currentAsset.byteSize)}</dd>
                <dt className="text-muted">Added</dt>
                <dd>{formatRelative(currentAsset.createdAt)}</dd>
                <dt className="text-muted">Aspect</dt>
                <dd>
                  {aspect ? (
                    <Badge tone={severityTone(aspect.severity)} size="sm">
                      {aspect.ratio.toFixed(2)}:1
                    </Badge>
                  ) : null}
                </dd>
              </dl>
            ) : resolution?.kind === 'external' ? (
              <p className="text-subtle text-2xs break-all">
                External source: <span className="text-muted">{resolution.value}</span>
              </p>
            ) : null}

            {currentAsset && aspect && aspect.severity !== 'ok' && aspect.message ? (
              <p
                className={cn(
                  'flex items-start gap-1.5 text-2xs',
                  aspect.severity === 'critical' ? 'text-danger' : 'text-warning',
                )}
                role="status"
              >
                <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
                {aspect.message}
              </p>
            ) : null}

            {hasCover ? (
              <Button
                variant="danger"
                size="sm"
                iconLeft={<Trash2 className="size-3.5" />}
                onClick={() => void handleRemove()}
                loading={cover.busy}
                data-testid="cover-remove"
              >
                Remove cover
              </Button>
            ) : null}
          </Card>

          {/* ---------------------- Upload column ---------------------- */}
          <Card padding="md" className="space-y-4" data-testid="cover-upload-panel">
            <div>
              <p className="text-ink text-sm font-medium">Upload a new cover</p>
              <p className="text-subtle text-2xs leading-relaxed">
                PNG, JPEG or WebP · at most {formatBytes(MAX_COVER_BYTES)} ·{' '}
                {MIN_COVER_DIMENSION}–{MAX_COVER_DIMENSION}px on each side. A 2:3 ratio
                (e.g. 1200×1800) is recommended.
              </p>
            </div>

            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={onDrop}
              data-testid="cover-dropzone"
              className={cn(
                'rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors',
                dragActive ? 'border-accent bg-accent-soft/40' : 'border-line-strong bg-surface-muted/40',
              )}
            >
              <Upload className="text-subtle mx-auto mb-2 size-6" aria-hidden />
              <p className="text-muted text-xs">Drag an image here, or</p>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={onFileInputChange}
                data-testid="cover-file-input"
              />
              <Button
                variant="primary"
                size="sm"
                className="mt-2"
                iconLeft={<Upload className="size-3.5" />}
                onClick={() => fileInputRef.current?.click()}
                loading={cover.busy}
                disabled={cover.busy}
                data-testid="cover-upload-button"
              >
                Choose image…
              </Button>
            </div>

            <button
              type="button"
              onClick={() => setShowExternal((v) => !v)}
              className="text-accent flex items-center gap-1 text-2xs font-medium"
              aria-expanded={showExternal}
            >
              <Link2 className="size-3" aria-hidden />
              {showExternal ? 'Hide external URL option' : 'Use an external image URL instead'}
            </button>

            {showExternal ? (
              <div className="space-y-2" data-testid="cover-external-panel">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="url"
                    value={externalUrl}
                    onChange={(e) => setExternalUrl(e.target.value)}
                    placeholder="https://example.com/cover.jpg"
                    className="border-line bg-surface text-ink min-w-0 flex-1 rounded-md border px-2 py-1.5 text-xs"
                    data-testid="cover-external-input"
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void handleExternal()}
                    loading={cover.busy}
                    disabled={cover.busy}
                    data-testid="cover-external-apply"
                  >
                    Set
                  </Button>
                </div>
                <p className="text-subtle text-2xs leading-relaxed">
                  An external URL is stored as-is and shown directly; it is not embedded into
                  EPUB/PDF exports (only uploaded covers are). Upload instead if you want the
                  cover inside exported files.
                </p>
              </div>
            ) : null}

            {warnings.length > 0 ? (
              <ul className="text-warning space-y-1 text-2xs" role="status" data-testid="cover-warnings">
                {warnings.map((w) => (
                  <li key={w} className="flex items-start gap-1.5">
                    <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
                    {w}
                  </li>
                ))}
              </ul>
            ) : null}
            {message ? (
              <p className="text-success flex items-center gap-1.5 text-2xs" role="status" data-testid="cover-message">
                <Check className="size-3.5 shrink-0" aria-hidden />
                {message}
              </p>
            ) : null}
            {actionError ? (
              <p className="text-danger flex items-start gap-1.5 text-2xs" role="alert" data-testid="cover-error">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {actionError}
              </p>
            ) : null}

            {cover.variants.length > 1 ? (
              <div className="border-line border-t pt-3">
                <p className="text-subtle text-2xs font-medium uppercase tracking-wide">
                  Stored variants ({cover.variants.length})
                </p>
                <p className="text-subtle text-2xs">
                  Only the current cover is embedded into exports. Earlier uploads are cleaned up
                  automatically when replaced.
                </p>
              </div>
            ) : null}
          </Card>
        </div>
      )}
    </div>
  );
}

/** Exposed for tests: the recommended cover aspect ratio. */
export const RECOMMENDED_COVER_ASPECT_RATIO = RECOMMENDED_COVER_ASPECT;
