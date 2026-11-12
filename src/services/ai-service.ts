import type {
  AiGenerationResult,
  AiMessage,
  AiModel,
  AiProvider,
  AiTaskKind,
} from '@/types';
import { AiRepository } from '@/repositories/ai-repository';
import { AiConfigNotFoundError } from './ai-config-service';
import { getAdapter } from './ai/adapter-registry';
import { AiError } from './ai/ai-errors';
import { AiTransport, type AiTransportDeps } from './ai/ai-transport';

/** A fully-resolved (provider + model) pair ready to run a request. */
export interface ResolvedAiTarget {
  provider: AiProvider;
  model: AiModel;
  /** How the target was chosen — used for diagnostics and UI messaging. */
  source: 'explicit' | 'task' | 'global';
}

/** Options for a single generation call. */
export interface GenerateOptions {
  task: AiTaskKind;
  messages: AiMessage[];
  /** Explicit model id; when omitted, the task/global fallback chain is used. */
  modelId?: string;
  /** Override temperature / maxTokens for this call only. */
  temperature?: number;
  maxTokens?: number;
  /** Caller cancellation (e.g. the user pressed Stop). */
  signal?: AbortSignal;
}

/** Deps for tests: inject a fake transport and/or a fake repository. */
export interface AiServiceDeps extends AiTransportDeps {
  repository?: AiRepository;
  transport?: AiTransport;
}

/**
 * AI runtime service (P5) — the single entry point for generation.
 *
 * Responsibilities:
 *   - Resolve WHICH provider+model to use (explicit → task → global default),
 *     refusing loudly instead of silently substituting another model.
 *   - Validate that provider and model are usable (exist, enabled) with clear
 *     errors.
 *   - Delegate protocol details to the Adapter and I/O to the Transport.
 *
 * It never touches React and never builds a provider-specific request; that is
 * the Adapter's job. All calls re-read config from the database, so a model
 * change takes effect on the very next request.
 */
export class AiService {
  private readonly repository: AiRepository;
  private readonly transport: AiTransport;

  constructor(deps: AiServiceDeps = {}) {
    this.repository = deps.repository ?? new AiRepository();
    this.transport = deps.transport ?? new AiTransport({ fetchImpl: deps.fetchImpl });
  }

  /**
   * Resolves the model to use for a task.
   *
   * Order: explicit `modelId` → task assignment → global default. When none is
   * configured we throw `AiConfigError`-style `AiError('config')` naming the
   * missing step — we NEVER quietly fall back to some other model.
   */
  async resolveTarget(task: AiTaskKind, explicitModelId?: string): Promise<ResolvedAiTarget> {
    let modelId = explicitModelId ?? null;
    let source: ResolvedAiTarget['source'] = explicitModelId ? 'explicit' : 'task';

    if (!modelId) {
      const [taskRows, global] = await Promise.all([
        this.repository.listTaskConfigs(),
        this.repository.getGlobalConfig(),
      ]);
      const row = taskRows.find((candidate) => candidate.task === task);
      if (row?.modelId) {
        modelId = row.modelId;
        source = 'task';
      } else if (global?.defaultModelId) {
        modelId = global.defaultModelId;
        source = 'global';
      }
    }

    if (!modelId) {
      throw new AiError('config', 'No AI model is configured for this task.', {
        hint: 'Open Settings → Model Configuration and set a default model, or assign one to this task.',
      });
    }

    const model = await this.repository.getModel(modelId);
    if (!model) {
      // The referenced model was deleted without being cleaned up.
      throw new AiError('model', 'The configured model no longer exists.', {
        hint: 'Pick another model in Settings → Model Configuration.',
      });
    }
    if (!model.enabled) {
      throw new AiError('model', `The model "${model.displayName}" is disabled.`, {
        hint: 'Enable it, or assign an enabled model to this task in Settings.',
      });
    }

    const provider = await this.repository.getProvider(model.providerId);
    if (!provider) {
      throw new AiError('config', 'The model’s provider no longer exists.', {
        hint: 'Re-create the provider in Settings → Provider Management.',
      });
    }
    if (!provider.enabled) {
      throw new AiError('config', `The provider "${provider.name}" is disabled.`, {
        hint: 'Enable the provider in Settings → Provider Management.',
      });
    }

    return { provider, model, source };
  }

  /** Runs a text generation using the resolved target. */
  async generate(options: GenerateOptions): Promise<{
    result: AiGenerationResult;
    target: ResolvedAiTarget;
  }> {
    const target = await this.resolveTarget(options.task, options.modelId);
    const adapter = getAdapter(target.provider.providerType);

    const request = adapter.buildRequest({
      provider: {
        providerType: target.provider.providerType,
        baseUrl: target.provider.baseUrl,
        apiKey: target.provider.apiKey,
        customHeaders: target.provider.customHeaders,
      },
      model: target.model.modelId,
      messages: options.messages,
      params: {
        temperature: options.temperature ?? target.model.temperature,
        maxTokens: options.maxTokens ?? target.model.maxTokens,
      },
    });

    const result = await this.transport.generate(adapter, request, {
      timeoutMs: target.model.timeout,
      signal: options.signal,
    });

    return { result, target };
  }

  /**
   * Tests a provider connection WITHOUT needing a saved model.
   *
   * Uses the provider's own default model (or the first enabled model) to issue
   * a minimal request. Performs no model discovery and spends no quota beyond a
   * tiny completion, which is the honest meaning of "test connection".
   */
  async testConnection(providerId: string, signal?: AbortSignal): Promise<{
    ok: true;
    model: string;
    result: AiGenerationResult;
  }> {
    const provider = await this.repository.getProvider(providerId);
    if (!provider) {
      throw new AiConfigNotFoundError(`AI provider "${providerId}" was not found.`);
    }

    const adapter = getAdapter(provider.providerType);
    const validation = adapter.validateConfig({
      providerType: provider.providerType,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      customHeaders: provider.customHeaders,
    });
    if (!validation.ok) {
      throw new AiError('config', 'The provider configuration is incomplete.', {
        hint: validation.problems.join(' '),
      });
    }

    const models = await this.repository.listModelsByProvider(provider.id);
    const model = models.find((candidate) => candidate.isDefault) ?? models.find((candidate) => candidate.enabled) ?? models[0];
    if (!model) {
      throw new AiError('config', 'This provider has no models yet.', {
        hint: 'Add at least one model to this provider, then test the connection.',
      });
    }

    const request = adapter.buildRequest({
      provider: {
        providerType: provider.providerType,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        customHeaders: provider.customHeaders,
      },
      model: model.modelId,
      messages: [
        { role: 'user', content: 'Reply with the single word: OK' },
      ],
      params: { temperature: 0, maxTokens: 16 },
    });

    const result = await this.transport.generate(adapter, request, {
      timeoutMs: model.timeout,
      signal,
    });

    return { ok: true, model: model.modelId, result };
  }
}
