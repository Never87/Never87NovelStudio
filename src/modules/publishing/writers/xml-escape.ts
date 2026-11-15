/**
 * XML escaping for the EPUB writer (P9 Batch C).
 *
 * `escapeHtml` (Batch A) already escapes `& < > " '`, but XML 1.0 has an extra
 * constraint the HTML writer does not care about: several C0 control characters
 * are ILLEGAL in an XML document even when escaped (`&#x0;` is still invalid).
 * If a manuscript ever contained one (pasted from another tool), it would make
 * the EPUB invalid/unopenable. This helper therefore:
 *
 *   1. Drops characters that are illegal in XML 1.0 entirely
 *      (U+0000–U+0008, U+000B, U+000C, U+000E–U+001F, U+FFFE, U+FFFF).
 *   2. Escapes `& < > " '` to their XML entities.
 *
 * It is deliberately separate from the HTML `escapeHtml` so the HTML writer's
 * (already-tested) behaviour is unchanged.
 */

/** Characters that are not permitted anywhere in an XML 1.0 document. */
// eslint-disable-next-line no-control-regex
const ILLEGAL_XML_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g;

/**
 * Escapes text for safe inclusion in an XML/XHTML document (element content or
 * double/single-quoted attributes).
 */
export function escapeXml(text: string): string {
  return (text ?? '')
    .replace(ILLEGAL_XML_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
