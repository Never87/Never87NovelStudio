import type { AiGenerationResult, AiHttpRequest, AiProviderType, AiRequestContext } from '@/types';
import { AiError } from '../ai-errors';
import { ProviderAdapter } from '../provider-adapter';
import { applyCustomHeaders } from './openai-adapter';

/**
 * Anthropic Messages API adapter.
 *
 * Deliberately NOT reusing the OpenAI adapter: Anthropic differs in endpoint,
 * auth header, the `anthropic-version` requirement, the system-prompt location
 * (a top-level `system` field, not a message) and the response shape.
 *
 * Endpoint: `{baseUrl}/messages`
 * Auth:     `x-api-key: <key>` plus `anthropic-version`
 *
 * Browser caveat: Anthropic's API does not send permissive CORS headers for
 * browser origins, so a direct browser call typically fails with a network/CORS
 * error. We surface that honestly (`kind: 'cors'` in the transport) instead of
 * pretending the connection succeeded. A backend proxy would be required for
 * real browser use; GitHub Pages is static and provides none.
 */
export class AnthropicAdapter extends ProviderAdapter {
  readonly type: AiProviderType = 'anthropic';
  readonly defaultBaseUrl = 'https://api.anthropic.com/v1';
  readonly label = 'Anthropic';
  protected readonly supportsTemperature = true;

  /** Required version header; Anthropic rejects requests without it. */
  static readonly API_VERSION = '2023-06-01';

  buildRequest(context: AiRequestContext): AiHttpRequest {
    const url = `${this.resolveUrl(context.provider.baseUrl)}/messages`;
    if (!/^https?:\/\//i.test(url)) {
      throw new AiError('config', 'The endpoint URL is invalid.', {
        hint: 'Enter a full base URL starting with https:// (e.g. https://api.anthropic.com/v1).',
      });
    }

    // Anthropic wants the system prompt OUT of the messages array.
    const system = context.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n')
      .trim();

    const messages = context.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({ role: message.role, content: message.content }));

    if (messages.length === 0) {
      throw new AiError('config', 'Anthropic requires at least one user message.', {
        hint: 'Provide a prompt to send.',
      });
    }

    const body: Record<string, unknown> = {
      model: context.model,
      max_tokens: context.params.maxTokens,
      messages,
    };
    if (system) body.system = system;
    if (this.supportsTemperature) body.temperature = context.params.temperature;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': context.provider.apiKey,
      'anthropic-version': AnthropicAdapter.API_VERSION,
      // Opt in to browser calls; the server may still refuse via CORS.
      'anthropic-dangerous-direct-browser-access': 'true',
    };
    applyCustomHeaders(headers, context.provider.customHeaders);

    return { url, method: 'POST', headers, body };
  }

  parseResponse(json: unknown): AiGenerationResult {
    const record = json && typeof json === 'object' ? (json as Record<string, unknown>) : null;
    const content = record?.content;
    if (!Array.isArray(content)) {
      throw new AiError('parse', 'The provider returned an unexpected response shape.', {
        hint: 'This endpoint may not speak the Anthropic Messages API.',
      });
    }

    // Concatenate every `text` block; tool/other block types are ignored.
    const text = content
      .map((block) => (block && typeof block === 'object' ? (block as Record<string, unknown>) : null))
      .filter((block): block is Record<string, unknown> => block !== null)
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('');

    if (!text.trim()) {
      throw new AiError('empty', 'The model returned an empty response.', {
        hint: 'Try again, raise max tokens, or check the model ID.',
      });
    }

    const usageRecord = record?.usage && typeof record.usage === 'object' ? (record.usage as Record<string, unknown>) : null;
    const inputTokens = typeof usageRecord?.input_tokens === 'number' ? usageRecord.input_tokens : undefined;
    const outputTokens = typeof usageRecord?.output_tokens === 'number' ? usageRecord.output_tokens : undefined;

    return {
      content: text,
      finishReason: typeof record?.stop_reason === 'string' ? record.stop_reason : undefined,
      usage:
        inputTokens === undefined && outputTokens === undefined
          ? undefined
          : {
              promptTokens: inputTokens,
              completionTokens: outputTokens,
              totalTokens:
                inputTokens !== undefined && outputTokens !== undefined
                  ? inputTokens + outputTokens
                  : undefined,
            },
    };
  }

  protected override extractErrorMessage(body: unknown): string | undefined {
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
    const error = record?.error;
    if (error && typeof error === 'object') {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === 'string') return message;
    }
    return typeof record?.message === 'string' ? record.message : undefined;
  }
}
