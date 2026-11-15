/**
 * Book Covers service (P9 Batch D).
 *
 * The business layer over `CoverRepository` + `ProjectRepository`. It owns:
 *
 *   - VALIDATION of an uploaded image (delegated to the pure validator in
 *     `modules/publishing/covers/image-validation.ts`, so the same rules drive
 *     both the UI preview and the persisted asset);
 *   - the `cover` reference on the project (`asset:<id>` / external / none),
 *     always updated through `ProjectService` so the project row is re-validated
 *     and its `updatedAt` refreshed;
 *   - CLEANUP: the previous cover asset becomes orphaned the moment a project
 *     points at a new one, so this service deletes the superseded asset (only
 *     when nothing else references it — covers are project-scoped and there is
 *     exactly one current cover per project).
 *
 * ## Boundaries
 *
 *   - Cover BYTES live in the `coverAssets` table as a Blob; the project keeps a
 *     short `cover` reference string. See `schemas/cover-asset.ts` for why.
 *   - This service never renders or converts images: it stores the validated
 *     bytes verbatim under a canonical MIME. Writers (EPUB/PDF) read the Blob.
 *   - TS config: no enum, literal unions, `import type` for type-only imports.
 */

import { ZodError } from 'zod';
import { createCoverAssetId, createProjectId } from '@/utils/id';
import { now } from '@/utils/date';
import {
  coverAssetRef,
  parseCoverRef,
  type CoverImageMime,
} from '@/schemas/cover-asset';
import type { CoverAsset, NovelProject } from '@/types';
import { CoverRepository } from '@/repositories/cover-repository';
import {
  ProjectRepository,
  ProjectRepositoryError,
  ProjectValidationError,
} from '@/repositories/project-repository';
import { ProjectService, ProjectServiceError } from './project-service';
import {
  validateCoverImage,
  toArrayBuffer,
  type ImageDimensionProbe,
  type CoverRejectionCode,
} from '@/modules/publishing/covers/image-validation';

/** Base error for cover business-rule failures. */
export class CoverServiceError extends Error {
  /** Machine-readable discriminator (e.g. `project-not-found`, `invalid-image`). */
  readonly code: string;
  readonly cause?: unknown;

  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'CoverServiceError';
    this.code = code;
    this.cause = cause;
  }
}

/** Stable codes the UI can branch on without parsing messages. */
export const COVER_ERROR_CODES = [
  'project-not-found',
  'invalid-image',
  'cover-not-found',
  'write-failed',
] as const;

export type CoverErrorCode = (typeof COVER_ERROR_CODES)[number];

/** How a project's `cover` field currently resolves. */
export type CoverResolution =
  | { readonly kind: 'none' }
  /** A stored asset exists and is returned with its bytes. */
  | { readonly kind: 'asset'; readonly asset: CoverAsset }
  /** An `asset:` reference whose asset is missing on this device (e.g. after an
   * import). The UI must degrade to a placeholder — never crash. */
  | { readonly kind: 'asset-missing'; readonly assetId: string }
  /** A legacy external URL or data URI. Stored as a plain string. */
  | { readonly kind: 'external'; readonly value: string };

/** The current cover of a project, as the UI needs it. */
export interface CurrentCover {
  readonly project: NovelProject;
  readonly resolution: CoverResolution;
  /** A directly displayable URL for `asset` resolution, or null. */
  readonly displayUrl: string | null;
}

/** Options for {@link CoverService.uploadCover}. */
export interface UploadCoverOptions {
  /** Optional target aspect ratio used to WARN about mismatches (width/height). */
  readonly targetAspectRatio?: number | null;
  /** Optional original file name, retained for the "download current cover" UX. */
  readonly fileName?: string;
  /**
   * Optional injected dimension probe. Defaults to the browser probe; tests
   * pass a deterministic stub instead of decoding a real image.
   */
  readonly probe?: ImageDimensionProbe;
  /** Backstop timeout for the decode (defaults to the validator's own value). */
  readonly decodeTimeoutMs?: number;
}

