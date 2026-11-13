/**
 * Deterministic text fingerprinting for the import pipeline (P8).
 *
 * ## Why a pure implementation?
 *
 * `parsedTextHash` must be IDENTICAL across every environment the app runs in
 * (browser main thread, Web Workers, Node during verification, and any future
 * server-side tooling) and must not depend on a secure context, a global
 * `crypto.subtle`, or asynchronous scheduling. A synchronous, dependency-free
 * SHA-256 over the UTF-8 encoding of the input satisfies all of those at once
 * and — crucially — lets us compute the hash OUTSIDE any Dexie transaction
 * without introducing an async await inside a transaction scope.
 *
 * ## Input contract (MUST hold)
 *
 * The hash is computed over the RAW text bytes exactly as given. It NEVER
 * normalises, trims, lowercases, or rewrites line endings: `'\r\n'`, `'\r'`,
 * `'\n'`, leading/trailing whitespace and a BOM all affect the digest. This is
 * essential because sections are offset-addressed against the verbatim text; a
 * lenient hash that ignored EOL/whitespace differences could consider two
 * genuinely different documents "the same" and skip a required re-parse.
 *
 * ## Algorithm tag & historical compatibility
 *
 * The stored value is TAGGED: `sha256:<64 lowercase hex>`. Older builds stored a
 * bare 8-hex FNV-1a digest. Because the tagged form can never equal an untagged
 * value, a legacy/unknown digest is never mistaken for a current one — the
 * comparison simply fails and the document flows through the ordinary (guarded)
 * re-parse path. No data migration is required and provenance rules still apply.
 */

/** Prefix that identifies the current hashing algorithm in stored values. */
export const HASH_ALGORITHM = 'sha256';

/** Full stored-hash prefix (`sha256:`). */
export const HASH_PREFIX = `${HASH_ALGORITHM}:`;

/* -------------------------------------------------------------------------- */
/* SHA-256 core (FIPS 180-4), synchronous, dependency-free                    */
/* -------------------------------------------------------------------------- */

/** SHA-256 initial hash values (first 32 bits of the fractional parts of the
 *  square roots of the first eight primes). */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Right-rotate a 32-bit word. */
function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** Encodes a JS string as UTF-8 bytes (identical to TextEncoder output). */
export function utf8Bytes(text: string): Uint8Array {
  // Fast path for the common ASCII case; correct fallback otherwise.
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate — combine with the following low surrogate (if any).
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
        bytes.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 0x3f),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f),
        );
      } else {
        // Lone high surrogate — encode as U+FFFD (replacement), matching the
        // WTF-8→UTF-8 behaviour of TextEncoder.
        bytes.push(0xef, 0xbf, 0xbd);
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // Lone low surrogate.
      bytes.push(0xef, 0xbf, 0xbd);
    } else {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return Uint8Array.from(bytes);
}

/**
 * SHA-256 of the UTF-8 encoding of `text`, as lowercase hex (64 chars).
 *
 * Pure and synchronous — the digest is exactly FIPS 180-4 SHA-256, so it equals
 * `crypto.subtle.digest('SHA-256', ...)` / `openssl dgst -sha256` for the same
 * bytes. No normalisation is applied to `text`.
 */
export function sha256Hex(text: string): string {
  const msg = utf8Bytes(text);
  const msgLenBitsHi = Math.floor((msg.length * 8) / 0x100000000);
  const msgLenBitsLo = (msg.length * 8) >>> 0;

  // Padding: 0x80, then zeros, then 64-bit big-endian length. Total ≡ 0 mod 64.
  const withOne = msg.length + 1;
  const padded = withOne % 64 > 56 ? withOne + (64 - (withOne % 64)) + 56 : withOne + (56 - (withOne % 64));
  const total = padded + 8;
  const buf = new Uint8Array(total);
  buf.set(msg, 0);
  buf[msg.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, msgLenBitsHi, false);
  dv.setUint32(total - 4, msgLenBitsLo, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = dv.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const toHex = (n: number): string => (n >>> 0).toString(16).padStart(8, '0');
  return toHex(h0) + toHex(h1) + toHex(h2) + toHex(h3) + toHex(h4) + toHex(h5) + toHex(h6) + toHex(h7);
}

/* -------------------------------------------------------------------------- */
/* Tagged fingerprint used by the import pipeline                            */
/* -------------------------------------------------------------------------- */

/**
 * The canonical, TAGGED fingerprint of a document's raw text:
 * `sha256:<64 hex>`. This is what gets stored in `SourceDocument.parsedTextHash`.
 *
 * Computed over the raw string bytes only — no normalisation.
 */
export function hashRawText(text: string): string {
  return `${HASH_PREFIX}${sha256Hex(text)}`;
}

/**
 * Whether a stored hash was produced by the CURRENT algorithm.
 *
 * Anything else (e.g. a legacy 8-hex FNV digest, or a value from an unknown
 * future algorithm) returns false so callers treat it as "not equal" and take
 * the safe re-parse path rather than silently assuming the text is unchanged.
 */
export function isCurrentHashFormat(stored: string | null | undefined): boolean {
  if (typeof stored !== 'string') return false;
  if (!stored.startsWith(HASH_PREFIX)) return false;
  return /^[0-9a-f]{64}$/.test(stored.slice(HASH_PREFIX.length));
}
