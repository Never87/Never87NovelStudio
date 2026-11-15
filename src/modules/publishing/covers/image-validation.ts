/**
 * Cover image validation (P9 Batch D — Book Covers).
 *
 * This module is the single gate between a user-selected File and the cover
 * that gets persisted. It is deliberately PURE and browser-only-by-injection:
 * the byte sniffing and limit checks are plain functions that a Node test can
 * exercise directly, while the dimension probe needs a real `Image` decoder and
 * therefore takes it as an injectable dependency.
 *
 * ## Why sniff magic bytes instead of trusting `File.type`?
 *
 * Browsers report a MIME type from the file NAME extension (or a server header),
 * which a user can rename at will (`photo.txt` → `cover.png`). A WebP file
 * mislabelled `image/png` would then be stored with a MIME that a later EPUB/PDF
 * consumer decodes incorrectly. So we derive the TRUE format from the first few
 * bytes and REJECT anything that is not PNG / JPEG / WebP. The derived MIME —
 * never the browser's guess — is what we store.
 *
 * ## What is rejected here (and why)
 *
 *  - unknown / unreadable format      → cannot be safely embedded downstream
 *  - empty file                       → nothing to store
 *  - too many bytes                   → quota protection (checked before decode)
 *  - too small / too large dimensions → unusable or memory-exhausting
 *
 * Aspect ratio is the ONE structural property that is a WARNING, not a failure:
 * a project may legitimately use an unusual trim size. The caller surfaces the
 * warning and the user stays in control.
 */

import {
  MAX_COVER_BYTES,
  MAX_COVER_DIMENSION,
  MIN_COVER_DIMENSION,
  type CoverImageMime,
} from '@/schemas/cover-asset';

/** Why a candidate image was rejected. Machine-readable so the UI can explain it. */
export type CoverRejectionCode =
  | 'empty'
  | 'too-large'
  | 'unknown-format'
  | 'too-small'
  | 'dimensions-too-large'
  | 'decode-failed';

/** The outcome of validating a candidate cover. */
export type CoverValidationResult =
  | {
      readonly ok: true;
      /** The CANONICAL MIME derived from the real bytes (never `File.type`). */
      readonly mimeType: CoverImageMime;
      readonly byteSize: number;
      readonly width: number;
      readonly height: number;
      /** Non-fatal advisories (e.g. an unusual aspect ratio). */
      readonly warnings: readonly string[];
    }
  | {
      readonly ok: false;
      readonly code: CoverRejectionCode;
      /** A human-readable, specific reason (safe to show in the UI). */
      readonly message: string;
    };

/**
 * Sniffs the true image format from its leading bytes.
 *
 * Returns `null` for anything that is not a supported cover format, so callers
 * can reject rather than store an image a writer cannot embed.
 */
export function sniffImageMime(bytes: Uint8Array): CoverImageMime | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  // WebP: "RIFF" ....  "WEBP"
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/** Formats a byte count for a human-readable message. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Checks the cheap, decode-free invariants (size + format) BEFORE reading the
 * file into memory. Callers should run this first so a 500 MB file is rejected
 * without ever being fully loaded.
 */
export function precheckImageFile(file: {
  readonly size: number;
  readonly name?: string;
}): { ok: true } | { ok: false; code: CoverRejectionCode; message: string } {
  if (file.size <= 0) {
    return { ok: false, code: 'empty', message: 'The selected file is empty.' };
  }
  if (file.size > MAX_COVER_BYTES) {
    return {
      ok: false,
      code: 'too-large',
      message: `That image is ${formatBytes(file.size)}, which exceeds the ${formatBytes(MAX_COVER_BYTES)} limit.`,
    };
  }
  return { ok: true };
}

/** A minimal image decoder dependency, so dimension probing stays testable. */
export interface ImageDimensionProbe {
  /** Resolves the intrinsic pixel size, or rejects when the bytes cannot decode. */
  (bytes: Uint8Array, mimeType: CoverImageMime): Promise<{ width: number; height: number }>;
}

/**
 * Diagnostic severity for a cover relative to a target aspect ratio.
 *
 * `ok`        — within tolerance of the target (or no target given)
 * `warning`   — usable but off; the user is warned, not blocked
 * `critical`  — far from the target (e.g. a 16:9 photo used as a 2:3 cover)
 */
export type AspectSeverity = 'ok' | 'warning' | 'critical';

/** A human-readable dimension classified against a target aspect ratio. */
export interface AspectAssessment {
  readonly severity: AspectSeverity;
  /** The actual aspect ratio (width / height). */
  readonly ratio: number;
  readonly message: string | null;
}