/** The outcome of an upload: the stored asset plus any non-fatal warnings. */
export interface UploadCoverResult {
  readonly asset: CoverAsset;
  readonly project: NovelProject;
  /** Non-fatal advisories (e.g. an unusual aspect ratio). Empty when clean. */
  readonly warnings: readonly string[];
}

/** Object URLs created by this service, so `release()` can revoke them. */
const objectUrls = new Set<string>();

/**
 * Builds a browser `Image`-decoding probe. Imported lazily by the default
 * dependency so this module stays importable in Node (tests) without DOM APIs.
 */
async function defaultProbe(): Promise<ImageDimensionProbe> {
  const mod = await import('@/modules/publishing/covers/image-validation');
  return mod.browserImageDimensionProbe;
}

export class CoverService {
  private readonly coverRepository: CoverRepository;
  private readonly projectRepository: ProjectRepository;
  private readonly projectService: ProjectService;

  constructor(
    coverRepository: CoverRepository = new CoverRepository(),
    projectRepository: ProjectRepository = new ProjectRepository(),
    projectService: ProjectService = new ProjectService(),
  ) {
    this.coverRepository = coverRepository;
    this.projectRepository = projectRepository;
    this.projectService = projectService;
  }

  /**
   * Resolves a project's CURRENT cover without loading every asset.
   *
   * - `none` when the project has no cover reference.
   * - `external` for a legacy URL/data URI (displayed directly).
   * - `asset` when the `asset:<id>` reference resolves to a stored asset on this
   *   device, with a freshly-created object URL for display.
   * - `asset-missing` when the reference points at an asset that does not exist
   *   here (an imported project, or a cover removed elsewhere) — the caller
   *   shows a placeholder rather than failing.
   */
  async getCurrentCover(projectId: string, createUrls = true): Promise<CurrentCover> {
    const project = await this.loadProject(projectId);
    const parsed = parseCoverRef(project.cover);

    if (parsed.kind === 'none') {
      return { project, resolution: { kind: 'none' }, displayUrl: null };
    }
    if (parsed.kind === 'external') {
      return { project, resolution: { kind: 'external', value: parsed.value }, displayUrl: parsed.value };
    }

    const asset = await this.coverRepository.getById(parsed.assetId);
    if (!asset || asset.projectId !== projectId) {
      return {
        project,
        resolution: { kind: 'asset-missing', assetId: parsed.assetId },
        displayUrl: null,
      };
    }

    let displayUrl: string | null = null;
    if (createUrls && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      displayUrl = URL.createObjectURL(asset.data);
      objectUrls.add(displayUrl);
    }
    return { project, resolution: { kind: 'asset', asset }, displayUrl };
  }

  /**
   * Every stored cover of a project, newest first (for a variant picker). Does
   * not create object URLs; callers use {@link createDisplayUrl} per asset.
   */
  async listProjectCovers(projectId: string): Promise<CoverAsset[]> {
    return this.coverRepository.listByProjectId(projectId);
  }

  /** Creates a displayable object URL for an asset Blob (tracked for release). */
  createDisplayUrl(asset: CoverAsset): string | null {
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
    const url = URL.createObjectURL(asset.data);
    objectUrls.add(url);
    return url;
  }

