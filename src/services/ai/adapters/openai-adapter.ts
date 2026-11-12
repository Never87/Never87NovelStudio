import type { AiGenerationResult, AiHttpRequest, AiProviderType, AiRequestContext } from '@/types';
import { AiError } from '../ai-errors';
import { ProviderAdapter } from '../provider-adapter';

/**
 * OpenAI-compatible Chat Completions adapter.
 *
 * Serves BOTH the `openai` provider type and the `custom` type: a custom
 * endpoint is, by definition in P5, an OpenAI-compatible service reachable at a
 * user-supplied base URL with user-supplied headers. We are explicit that we do
 * NOT implement arbitrary protocols — see `docs/AI_HANDOFF.md`.
 *
 * Endpoint: `{baseUrl}/chat/completions`
 * Auth:     `Authorization: Bearer <key>`
 */
export class OpenAiCompatibleAdapter extends ProviderAdapter {
  readonly type: AiProviderType;
  readonly defaultBaseUrl: string;
  readonly label: string;
  protected readonly supportsTemperature = true;

  constructor(type: 'openai' | 'custom' = 'openai') {
    super();
    this.type = type;
    if (type === 'custom') {
      this.defaultBaseUrl = '';
      this.label = 'OpenAI-compatible endpoint';
    } else {
      this.defaultBaseUrl = 'https://api.openai.com/v1';
      this.label = 'OpenAI';
    }
  }

  buildRequest(context: AiRequestContext): AiHttpRequest {
    const url = `${this.resolveUrl(context.provider.baseUrl)}/chat/completions`;
    if (!/^https?:\/\//i.test(url)) {
      throw new AiError('config', 'The endpoint URL is invalid.', {
        hint: 'Enter a full base URL starting with https:// (e.g. https://api.openai.com/v1).',
      });
    }

    // System prompts are plain messages in this dialect.
    const body: Record<string, unknown> = {
      model: context.model,
      messages: context.messages.map((message) => ({ role: message.role, content: message.content })),
      max_tokens: context.params.maxTokens,
    };
    if (this.supportsTemperature) body.temperature = context.params.temperature;

    return {
      url,
      method: 'POST',
      headers: this.headers(context),
      body,
    };
  }

  parseResponse(json: unknown): AiGenerationResult {
    const record = asRecord(json);
    const choices = record?.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new AiError('parse', 'The provider returned no choices.', {
        hint: 'This service may not be fully OpenAI-compatible. Check your endpoint and model ID.',
      });
    }

    const first = asRecord(choices[0]);
    const message = asRecord(first?.message);
    const content = typeof message?.content === 'string' ? message.content : '';

    if (!content.trim()) {
      // Some "compatible" services answer with `text` instead of `message.content`.
      const text = typeof first?.text === 'string' ? first.text : '';
      if (text.trim()) {
        return { content: text, finishReason: stringOf(first?.finish_reason) };
      }
      throw new AiError('empty', 'The model returned an empty response.', {
        hint: 'Try again, raise the max tokens, or confirm the endpoint speaks Chat Completions.',
      });
    }

    return {
      content,
      finishReason: stringOf(first?.finish_reason),
      usage: parseUsage(record?.usage),
    };
  }

  protected override extractErrorMessage(body: unknown): string | undefined {
    const record = asRecord(body);
    const error = record?.error;
    if (typeof error === 'string') return error;
    const errorRecord = asRecord(error);
    if (errorRecord) {
      const message = stringOf(errorRecord.message);
      if (message) return message;
    }
    return stringOf(record?.message);
  }

  /** Authorization + any user headers, with user headers unable to override auth. */
  private headers(context: AiRequestContext): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${context.provider.apiKey}`,
    };
    applyCustomHeaders(headers, context.provider.customHeaders);
    return headers;
  }
}

/** Merges user headers, skipping ones that would clash with the auth header. */
export function applyCustomHeaders(
  headers: Record<string, string>,
  customHeaders: Array<{ name: string; value: string }>,
): void {
  for (const header of customHeaders) {
    const name = header.name.trim();
    if (!name) continue;
    if (name.toLowerCase() === 'authorization') continue;
    headers[name] = header.value;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseUsage(value: unknown): AiGenerationResult['usage'] {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const promptTokens = numberOrUndefined(usage.prompt_tokens);
  const completionTokens = numberOrUndefined(usage.completion_tokens);
  const totalTokens = numberOrUndefined(usage.total_tokens);
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return { promptTokens, completionTokens, totalTokens };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
