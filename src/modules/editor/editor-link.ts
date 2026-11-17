/**
 * Story Editor — URL helpers for the Link and Image commands.
 *
 * The manuscript is stored as Markdown and the editor is rebuilt from it on
 * open (see `MarkdownEditor`). That means anything inserted has to survive a
 * round-trip through the Markdown serialiser — and, critically, must never put
 * something unsafe or volatile into the canonical document.
 *
 * This module is therefore PURE (no DOM, no React) and owns two decisions:
 *
 *   - what counts as a safe, persistable link/image href, and
 *   - the minimal normalisation (trim + default protocol) applied before it is
 *     inserted.
 *
 * Security rationale — `javascript:` and friendlier cousins
 * ---------------------------------------------------------
 * A link/image href ends up in the DOM (`<a href>` / `<img src>`). A pasted
 * `javascript:alert(1)` (or `vbscript:`, or a `data:text/html` URL) would then
 * be clickable/executable. We allow ONLY:
 *   - `http(s)://`, `mailto:` — ordinary links,
 *   - `data:image/...` — self-contained raster images (the only way to embed an
 *     image without a storage mechanism; they travel with the Markdown),
 *   - relative paths (`./cover.png`, `images/a.jpg`, `#anchor`).
 * Everything else (including `blob:` — see {@link normaliseImageSrc}) is
 * rejected.
 */

/** A normalisation result that also explains WHY an input was rejected. */
export type SrcResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: string };

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Schemes that are always unsafe in an href/src, regardless of context. */
const BLOCKED_SCHEMES = /^(javascript|vbscript|file|filesystem|blob):/i;

/** Raster `data:` image types we accept inline. SVG is excluded on purpose.
 *  `image/svg+xml` can carry script and is not renderable as a plain <img> blob
 *  in every context, so it is not accepted into the canonical Markdown. */
const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|avif|bmp);base64,[a-z0-9+/=\s]+$/i;

/** Recognises a bare host that should get a default `https://` protocol. */
function looksLikeBareHost(value: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+([/?#:].*)?$/i.test(value) && !value.includes('@');
}

function reject(reason: string): SrcResult {
  return { ok: false, reason };
}

/**
 * Normalises an href for use as a LINK target (`[text](href)`).
 *
 * Accepts `http(s)`, `mailto:`, relative paths and anchors. A bare host such as
 * `example.com/foo` is given an `https://` prefix. Anything with a blocked or
 * unknown scheme is rejected — the caller leaves the text unlinked rather than
 * inserting an unsafe link.
 */
export function normaliseHref(raw: string): SrcResult {
  const value = (raw ?? '').trim();
  if (value === '') return reject('The link is empty.');
  if (CONTROL_CHARS.test(value)) return reject('The link contains control characters.');

  if (BLOCKED_SCHEMES.test(value)) return reject('That link scheme is not allowed.');

  if (HAS_SCHEME.test(value)) {
    // http/https/mailto are the only absolute schemes we accept as links.
    if (/^(https?|mailto):/i.test(value)) return { ok: true, value };
    return reject('Only http(s) and mailto links are allowed.');
  }

  // Protocol-relative (`//host/path`) is treated as https.
  if (value.startsWith('//')) return { ok: true, value: `https:${value}` };

  // Relative path or anchor — safe to keep verbatim.
  if (value.startsWith('#') || value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) {
    return { ok: true, value };
  }

  if (looksLikeBareHost(value)) return { ok: true, value: `https://${value}` };

  // Any other scheme-less string (e.g. "not a url") cannot be a usable link.
  return reject('That does not look like a link.');
}

/**
 * Normalises a src for an IMAGE (`![alt](src)`).
 *
 * Accepts `http(s)` URLs, relative image paths and inline `data:image/...`
 * base64 values. `blob:` URLs are deliberately REJECTED: they are valid only in
 * the current page session and would produce a broken image after reload. If a
 * user pastes one, the caller must explain the limitation rather than persist
 * an unstable reference. Same for `javascript:`/`data:text` etc.
 */
export function normaliseImageSrc(raw: string): SrcResult {
  const value = (raw ?? '').trim();
  if (value === '') return reject('The image URL is empty.');
  if (CONTROL_CHARS.test(value)) return reject('The image URL contains control characters.');

  if (/^blob:/i.test(value)) {
    return reject(
      'Blob (in-session) image URLs cannot be stored — they break after reload. Use an image URL or a data: URL instead.',
    );
  }
  if (BLOCKED_SCHEMES.test(value)) return reject('That image scheme is not allowed.');

  if (HAS_SCHEME.test(value)) {
    if (/^https?:/i.test(value)) return { ok: true, value };
    if (/^data:/i.test(value)) {
      return DATA_IMAGE.test(value)
        ? { ok: true, value }
        : reject('Only base64 raster images (PNG/JPEG/GIF/WebP) can be embedded as data URLs.');
    }
    return reject('Only http(s), relative or data:image URLs are allowed for images.');
  }

  if (value.startsWith('//')) return { ok: true, value: `https:${value}` };
  if (value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) {
    return { ok: true, value };
  }
  if (looksLikeBareHost(value)) return { ok: true, value: `https://${value}` };

  return reject('That does not look like an image URL.');
}
