/**
 * Story Editor — minimal HTML escaping shared by the Markdown loader/serialiser.
 *
 * Kept in its own module so both the loader (Markdown → HTML) and any future
 * exporter can share ONE implementation. It escapes the five characters that
 * matter for text and quoted-attribute contexts; the loader never emits tags
 * from user data, so this is the only injection surface and it is fully closed.
 */
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}
