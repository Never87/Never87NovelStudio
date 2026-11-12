import type {
  AiConfigValidation,
  AiGenerationResult,
  AiHttpRequest,
  AiProviderType,
  AiRequestContext,
} from '@/types';
import { AiError } from './ai-errors';
import { redactForError } from './redaction';

/**
 * Provider Adapter contract (P5).
 *
 * Each supported protocol (OpenAI-compatible, Anthropic, Gemini) is implemented
 * by exactly one Adapter. The Adapter owns EVERYTHING protocol-specific:
 *
 *   - the default endpoint,
 *   - request shape (body layout, message roles, system-prompt handling),
 *   - authentication headers,
 *   - which parameters the protocol accepts,
 *   - response parsing and provider error parsing.
 *
 * The shared `AiTransport` owns what is protocol-independent: timeouts, aborts,
 * network/CORS failures. `AiService` owns model resolution and orchestration.
 * No React component ever builds a request or knows a provider exists.
 *
 * Adding a provider therefore means adding ONE file that subclasses this class —
 * not adding `if (provider === …)` branches across the codebase.
 */
export abstract class ProviderAdapter {
  /** The protocol this adapter implements. */
  abstract readonly type: AiProviderType;

  /** Endpoint used when the provider has no explicit `baseUrl`. */
  abstract readonly defaultBaseUrl: string;

  /**
   * Whether the protocol accepts a `temperature` parameter.
   *
   * Not every model accepts every parameter, so capability is declared here and
   * the Adapter omits unsupported keys rather than sending them blindly.
   */
  protected abstract readonly supportsTemperature: boolean;

  /** Human label used in validation messages. */
  abstract readonly label: string;

  /**
   * Validates a provider configuration WITHOUT any network access.
   *
   * Used before saving and before a connection test, so the user gets a precise
   * problem list instead of an opaque HTTP failure.
   */
  validateConfig(provider: AiRequestContext['provider']): AiConfigValidation {
    const problems: string[] = [];

    const baseUrl = (provider.baseUrl || this.defaultBaseUrl).trim();
    if (!baseUrl) {
      problems.push(`${this.label} requires a base URL.`);
    } else if (!/^https?:\/\//i.test(baseUrl)) {
      problems.push('The base URL must start with http:// or https://');
    }

    if (!provider.apiKey.trim()) {
      problems.push(`${this.label} requires an API key.`);
    }

    for (const header of provider.customHeaders) {
      if (!header.name.trim()) {
        problems.push('Custom headers must all have a name.');
        break;
      }
      // Reject an attempt to override auth via a custom header; it would either
      // leak the wrong key or silently lose to our own header.
      const lower = header.name.trim().toLowerCase();
      if (lower === 'authorization' || (this.type === 'anthropic' && lower === 'x-api-key')) {
        problems.push(
          `Do not set "${header.name}" as a custom header — the API key is applied automatically.`,
        );
        break;
      }
    }

    return { ok: problems.length === 0, problems };
  }

  /**
   * Builds the HTTP request this protocol requires.
   *
   * Pure and synchronous: it performs no I/O, which is what makes request
   * construction directly unit-testable without a network or a mock server.
   * Throws `AiError('config')` when the context cannot form a valid request.
   */
  abstract buildRequest(context: AiRequestContext): AiHttpRequest;

  /**
   * Parses a successful (2xx) JSON body into the shared result shape.
   *
   * Throws `AiError('parse')` for a malformed body and `AiError('empty')` when
   * the provider returned no usable text — an empty delta is never treated as a
   * successful generation.
   */
  abstract parseResponse(json: unknown): AiGenerationResult;

  /**
   * Converts a non-2xx response body into a precise `AiError`.
   *
   * The status mapping (401 → auth, 404 → model, 429 → rate-limit) is shared,
   * while extracting the provider's own message is protocol-specific.
   *
   * SECURITY: the provider error text is UNTRUSTED — a misconfigured or
   * malicious endpoint could echo the API key (in a URL, a header echo, or the
   * message). Every value that reaches `AiError.detail` is therefore run through
   * `redactForError` with the request's own secrets plus credential-shaped
   * patterns, so the key never surfaces in the error, the UI, or a log.
   *
   * @param secrets API key and custom-header values of the request that failed,
   *                scrubbed verbatim in addition to pattern-based redaction.
   */
  parseError(status: number, body: unknown, rawText: string, secrets: string[] = []): AiError {
    const rawMessage = this.extractErrorMessage(body) ?? rawText.slice(0, 300).trim();
    const providerMessage = redactForError(rawMessage, secrets);

    if (status === 401 || status === 403) {
      return new AiError('auth', `Authentication failed (${status}).`, {
        status,
        hint: 'Check that the API key is correct, active and allowed to use this model.',
        detail: providerMessage,
      });
    }
    if (status === 404) {
      return new AiError('model', `Not found (404).`, {
        status,
        hint: 'The model ID or endpoint path may be wrong. Verify the model ID and base URL.',
        detail: providerMessage,
      });
    }
    if (status === 429) {
      return new AiError('rate-limit', 'Rate limit or quota exceeded (429).', {
        status,
        hint: 'Wait a moment, check your billing/quota, or pick a different model.',
        detail: providerMessage,
      });
    }
    if (status >= 400 && status < 500) {
      return new AiError('http', `Request rejected (${status}).`, {
        status,
        hint: 'The provider rejected the request parameters. Check the model settings.',
        detail: providerMessage,
      });
    }
    if (status >= 500) {
      return new AiError('http', `The provider returned a server error (${status}).`, {
        status,
        hint: 'This is usually temporary on the provider side. Retry in a moment.',
        detail: providerMessage,
      });
    }
    return new AiError('http', `Unexpected response (${status}).`, { status, detail: providerMessage });
  }

  /** Resolves the endpoint, honouring an explicit `baseUrl` override. */
  protected resolveUrl(baseUrl: string): string {
    return (baseUrl.trim() || this.defaultBaseUrl).replace(/\/+$/, '');
  }

  /**
   * Extracts a human message from a provider error body.
   *
   * Shared default covers the common `{ error: { message } }` and
   * `{ error: "…" }` shapes; adapters override for their own format.
   */
  protected extractErrorMessage(body: unknown): string | undefined {
    if (!body || typeof body !== 'object') return undefined;
    const record = body as Record<string, unknown>;
    const error = record.error;
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object') {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === 'string') return message;
    }
    const message = record.message;
    return typeof message === 'string' ? message : undefined;
  }
}
