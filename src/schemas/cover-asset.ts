import { z } from 'zod';

/**
 * Cover-asset domain schema (P9 Batch D — Book Covers).
 *
 * ## Why a separate table instead of a base64 string on the project?
 *
 * `NovelProject.cover` is a short (≤2000 char) string *reference*. Inlining a
 * real cover image as base64 there would:
 *   - exceed the column limit for all but trivial images,
 *   - bloat every project read (the whole row is loaded on the project list),
 *   - corrupt the transfer/integrity story (see below),
 *   - mix a large opaque blob into authoring metadata.
 *
 * So cover BYTES live in this dedicated `coverAssets` table as a `Blob`, and the
 * project only keeps `cover: "asset:<assetId>"`. This mirrors the "independent
 * image resource storage" the spec asks for and keeps projects strictly
 * isolated by `projectId`.
 *
 * ## Not part of the JSON transfer payload (deliberate)
 *
 * The P9 transfer/snapshot/backup format is canonical JSON with a SHA-256
 * integrity digest (`src/transfer/canonical-json.ts`). A `Blob` is not
 * JSON-representable and `canonicalStringify` would silently emit `{}` for it,
 * producing a corrupt package. Therefore cover binaries are **device-local
 * resources**: excluded from the JSON transfer collections (documented in the
 * collection registry) but INCLUDED in project deletion cascade. On import the
 * project's `cover` reference may point at an asset that does not exist on the
 * target device — the UI degrades gracefully to a placeholder (never a crash).
 * The reference string itself travels normally as a project field.
 *
 * tsconfig constraints honoured: `erasableSyntaxOnly` (no enum), literal unions.
 */

/**
 * Image formats the Book Covers module accepts.
 *
 * The MIME here is the CANONICAL value we store after sniffing the real bytes;
 * a browser may report `image/jpg`, an empty type, or a lying type — we always
 * re-derive the true format from magic bytes (see `image-validation.ts`).
 */
export const COVER_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export const CoverImageMimeSchema = z.enum(COVER_IMAGE_MIME_TYPES);
export type CoverImageMime = z.infer<typeof CoverImageMimeSchema>;

/**
 * Hard upper bound on the stored asset size.
 *
 * 8 MB is generous for a single cover (typical e-commerce covers are well under
 * 2 MB) while staying far below IndexedDB value limits and protecting the
 * quota. Enforced at UPLOAD time (before reading bytes) and re-asserted here.
 */
export const MAX_COVER_BYTES = 8 * 1024 * 1024;

/**
 * Upper bound on pixel dimensions on either axis.
 *
 * 12000 px comfortably exceeds print-resolution covers (e.g. ~6000×9000 for a
 * 300 DPI 6×9 cover) while rejecting pathological images that could exhaust
 * memory when decoded. Both axes checked independently.
 */
export const MAX_COVER_DIMENSION = 12_000;

/**
 * Minimum dimensions we consider a usable cover.
 *
 * Rejects 1×1 tracking pixels / icons / accidental thumbnails so a "cover" is
 * at least perceivable. Not a quality bar on aspect ratio — that is a WARNING,
 * not a rejection (a project may legitimately use an unusual trim size).
 */
export const MIN_COVER_DIMENSION = 64;

/** The short ASCII prefix that marks a `NovelProject.cover` value as an asset reference. */
export const COVER_ASSET_REF_PREFIX = 'asset:';

/** Builds the `NovelProject.cover` reference string for an asset id. */
export function coverAssetRef(assetId: string): string {
  return `${COVER_ASSET_REF_PREFIX}${assetId}`;
}

/**
 * Parses a `NovelProject.cover` value.
 *
 * @returns `{ kind: 'asset', assetId }` for an `asset:<id>` reference;
 *          `{ kind: 'external', value }` for any other non-empty string
 *          (a legacy URL or data URI); `{ kind: 'none' }` when absent/empty.
 *
 * This is what lets old covers (URLs / data URIs) and new covers (asset refs)
 * coexist without changing the meaning of the `cover` column.
 */
export function parseCoverRef(
  cover: string | undefined | null,
): { kind: 'asset'; assetId: string } | { kind: 'external'; value: string } | { kind: 'none' } {
  if (typeof cover !== 'string') return { kind: 'none' };
  const trimmed = cover.trim();
  if (trimmed === '') return { kind: 'none' };
  if (trimmed.startsWith(COVER_ASSET_REF_PREFIX)) {
    const assetId = trimmed.slice(COVER_ASSET_REF_PREFIX.length).trim();
    // Guard against "asset:" with no id — treat as no reference rather than
    // pointing at an empty key.
    if (assetId === '') return { kind: 'none' };
    return { kind: 'asset', assetId };
  }
  return { kind: 'external', value: trimmed };
}

const timestampSchema = z
  .number()
  .int('Timestamp must be an integer')
  .nonnegative('Timestamp must be non-negative');

/**
 * A stored cover image resource.
 *
 * The `data` is a `Blob` whose `type` must equal `mimeType` (we set both when
 * creating it). `width`/`height` are the intrinsic pixel dimensions captured at
 * upload time so the UI can show them without re-decoding the image.
 */
export const CoverAssetSchema = z
  .object({
    /** Stable primary key, prefixed (`cov_...`). */
    id: z.string().min(1, 'Cover asset id is required'),
    /** Owning project. Indexed; enforces isolation. */
    projectId: z.string().min(1, 'Cover asset projectId is required'),
    /** Canonical MIME type, re-derived from the real bytes. */
    mimeType: CoverImageMimeSchema,
    /** Image bytes. */
    data: z.instanceof(Blob),
    /** Byte length (denormalised for the UI; re-checked against limits). */
    byteSize: z
      .number()
      .int('byteSize must be an integer')
      .positive('An asset must not be empty')
      .max(MAX_COVER_BYTES, `Covers must be at most ${MAX_COVER_BYTES} bytes`),
    width: z
      .number()
      .int()
      .min(MIN_COVER_DIMENSION, `Width must be at least ${MIN_COVER_DIMENSION}px`)
      .max(MAX_COVER_DIMENSION, `Width must be at most ${MAX_COVER_DIMENSION}px`),
    height: z
      .number()
      .int()
      .min(MIN_COVER_DIMENSION, `Height must be at least ${MIN_COVER_DIMENSION}px`)
      .max(MAX_COVER_DIMENSION, `Height must be at most ${MAX_COVER_DIMENSION}px`),
    /** Original file name, retained for the "download current cover" UX. */
    fileName: z.string().trim().min(1).max(260).optional(),
    createdAt: timestampSchema,
  })
  .strict();

export type CoverAsset = z.infer<typeof CoverAssetSchema>;