  /** Revokes every object URL this service created (call from a component unmount). */
  release(): void {
    if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      for (const url of objectUrls) URL.revokeObjectURL(url);
    }
    objectUrls.clear();
  }

  /**
   * Validates and stores an uploaded cover, then points the project at it.
   *
   * Steps (each can fail loudly with a specific `CoverServiceError`):
   *   1. The project must exist (never create one implicitly).
   *   2. The bytes must pass the SAME validator the UI preview used (format,
   *      size, dimensions). A failed validation stores nothing.
   *   3. The Blob is written to a NEW asset row (never inlined on the project).
   *   4. The project's `cover` is updated to `asset:<newId>` via
   *      `ProjectService.updateProject`, so it is re-validated and `updatedAt`
   *      is refreshed.
   *   5. The PREVIOUS asset (if any) is deleted — it is now unreferenced. A
   *      failure to delete the old asset is non-fatal (the new cover is already
   *      live); it is logged, not thrown.
   *
   * The original bytes are stored VERBATIM under their sniffed, canonical MIME;
   * no lossy re-encoding happens.
   */
  async uploadCover(
    projectId: string,
    bytes: Uint8Array,
    options: UploadCoverOptions = {},
  ): Promise<UploadCoverResult> {
    const project = await this.loadProject(projectId);

    const probe = options.probe ?? (await defaultProbe());
    const validation = await validateCoverImage(bytes, probe, {
      targetAspectRatio: options.targetAspectRatio ?? null,
      decodeTimeoutMs: options.decodeTimeoutMs,
    });
    if (!validation.ok) {
      throw new CoverServiceError(
        'invalid-image',
        validation.message,
        { rejection: validation.code } satisfies { rejection: CoverRejectionCode },
      );
    }

    const previousAssetId = currentAssetId(project.cover);

    // Copy bytes into a Blob keyed by the CANONICAL mime (never File.type).
    const mimeType: CoverImageMime = validation.mimeType;
    const data = new Blob([toArrayBuffer(bytes)], { type: mimeType });

    const asset: CoverAsset = {
      id: createCoverAssetId(),
      projectId,
      mimeType,
      data,
      byteSize: validation.byteSize,
      width: validation.width,
      height: validation.height,
      ...(options.fileName ? { fileName: sanitizeFileName(options.fileName) } : {}),
      createdAt: now(),
    };

    let stored: CoverAsset;
    try {
      stored = await this.coverRepository.create(asset);
    } catch (error) {
      throw this.wrap('write-failed', 'The cover image could not be stored.', error);
    }

    let updatedProject: NovelProject;
    try {
      updatedProject = await this.projectService.updateProject(projectId, {
        cover: coverAssetRef(stored.id),
      });
    } catch (error) {
      // Best-effort rollback: remove the freshly-written asset so a failed
      // project update does not leave an orphaned blob behind.
      await this.coverRepository.delete(stored.id).catch(() => undefined);
      throw this.wrap('write-failed', 'The project cover reference could not be updated.', error);
    }

    // Cleanup the superseded asset (only when it was ours and is now unused).
    if (previousAssetId && previousAssetId !== stored.id) {
      await this.coverRepository.delete(previousAssetId).catch((error) => {
        // Non-fatal: the new cover is live. An orphaned old blob is a nuisance,
        // not a correctness failure, so we never abort the successful upload.
        console.error('[cover-service] Failed to delete the superseded cover asset.', error);
      });
    }

    return { asset: stored, project: updatedProject, warnings: validation.warnings };
  }

  /**
   * Removes the project's current cover reference.
   *
   * - Clears `cover` on the project (via `ProjectService.updateProject`).
   * - Deletes the previously-referenced ASSET if it was device-local.
   * - An external URL/data URI is simply unlinked (never deleted — it is not ours).
   */
  async removeCover(projectId: string): Promise<NovelProject> {
    const project = await this.loadProject(projectId);
    const previousAssetId = currentAssetId(project.cover);

    const updated = await this.projectService.updateProject(projectId, { cover: null });

    if (previousAssetId) {
      await this.coverRepository.delete(previousAssetId).catch((error) => {
        console.error('[cover-service] Failed to delete the removed cover asset.', error);
      });
    }
    return updated;
  }

  /**
   * Points a project at an EXTERNAL image (legacy URL or data URI).
   *
   * The value is length-checked by the project schema (≤2000 chars); a longer
   * data URI is rejected by validation with a specific error. Stored assets are
   * the preferred path; this exists for backward compatibility and for users who
   * host covers elsewhere.
   */
  async setExternalCover(projectId: string, value: string): Promise<NovelProject> {
    const project = await this.loadProject(projectId);
    const trimmed = value.trim();
    if (trimmed === '') {
      throw new CoverServiceError('invalid-image', 'The cover URL is empty.');
    }
    const previousAssetId = currentAssetId(project.cover);
    const updated = await this.projectService.updateProject(projectId, { cover: trimmed });
    if (previousAssetId) {
      await this.coverRepository.delete(previousAssetId).catch((error) => {
        console.error('[cover-service] Failed to delete the superseded cover asset.', error);
      });
    }
    return updated;
  }

  /**
   * Resolves a project's current cover ASSET as bytes for a writer (EPUB/PDF).
   *
   * Returns `null` when the project has no cover, or when its reference is an
   * external string (writers only embed stored assets — an external URL is not
   * fetched). Resolves a missing asset to `null` rather than throwing, so an
   * export still succeeds without a cover after an import.
   */
  async getCoverBytesForExport(
    projectId: string,
  ): Promise<{ bytes: Uint8Array; mimeType: 'image/png' | 'image/jpeg' } | null> {
    const project = await this.projectRepository.getById(projectId);
    if (!project) return null;
    const parsed = parseCoverRef(project.cover);
    if (parsed.kind !== 'asset') return null;
    const asset = await this.coverRepository.getById(parsed.assetId);
    if (!asset || asset.projectId !== projectId) return null;
    // The EPUB writer supports PNG/JPEG covers; WebP is not embeddable there.
    if (asset.mimeType !== 'image/png' && asset.mimeType !== 'image/jpeg') return null;
    const bytes = new Uint8Array(await asset.data.arrayBuffer());
    return { bytes, mimeType: asset.mimeType };
  }

  /* ------------------------------- helpers ------------------------------- */

  private async loadProject(projectId: string): Promise<NovelProject> {
    if (!projectId || !projectId.trim()) {
      throw new CoverServiceError('project-not-found', 'A project id is required.');
    }
    let project: NovelProject | null;
    try {
      project = await this.projectRepository.getById(projectId);
    } catch (error) {
      throw this.wrap('write-failed', `Failed to load project "${projectId}".`, error);
    }
    if (!project) {
      throw new CoverServiceError('project-not-found', `Project "${projectId}" was not found.`);
    }
    return project;
  }

  private wrap(code: CoverErrorCode, message: string, error: unknown): Error {
    if (error instanceof CoverServiceError) return error;
    if (error instanceof ProjectRepositoryError || error instanceof ProjectValidationError) {
      return new CoverServiceError(code, message, error);
    }
    if (error instanceof ProjectServiceError) {
      return new CoverServiceError(code, message, error);
    }
    if (error instanceof ZodError) {
      return new CoverServiceError(code, message, error);
    }
    return new CoverServiceError(code, message, error);
  }
}

/** Extracts the asset id from a project's `cover`, or `null` when not an asset ref. */
function currentAssetId(cover: string | undefined): string | null {
  const parsed = parseCoverRef(cover);
  return parsed.kind === 'asset' ? parsed.assetId : null;
}

/**
 * Reduces an arbitrary file name to a safe, short display-only value.
 *
 * The name is NEVER used as a path (assets are keyed by id) — it is purely for
 * the "download current cover" UX, so we strip separators/control chars and cap
 * the length. Returns `undefined` when the result would be empty.
 */
function sanitizeFileName(name: string): string | undefined {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 200);
  return cleaned === '' ? undefined : cleaned;
}

/** Re-exported so callers can construct ids consistently if needed. */
export { createProjectId };

/** The error codes as a set, for exhaustive checks by callers. */
export function isCoverErrorCode(value: string): value is CoverErrorCode {
  return (COVER_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Module-level singleton, shared by every hook. Defaults to a repository bound
 * to the singleton `db` (via each dependency's own default constructor).
 */
export const coverService = new CoverService();
