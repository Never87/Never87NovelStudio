import { useState } from 'react';
import { Plus, SlidersHorizontal, Star, Trash2 } from 'lucide-react';
import { Badge, Button, Card, EmptyState, IconButton, PageHeader } from '@/components/ui';
import type { AiModel, AiProvider, AiTaskKind } from '@/types';
import { AI_TASK_KINDS } from '@/types';
import { TASK_PROMPTS } from '@/services';
import { useAiConfig } from '@/hooks';
import { cn } from '@/utils/cn';
import { ModelFormDialog } from './components/ModelFormDialog';
import { Select, Toggle } from './components/fields';

/**
 * Model Configuration (P5).
 *
 * Three sections: the global default, per-task assignments, and the model list
 * with parameters. Every mutation goes through `useAiConfig`, so the service's
 * invariants (one default per provider, cleanup on delete) are always applied.
 */
export function ModelConfigurationPanel() {
  const {
    providers,
    models,
    status,
    loading,
    globalDefaultModelId,
    taskModels,
    createModel,
    updateModel,
    setModelEnabled,
    setProviderDefaultModel,
    deleteModel,
    setGlobalDefaultModel,
    setTaskModel,
  } = useAiConfig();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AiModel | null>(null);
  const [presetProviderId, setPresetProviderId] = useState<string | undefined>(undefined);

  const providerName = (providerId: string) => providers.find((provider) => provider.id === providerId)?.name ?? 'Unknown provider';
  const modelLabel = (modelId: string) => {
    const model = models.find((candidate) => candidate.id === modelId);
    return model ? `${model.displayName} · ${providerName(model.providerId)}` : 'Unknown model';
  };

  const openCreate = (providerId?: string) => {
    setEditing(null);
    setPresetProviderId(providerId);
    setFormOpen(true);
  };
  const openEdit = (model: AiModel) => {
    setEditing(model);
    setPresetProviderId(model.providerId);
    setFormOpen(true);
  };

  const grouped: Array<{ provider: AiProvider; models: AiModel[] }> = providers.map((provider) => ({
    provider,
    models: models.filter((model) => model.providerId === provider.id),
  }));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Model Configuration"
        description="Choose the default model, assign models per AI task, and tune parameters."
        actions={
          <Button
            variant="primary"
            size="sm"
            iconLeft={<Plus className="size-4" />}
            onClick={() => openCreate()}
            disabled={providers.length === 0}
          >
            Add model
          </Button>
        }
      />

      {providers.length === 0 ? (
        <EmptyState
          icon={<SlidersHorizontal className="size-5" aria-hidden />}
          title="Add a provider first"
          description="Models belong to a provider. Create a provider in Provider Management, then add models here."
        />
      ) : null}

      {status === 'loading' || loading ? (
        <Card padding="lg">
          <p className="text-subtle text-xs" role="status">
            Loading models…
          </p>
        </Card>
      ) : null}

      {providers.length > 0 && models.length === 0 && status !== 'loading' ? (
        <EmptyState
          icon={<SlidersHorizontal className="size-5" aria-hidden />}
          title="No models yet"
          description="Add at least one model to a provider to start using AI features."
          action={
            <Button variant="primary" size="sm" iconLeft={<Plus className="size-4" />} onClick={() => openCreate()}>
              Add your first model
            </Button>
          }
        />
      ) : null}

      {models.length > 0 ? (
        <>
          <Card padding="md">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-ink text-sm font-semibold">Global default model</h2>
                <p className="text-muted mt-0.5 text-xs">
                  Used by any task that has no model assigned. Changes apply to the next request.
                </p>
              </div>
              <div className="w-full sm:w-72">
                <Select
                  aria-label="Global default model"
                  value={globalDefaultModelId ?? ''}
                  onChange={(event) => void setGlobalDefaultModel(event.target.value || null)}
                >
                  <option value="">No default</option>
                  {models.map((model) => (
                    <option key={model.id} value={model.id} disabled={!model.enabled}>
                      {model.displayName} · {providerName(model.providerId)}
                      {model.enabled ? '' : ' (disabled)'}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          </Card>

          <Card padding="md">
            <h2 className="text-ink text-sm font-semibold">Per-task models</h2>
            <p className="text-muted mt-0.5 mb-3 text-xs">
              Unassigned tasks fall back to the global default. If the default is unavailable, generation
              stops with an explicit message rather than silently choosing another model.
            </p>
            <ul className="divide-line divide-y">
              {AI_TASK_KINDS.map((task) => (
                <li key={task} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <p className="text-ink text-xs font-medium">{TASK_PROMPTS[task].label}</p>
                    <p className="text-subtle text-2xs">{TASK_PROMPTS[task].description}</p>
                  </div>
                  <div className="w-full sm:w-64">
                    <Select
                      aria-label={`Model for ${TASK_PROMPTS[task].label}`}
                      value={taskModels[task] ?? ''}
                      onChange={(event) => void setTaskModel(task as AiTaskKind, event.target.value || null)}
                    >
                      <option value="">Use global default</option>
                      {models.map((model) => (
                        <option key={model.id} value={model.id} disabled={!model.enabled}>
                          {model.displayName} · {providerName(model.providerId)}
                        </option>
                      ))}
                    </Select>
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          <div className="space-y-3">
            <h2 className="text-ink text-sm font-semibold">Models</h2>
            {grouped.map(({ provider, models: providerModels }) => (
              <div key={provider.id} className="space-y-2">
                <div className="flex items-center gap-2">
                  <p className="text-subtle text-2xs font-medium uppercase tracking-wide">{provider.name}</p>
                  <Button
                    variant="ghost"
                    size="sm"
                    iconLeft={<Plus className="size-3" />}
                    onClick={() => openCreate(provider.id)}
                  >
                    Add
                  </Button>
                </div>
                {providerModels.length === 0 ? (
                  <p className="text-subtle text-2xs italic">No models for this provider.</p>
                ) : (
                  providerModels.map((model) => (
                    <Card key={model.id} padding="sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-ink truncate text-sm font-medium">{model.displayName}</span>
                            {model.isDefault ? (
                              <Badge tone="accent" size="sm">
                                <Star className="mr-0.5 size-2.5" aria-hidden />
                                Provider default
                              </Badge>
                            ) : null}
                            {!model.enabled ? (
                              <Badge tone="neutral" size="sm">
                                Disabled
                              </Badge>
                            ) : null}
                          </div>
                          <p className="text-subtle mt-0.5 font-mono text-2xs">{model.modelId}</p>
                          <p className="text-subtle text-2xs">
                            temp {model.temperature} · {model.maxTokens} tokens · {(model.timeout / 1000).toFixed(0)}s timeout
                            {model.contextWindowTokens != null
                              ? ` · ${model.contextWindowTokens.toLocaleString()} ctx window`
                              : ' · ctx window unknown'}
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Toggle
                            checked={model.enabled}
                            onChange={(next) => void setModelEnabled(model.id, next)}
                            label={`${model.enabled ? 'Disable' : 'Enable'} ${model.displayName}`}
                          />
                          {!model.isDefault ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => void setProviderDefaultModel(model.providerId, model.id)}
                            >
                              Set default
                            </Button>
                          ) : null}
                          <Button variant="ghost" size="sm" onClick={() => openEdit(model)}>
                            Edit
                          </Button>
                          <IconButton
                            variant="ghost"
                            label={`Delete ${model.displayName}`}
                            icon={<Trash2 className="size-3.5" aria-hidden />}
                            onClick={() => {
                              if (window.confirm(`Delete "${model.displayName}"? Tasks using it will fall back to the default.`)) {
                                void deleteModel(model.id);
                              }
                            }}
                          />
                        </div>
                      </div>
                    </Card>
                  ))
                )}
              </div>
            ))}
            {globalDefaultModelId ? (
              <p className={cn('text-subtle text-2xs')}>Global default: {modelLabel(globalDefaultModelId)}</p>
            ) : null}
          </div>
        </>
      ) : null}

      <ModelFormDialog
        open={formOpen}
        model={editing}
        providers={providers}
        defaultProviderId={presetProviderId}
        onClose={() => setFormOpen(false)}
        onSubmit={async (values) => {
          const timeout = Math.round(values.timeoutSeconds * 1000);
          if (editing) {
            await updateModel(editing.id, {
              modelId: values.modelId,
              displayName: values.displayName,
              temperature: values.temperature,
              maxTokens: values.maxTokens,
              contextWindowTokens: values.contextWindowTokens,
              timeout,
              isDefault: values.isDefault,
              enabled: values.enabled,
            });
          } else {
            await createModel({
              providerId: values.providerId,
              modelId: values.modelId,
              displayName: values.displayName,
              temperature: values.temperature,
              maxTokens: values.maxTokens,
              contextWindowTokens: values.contextWindowTokens,
              timeout,
              isDefault: values.isDefault,
              enabled: values.enabled,
            });
          }
        }}
      />
    </div>
  );
}
