import { sha256Hex } from '@/utils/text-hash';
import type { TransferIntegrity } from '@/schemas/transfer';

/**
 * Canonical JSON serialisation & integrity hashing (P9 Batch 1).
 *
 * ## Why a custom canonicaliser?
 *
 * `JSON.stringify` preserves insertion order, so two structurally identical
 * objects built by different code paths can serialise differently. That would
 * make the integrity digest — and therefore any round-trip or determinism test —
 * depend on incidental key order. This module defines ONE canonical form:
 *
 *   - object keys are emitted in ascending (UTF-16 code unit) order;
 *   - arrays keep their order (array order is meaningful: `order`, history, …);
 *   - `undefined` object properties are omitted (matching `JSON.stringify`);
 *   - `undefined` inside an array becomes `null` (matching `JSON.stringify`);
 *   - numbers use their shortest round-trip representation (`JSON.stringify`);
 *   - strings are escaped by `JSON.stringify`;
 *   - `NaN`/`±Infinity` are rejected — they are not representable in JSON, and
 *     silently turning them into `null` would hide a corrupt record.
 *
 * The result is a pure function of the VALUE, never of construction history, so
 * `digest(x) === digest(clone(x))` for any structurally equal pair.
 */

/** Raised when a value cannot be represented canonically in JSON. */
export class CanonicalJsonError extends Error {
  /** Dotted path to the offending value. */
  readonly path: string;

  constructor(message: string, path: string) {
    super(`${message} (at ${path || '<root>'})`);
    this.name = 'CanonicalJsonError';
    this.path = path;
  }
}

/**
 * Serialises a value to canonical JSON.
 *
 * @param value any JSON-representable value
 * @returns a string whose bytes are a pure function of `value`
 */
export function canonicalStringify(value: unknown): string {
  const out: string[] = [];
  writeValue(value, '', out);
  return out.join('');
}

function writeValue(value: unknown, path: string, out: string[]): void {
  if (value === null) {
    out.push('null');
    return;
  }

  switch (typeof value) {
    case 'undefined':
      // Only reachable at the root; object properties are skipped by the caller.
      out.push('null');
      return;
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError('Non-finite numbers are not JSON-representable', path);
      }
      out.push(JSON.stringify(value));
      return;
    case 'string':
      out.push(JSON.stringify(value));
      return;
    case 'bigint':
      throw new CanonicalJsonError('BigInt is not JSON-representable', path);
    case 'function':
    case 'symbol':
      throw new CanonicalJsonError(`A ${typeof value} is not JSON-representable`, path);
    default:
      break;
  }

  if (Array.isArray(value)) {
    out.push('[');
    for (let i = 0; i < value.length; i += 1) {
      if (i > 0) out.push(',');
      const item = value[i];
      // `JSON.stringify` renders an `undefined` array slot as `null`; match it so
      // the canonical form round-trips through a JSON parser unchanged.
      if (item === undefined) {
        out.push('null');
      } else {
        writeValue(item, `${path}[${i}]`, out);
      }
    }
    out.push(']');
    return;
  }

  // Plain object: emit keys in ascending order for a construction-independent form.
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  out.push('{');
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (i > 0) out.push(',');
    out.push(JSON.stringify(key), ':');
    writeValue(record[key], path ? `${path}.${key}` : key, out);
  }
  out.push('}');
}

/**
 * The integrity digest of a value: `sha256` over its canonical JSON bytes.
 *
 * Pure & synchronous, so it can be used inside tests and outside any Dexie
 * transaction. Uses the project's existing SHA-256 implementation, so the digest
 * matches `sha256sum` / `crypto.subtle` for the same bytes.
 */
export function computeIntegrity(value: unknown): TransferIntegrity {
  const canonical = canonicalStringify(value);
  return { algorithm: 'sha256', digest: sha256Hex(canonical) };
}

/**
 * Whether `value` still matches the supplied integrity digest.
 *
 * Recomputes the digest rather than trusting the stored one; a package whose
 * records were edited after export therefore fails this check even though the
 * digest field itself is still well-formed.
 */
export function verifyIntegrity(value: unknown, expected: TransferIntegrity): boolean {
  return computeIntegrity(value).digest === expected.digest;
}
