import type { AiGenerationResult, AiHttpRequest, AiProviderType, AiRequestContext } from '@/types';
import { AiError } from '../ai-errors';
import { ProviderAdapter } from '../provider-adapter';
import { applyCustomHeaders } from './openai-adapter';

/**
 * Google Gemini Generative Language adapter.
 *
 * Deliberately NOT reusing the OpenAI adapter: Gemini uses a model-in-path
 * endpoint, the `x-goog-api-key` header, `system_instruction`, `contents` with
 * `parts`, and `generationConfig` for sampling parameters.
 *
 * Endpoint: `{baseUrl}/models/{model}:generateContent`
 * Auth:     `x-goog-api-key: <key>`
 */
export class GeminiAdapter extends ProviderAdapter {
  readonly type: AiProviderType = 'gemini';
  readonly defaultBaseUrl = 'https://generativelanguage.googleapis.com/v1beta';
  readonly label = 'Google Gemini';
  protected readonly supportsTemperature = true;

  buildRequest(context: AiRequestContext): AiHttpRequest {
    const base = this.resolveUrl(context.provider.baseUrl);
    if (!/^https?:\/\//i.test(base)) {
      throw new AiError('config', 'The endpoint URL is invalid.', {
        hint: 'Enter a full base URL starting with https:// (e.g. https://generativelanguage.googleapis.com/v1beta).',
      });
    }

    const model = context.model.trim();
    if (!model) {
      throw new AiError('config', 'A Gemini model ID is required.', {
        hint: 'Enter the model, e.g. gemini-2.0-flash.',
      });
    }

    // Gemini wants the system prompt in `system_instruction`, not in contents.
    const system = context.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n')
      .trim();

    const contents = context.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        // Gemini uses `model` rather than `assistant` for the AI turn.
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }],
      }));

    if (contents.length === 0) {
      throw new AiError('config', 'Gemini requires at least one user message.', {
        hint: 'Provide a prompt to send.',
      });
    }

    const generationConfig: Record<string, unknown> = {
      maxOutputTokens: context.params.maxTokens,
    };
    if (this.supportsTemperature) generationConfig.temperature = context.params.temperature;

    const body: Record<string, unknown> = {
      contents,
      generationConfig,
    };
    if (system) body.system_instruction = { parts: [{ text: system }] };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-goog-api-key': context.provider.apiKey,
    };
    applyCustomHeaders(headers, context.provider.customHeaders);

    return {
      url: `${base}/models/${encodeURIComponent(model)}:generateContent`,
      method: 'POST',
      headers,
      body,
    };
  }

  parseResponse(json: unknown): AiGenerationResult {
    const record = json && typeof json === 'object' ? (json as Record<string, unknown>) : null;
    const candidates = record?.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) {
      // Gemini reports safety blocks as a promptFeedback with no candidates.
      const blockReason = this.extractBlockReason(record);
      if (blockReason) {
        throw new AiError('empty', `Gemini blocked the response (${blockReason}).`, {
          hint: 'Rephrase the prompt or lower the temperature. Safety filters blocked this request.',
        });
      }
      throw new AiError('parse', 'The provider returned no candidates.', {
        hint: 'This endpoint may not speak the Gemini generateContent API.',
      });
    }

    const first = candidates[0] && typeof candidates[0] === 'object' ? (candidates[0] as Record<string, unknown>) : null;
    const content = first?.content && typeof first.content === 'object' ? (first.content as Record<string, unknown>) : null;
    const parts = Array.isArray(content?.parts) ? content!.parts : [];

    const text = parts
      .map((part) => (part && typeof part === 'object' ? (part as Record<string, unknown>) : null))
      .filter((part): part is Record<string, unknown> => part !== null)
      .filter((part) => typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('');

    if (!text.trim()) {
      throw new AiError('empty', 'The model returned an empty response.', {
        hint: 'Try again, raise max output tokens, or check the model ID.',
      });
    }

    const usageRecord = record?.usageMetadata && typeof record.usageMetadata === 'object'
      ? (record.usageMetadata as Record<string, unknown>)
      : null;
    const promptTokens = typeof usageRecord?.promptTokenCount === 'number' ? usageRecord.promptTokenCount : undefined;
    const completionTokens = typeof usageRecord?.candidatesTokenCount === 'number' ? usageRecord.candidatesTokenCount : undefined;
    const totalTokens = typeof usageRecord?.totalTokenCount === 'number' ? usageRecord.totalTokenCount : undefined;

    return {
      content: text,
      finishReason: typeof first?.finishReason === 'string' ? first.finishReason : undefined,
      usage:
        promptTokens === undefined && completionTokens === undefined && totalTokens === undefined
          ? undefined
          : { promptTokens, completionTokens, totalTokens },
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

  private extractBlockReason(record: Record<string, unknown> | null): string | undefined {
    if (!record) return undefined;
    const feedback = record.promptFeedback;
    if (feedback && typeof feedback === 'object') {
      const reason = (feedback as Record<string, unknown>).blockReason;
      if (typeof reason === 'string') return reason;
    }
    return undefined;
  }
}
