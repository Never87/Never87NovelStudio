import type { AiProviderType } from '@/types';
import type { ProviderAdapter } from './provider-adapter';
import { AnthropicAdapter } from './adapters/anthropic-adapter';
import { GeminiAdapter } from './adapters/gemini-adapter';
import { OpenAiCompatibleAdapter } from './adapters/openai-adapter';

/**
 * Adapter registry — the ONLY place that maps a provider type to an Adapter.
 *
 * `AiService` and the UI look adapters up here; they never `switch` on provider
 * type themselves. Adding a protocol is therefore: write one Adapter class and
 * register it below. `custom` reuses the OpenAI-compatible protocol by design
 * (documented limitation, not an oversight).
 */
const REGISTRY: Record<AiProviderType, () => ProviderAdapter> = {
  openai: () => new OpenAiCompatibleAdapter('openai'),
  custom: () => new OpenAiCompatibleAdapter('custom'),
  anthropic: () => new AnthropicAdapter(),
  gemini: () => new GeminiAdapter(),
};

/** Returns the adapter for a provider type. */
export function getAdapter(type: AiProviderType): ProviderAdapter {
  return REGISTRY[type]();
}

/** Every provider type that has an adapter (for UI pickers and validation). */
export function supportedProviderTypes(): AiProviderType[] {
  return Object.keys(REGISTRY) as AiProviderType[];
}
