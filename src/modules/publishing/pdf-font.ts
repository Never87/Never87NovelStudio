/**
 * Bundled CJK font loader (P9 Batch C).
 *
 * The PDF writer needs the raw bytes of the bundled Noto Sans SC subset to embed
 * a real Chinese font (the standard PDF fonts cannot render Chinese). This module
 * fetches that file ONCE from the app's static assets and caches the bytes, so
 * repeated PDF exports never re-download the ~7.4 MB font.
 *
 * - The file lives at `public/fonts/NotoSansSC-Regular-subset.ttf`, served at
 *   `${BASE_URL}fonts/NotoSansSC-Regular-subset.ttf`. It is fetched on demand
 *   (never on app load) so normal use pays no cost.
 * - The bytes are cached in a module-level promise (in-flight de-duplication) and
 *   a resolved `Uint8Array`, so concurrent callers share ONE request.
 * - Works in the browser (`fetch`). In non-browser contexts (tests), callers should
 *   pass font bytes to the writer directly instead of using this loader.
 *
 * The font is licensed under the SIL OFL 1.1 (see `public/fonts/OFL.txt`).
 */

/** Static path (relative to the app base) of the bundled PDF font. */
export const PDF_FONT_FILE = 'fonts/NotoSansSC-Regular-subset.ttf';

/** Resolved font bytes (cached after the first successful load). */
let cached: Uint8Array | null = null;
/** In-flight load promise, so concurrent callers share one fetch. */
let inflight: Promise<Uint8Array> | null = null;

/** Resolves the public URL of the font, honouring Vite's base path. */
export function pdfFontUrl(): string {
  const base = import.meta.env.BASE_URL ?? '/';
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  return `${normalizedBase}${PDF_FONT_FILE}`;
}

/**
 * Loads the bundled PDF font bytes, caching the result.
 *
 * @throws {Error} if the font cannot be fetched (so the caller can surface a clear
 *   "font unavailable" message rather than producing a broken PDF).
 */
export async function loadPdfFontBytes(): Promise<Uint8Array> {
  if (cached) return cached;
  if (inflight) return inflight;

  if (typeof fetch !== 'function') {
    throw new Error('Font loading requires a browser fetch environment.');
  }

  inflight = (async () => {
    try {
      const response = await fetch(pdfFontUrl());
      if (!response.ok) {
        throw new Error(`Font request failed: ${response.status} ${response.statusText}`);
      }
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      cached = bytes;
      return bytes;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/** Clears the cache (test-only helper). */
export function __resetPdfFontCacheForTests(): void {
  cached = null;
  inflight = null;
}
