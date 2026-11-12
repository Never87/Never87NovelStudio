import type { AiErrorKind } from '@/types';

/**
 * A normalized AI failure, safe to log and show.
 *
 * Every adapter and the transport convert their native errors into this single
 * type so the UI can branch on `kind` instead of string-matching provider
 * messages. It NEVER carries an Authorization header or API key — `message`
 * is built from provider error bodies (which do not echo the key) and our own
 * wording.
 */
export class AiError extends Error {
  readonly kind: AiErrorKind;
  /** HTTP status when the failure came from a response. */
  readonly status?: number;
  /** Actionable next step shown under the error in the UI. */
  readonly hint?: string;
  /** Raw provider error text, already redacted of obvious secrets. */
  readonly detail?: string;

  constructor(
    kind: AiErrorKind,
    message: string,
    options: { status?: number; hint?: string; detail?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'AiError';
    this.kind = kind;
    this.status = options.status;
    this.hint = options.hint;
    this.detail = options.detail;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }

  /** True when the user (not a bug) caused this by cancelling. */
  get isAbort(): boolean {
    return this.kind === 'aborted';
  }
}

/** Type guard for callers that only have `unknown`. */
export function isAiError(value: unknown): value is AiError {
  return value instanceof AiError;
}
