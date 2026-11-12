import type { AiGenerationResult, AiHttpRequest } from '@/types';
import { AiError } from './ai-errors';
import type { ProviderAdapter } from './provider-adapter';

/** Parsed-but-not-interpreted HTTP outcome handed to the adapter. */
export interface AiHttpOutcome {
  status: number;
  ok: boolean;
  json: unknown;
  text: string;
}

/**
 * The one and only place a network request is performed (P5).
 *
 * Protocol-independent concerns live here:
 *   - a real `AbortController` timeout (not just a promise race, so the request
 *     is actually cancelled and the socket freed),
 *   - cooperative cancellation via a caller-supplied `AbortSignal`,
 *   - normalising network/CORS failures into precise `AiError`s.
 *
 * Protocol-specific concerns (URL, headers, body, parsing) are delegated to the
 * adapter, so this stays small and provider-agnostic.
 *
 * Testability: `fetch` and `setTimeout` are injectable so unit tests never hit
 * the network and control time deterministically.
 */
export interface AiTransportDeps {
  fetchImpl?: typeof fetch;
}

export class AiTransport {
  private readonly fetchImpl: typeof fetch;

  constructor(deps: AiTransportDeps = {}) {
    // `fetch` is bound so passing the global later still has its receiver.
    this.fetchImpl = deps.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  }

  /**
   * Performs one generation request end to end and returns the parsed result.
   *
   * @param adapter     protocol implementation for this provider
   * @param request     already-built HTTP request
   * @param timeoutMs   hard timeout; the request is aborted when it elapses
   * @param signal      optional caller cancellation (e.g. the user pressed Stop)
   */
  async generate(
    adapter: ProviderAdapter,
    request: AiHttpRequest,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<AiGenerationResult> {
    const outcome = await this.send(request, options);
    if (!outcome.ok) {
      throw adapter.parseError(outcome.status, outcome.json, outcome.text, headerSecrets(request.headers));
    }
    return adapter.parseResponse(outcome.json);
  }

  /** Performs a cheap request used by "test connection". */
  async ping(
    adapter: ProviderAdapter,
    request: AiHttpRequest,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<void> {
    const outcome = await this.send(request, options);
    if (!outcome.ok) {
      throw adapter.parseError(outcome.status, outcome.json, outcome.text, headerSecrets(request.headers));
    }
    // A successful ping only needs to prove the endpoint accepted the request
    // and returned usable JSON; it does not need a full generation.
  }

  /** Raw send: owns timeouts, aborts and network error normalization. */
  private async send(
    request: AiHttpRequest,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<AiHttpOutcome> {
    const controller = new AbortController();
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.max(1, options.timeoutMs));

    // Forward an external cancel into our controller so both paths abort the
    // same underlying request.
    const onExternalAbort = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) {
        clearTimeout(timer);
        throw new AiError('aborted', 'The request was cancelled.');
      }
      options.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    let response: Response;
    try {
      response = await this.fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onExternalAbort);
      throw this.toTransportError(error, { timedOut, externalAborted: options.signal?.aborted ?? false });
    }

    // Read the body defensively: a provider may return non-JSON on errors.
    const text = await response.text().catch(() => '');
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);

    let json: unknown = undefined;
    if (text.trim()) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }

    return { status: response.status, ok: response.ok, json, text };
  }

  /**
   * Maps a thrown fetch error to an `AiError`.
   *
   * A rejected `fetch` in the browser is almost always one of: the user
   * cancelled ("aborted"), the timeout fired, or the request never left the
   * browser because of CORS / offline. We distinguish these because the fix is
   * different for each — and we never claim a CORS failure is a server error.
   */
  private toTransportError(
    error: unknown,
    state: { timedOut: boolean; externalAborted: boolean },
  ): AiError {
    if (state.externalAborted) {
      return new AiError('aborted', 'The request was cancelled.');
    }
    if (state.timedOut) {
      return new AiError('timeout', 'The request timed out.', {
        hint: 'Increase the timeout in the model settings, or check that the endpoint is reachable.',
      });
    }
    if (isAbortError(error)) {
      return new AiError('aborted', 'The request was cancelled.');
    }

    // `TypeError: Failed to fetch` is the browser's opaque signal for a network
    // failure — most often CORS in a static, backend-less deployment.
    const message = error instanceof Error ? error.message : String(error);
    if (/failed to fetch|networkerror|load failed/i.test(message)) {
      return new AiError('cors', 'The request could not reach the provider.', {
        hint:
          'This is usually a CORS or network problem. The provider may not allow direct browser calls, or the base URL is wrong. GitHub Pages has no backend proxy.',
        detail: message,
        cause: error,
      });
    }

    return new AiError('network', 'A network error occurred.', {
      hint: 'Check your connection and the base URL, then try again.',
      detail: message,
      cause: error,
    });
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

/**
 * Header names whose values are safe to leave in diagnostics and must NOT be
 * treated as secrets (they are protocol constants, not credentials).
 */
const NON_SECRET_HEADERS = new Set([
  'content-type',
  'anthropic-version',
  'anthropic-dangerous-direct-browser-access',
  'accept',
]);

/**
 * Extracts the credential values from a request's headers so provider error
 * bodies can be scrubbed of them before being shown or logged.
 *
 * We treat every header value that is NOT a known protocol constant as a
 * potential secret. This deliberately over-includes custom headers: a user may
 * put an API key or token in a custom header, and any echoed header value is
 * exactly the kind of leak this guards against. Authorization's `Bearer `
 * prefix is stripped so the bare key is matched too, while the full value is
 * still included for the pattern pass.
 */
function headerSecrets(headers: Record<string, string>): string[] {
  const secrets: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (!value || NON_SECRET_HEADERS.has(name.toLowerCase())) continue;
    secrets.push(value);
    const bearer = /^bearer\s+(.+)$/i.exec(value.trim());
    if (bearer) secrets.push(bearer[1]);
  }
  return secrets;
}