/** Why a cover dimension was flagged (drives the UI icon/colour). */
export function classifyAspect(
  width: number,
  height: number,
  target: number | null,
): AspectAssessment {
  if (height <= 0 || width <= 0) {
    return { severity: 'critical', ratio: 0, message: 'The image has invalid dimensions.' };
  }
  const ratio = width / height;
  if (target === null) return { severity: 'ok', ratio, message: null };

  // Relative error, so the tolerance scales with the target ratio.
  const error = Math.abs(ratio - target) / target;
  if (error <= 0.08) return { severity: 'ok', ratio, message: null };
  if (error <= 0.25) {
    return {
      severity: 'warning',
      ratio,
      message: `This image's aspect ratio (${ratio.toFixed(2)}:1) is a little off the recommended ${target.toFixed(2)}:1. It will still upload, but may be cropped or letterboxed by some stores.`,
    };
  }
  return {
    severity: 'critical',
    ratio,
    message: `This image's aspect ratio (${ratio.toFixed(2)}:1) is far from the recommended ${target.toFixed(2)}:1. Most platforms will crop or reject it.`,
  };
}

/** Options controlling a validation run. */
export interface ValidateCoverOptions {
  /** Optional target aspect ratio (width / height) used for warnings. */
  readonly targetAspectRatio?: number | null;
  /** Backstop for a decode that never settles. Defaults to 15 s. */
  readonly decodeTimeoutMs?: number;
}

const DEFAULT_DECODE_TIMEOUT_MS = 15_000;

/**
 * Validates a candidate cover end to end.
 *
 * Order matters for cost: cheap checks (empty / oversized / magic bytes) run
 * before the expensive decode, so junk is rejected without touching a decoder.
 *
 * @param bytes    The full file bytes.
 * @param probe    A dimension decoder (browser default supplied by the caller).
 * @param options  Validation tuning.
 */
export async function validateCoverImage(
  bytes: Uint8Array,
  probe: ImageDimensionProbe,
  options: ValidateCoverOptions = {},
): Promise<CoverValidationResult> {
  if (bytes.byteLength === 0) {
    return { ok: false, code: 'empty', message: 'The selected file is empty.' };
  }
  if (bytes.byteLength > MAX_COVER_BYTES) {
    return {
      ok: false,
      code: 'too-large',
      message: `That image is ${formatBytes(bytes.byteLength)}, which exceeds the ${formatBytes(MAX_COVER_BYTES)} limit.`,
    };
  }

  const mimeType = sniffImageMime(bytes);
  if (!mimeType) {
    return {
      ok: false,
      code: 'unknown-format',
      message: 'That file is not a PNG, JPEG or WebP image.',
    };
  }

  let dimensions: { width: number; height: number };
  try {
    const timeout = options.decodeTimeoutMs ?? DEFAULT_DECODE_TIMEOUT_MS;
    dimensions = await withTimeout(probe(bytes, mimeType), timeout);
  } catch {
    return {
      ok: false,
      code: 'decode-failed',
      message: 'That image could not be decoded — it may be corrupt or truncated.',
    };
  }

  const { width, height } = dimensions;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < MIN_COVER_DIMENSION ||
    height < MIN_COVER_DIMENSION
  ) {
    return {
      ok: false,
      code: 'too-small',
      message: `The image must be at least ${MIN_COVER_DIMENSION}×${MIN_COVER_DIMENSION} pixels (this one is ${width}×${height}).`,
    };
  }
  if (width > MAX_COVER_DIMENSION || height > MAX_COVER_DIMENSION) {
    return {
      ok: false,
      code: 'dimensions-too-large',
      message: `The image must be at most ${MAX_COVER_DIMENSION}×${MAX_COVER_DIMENSION} pixels (this one is ${width}×${height}).`,
    };
  }

  const assessment = classifyAspect(width, height, options.targetAspectRatio ?? null);
  const warnings: string[] = [];
  if (assessment.message) warnings.push(assessment.message);

  return { ok: true, mimeType, byteSize: bytes.byteLength, width, height, warnings };
}

/** Rejects a promise that does not settle within `ms` (a stuck image decode). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Copies `bytes` into a fresh, non-shared `ArrayBuffer`.
 *
 * TS's DOM lib types require `BlobPart` to be backed by a plain `ArrayBuffer`
 * (not `SharedArrayBuffer`), and `Uint8Array<ArrayBufferLike>` does not satisfy
 * that when the underlying buffer is not known to be a plain ArrayBuffer.
 * Copying through `Uint8Array.from` always yields an `ArrayBuffer`-backed view,
 * so writers/probes can hand it to `new Blob([...])` without a cast.
 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/**
 * Browser dimension probe: decodes the bytes through an `Image` element and an
 * object URL. Uses `createImageBitmap` when available (faster, decodes off the
 * main thread), falling back to `<img>` otherwise.
 *
 * This function touches browser globals, so it lives here (the app layer) rather
 * than in the pure validator, which takes it as an injected dependency.
 */
export const browserImageDimensionProbe: ImageDimensionProbe = async (bytes, mimeType) => {
  if (typeof createImageBitmap === 'function' && typeof ImageBitmap !== 'undefined') {
    const blob = new Blob([toArrayBuffer(bytes)], { type: mimeType });
    const bitmap = await createImageBitmap(blob);
    try {
      return { width: bitmap.width, height: bitmap.height };
    } finally {
      bitmap.close?.();
    }
  }

  if (typeof document === 'undefined' || typeof URL === 'undefined') {
    throw new Error('Image decoding requires a browser environment.');
  }
  const blob = new Blob([toArrayBuffer(bytes)], { type: mimeType });
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<{ width: number; height: number }>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error('image decode error'));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
};
