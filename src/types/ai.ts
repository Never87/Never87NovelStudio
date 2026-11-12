import type { AiProviderType } from '@/schemas/ai';

/**
 * AI request/response contracts shared by Adapters and services (P5).
 *
 * These are TRANSPORT types, not persisted records: nothing here is stored in
 * the database. They are the stable boundary that lets the UI and the AI
 * service speak one language regardless of which provider protocol is used.
 */

/** A single chat message. */
export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Parameters a caller may request for a generation. */
export interface AiGenerationParams {
  temperature: number;
  maxTokens: number;
}

/** Everything an adapter needs to build and authenticate a request. */
export interface AiRequestContext {
  /** The resolved provider configuration (contains the secret key). */
  provider: {
    providerType: AiProviderType;
    baseUrl: string;
    apiKey: string;
    customHeaders: Array<{ name: string; value: string }>;
  };
  /** The provider-side model id. */
  model: string;
  messages: AiMessage[];
  params: AiGenerationParams;
}

/** A parsed, provider-agnostic generation result. */
export interface AiGenerationResult {
  /** The assistant's reply text. */
  content: string;
  /**
   * Token usage when the provider reports it. Never fabricated: omitted when
   * the provider does not return usage.
   */
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  /** Provider-reported finish reason, verbatim where available. */
  finishReason?: string;
}

/**
 * A raw HTTP request description produced by an Adapter.
 *
 * Splitting "build request" from "perform request" keeps every protocol's
 * quirks inside its Adapter while the shared transport owns timeouts, aborts
 * and network errors.
 */
export interface AiHttpRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Error categories surfaced to the user.
 *
 * Chosen so the UI can offer actionable guidance ("check your API key") instead
 * of dumping a raw stack. Never carries the secret.
 */
export type AiErrorKind =
  | 'config'
  | 'auth'
  | 'model'
  | 'rate-limit'
  | 'timeout'
  | 'aborted'
  | 'network'
  | 'cors'
  | 'http'
  | 'parse'
  | 'empty';

/** Result of validating a provider configuration before any network call. */
export interface AiConfigValidation {
  ok: boolean;
  problems: string[];
}
