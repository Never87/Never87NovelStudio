/**
 * Secret redaction for logs and error surfaces (P5).
 *
 * API keys must never appear in console output, thrown messages or test
 * reports. Centralising redaction here means there is exactly one place to get
 * it right, and every caller can be audited.
 */

/** A single configured secret to scrub from a string. */
export interface RedactionTarget {
  /** The secret value itself (e.g. an API key). */
  value: string;
  /** Optional label used in the replacement, e.g. 'apiKey'. */
  label?: string;
}

const MIN_SECRET_LENGTH = 4;

/**
 * Replaces every occurrence of the given secrets in `text` with a mask.
 *
 * Short values are skipped: masking a 2-character "secret" would mangle ordinary
 * prose while protecting nothing meaningful.
 */
export function redactSecrets(text: string, targets: RedactionTarget[]): string {
  let result = text;
  for (const target of targets) {
    const value = target.value;
    if (!value || value.length < MIN_SECRET_LENGTH) continue;
    const mask = `***${target.label ?? 'redacted'}***`;
    // `split/join` avoids regex-escaping the secret.
    result = result.split(value).join(mask);
  }
  return result;
}

/** Masks an API key for display: shows nothing by default, `••••last4` on reveal. */
export function maskApiKey(apiKey: string): string {
  if (!apiKey) return '';
  if (apiKey.length <= 8) return '••••••••';
  return `${'•'.repeat(8)}${apiKey.slice(-4)}`;
}

/**
 * Redacts credentials that commonly leak into URLs or header echoes in error
 * bodies (e.g. `?key=…`, `x-api-key: …`, `Authorization: Bearer …`).
 */
export function redactKnownPatterns(text: string): string {
  return text
    .replace(/([?&](?:key|api_key|apikey|access_token)=)([^&\s]+)/gi, '$1***')
    .replace(/(x-api-key:\s*)([^\s,;]+)/gi, '$1***')
    .replace(/(x-goog-api-key:\s*)([^\s,;]+)/gi, '$1***')
    .replace(/(authorization:\s*(?:bearer\s+)?)([^\s,;]+)/gi, '$1***');
}

/**
 * Redacts a provider error string using BOTH exact secret matching and the
 * known credential patterns.
 *
 * This is the single entry point production error paths must call before any
 * untrusted provider text reaches `AiError.detail` or the UI. Exact matching
 * removes the request's own secrets (the API key and any custom-header value)
 * wherever they appear; pattern matching catches keys echoed inside URLs or
 * header-like text whose exact value we did not supply (e.g. a key embedded in
 * a message we never sent).
 *
 * @param text    untrusted text (provider error body fragment / raw response)
 * @param secrets the secret values to scrub verbatim (API key, header values)
 */
export function redactForError(text: string, secrets: string[]): string {
  if (!text) return text;
  const unique = Array.from(new Set(secrets.filter((value) => value && value.length >= MIN_SECRET_LENGTH)));
  // Exact-value scrub first (targets the request's own credentials), then the
  // pattern pass for anything shaped like a credential we did not enumerate.
  const exact = redactSecrets(
    text,
    unique.map((value) => ({ value, label: 'secret' })),
  );
  return redactKnownPatterns(exact);
}
