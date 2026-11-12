import { useEffect, useState } from 'react';
import { Button } from '@/components/ui';
import type { AiModel, AiProvider } from '@/types';
import { DEFAULT_MAX_TOKENS, DEFAULT_TEMPERATURE, DEFAULT_TIMEOUT_MS } from '@/types';
import { ProjectDialog } from '@/modules/projects/components/ProjectDialog';
import { Field, NumberInput, Select, TextInput } from './fields';

export interface ModelFormDialogProps {
  open: boolean;
  /** Existing model to edit, or null to create. */
  model: AiModel | null;
  providers: AiProvider[];
  /** Provider preselected when creating from a provider row. */
  defaultProviderId?: string;
  onClose: () => void;
  onSubmit: (values: {
    providerId: string;
    modelId: string;
    displayName: string;
    temperature: number;
    maxTokens: number;
    timeoutSeconds: number;
    isDefault: boolean;
    enabled: boolean;
  }) => Promise<void>;
}

/** Create/edit form for a model. */
export function ModelFormDialog({
  open,
  model,
  providers,
  defaultProviderId,
  onClose,
  onSubmit,
}: ModelFormDialogProps) {
  const [providerId, setProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [temperature, setTemperature] = useState(String(DEFAULT_TEMPERATURE));
  const [maxTokens, setMaxTokens] = useState(String(DEFAULT_MAX_TOKENS));
  const [timeoutSeconds, setTimeoutSeconds] = useState(String(DEFAULT_TIMEOUT_MS / 1000));
  const [isDefault, setIsDefault] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setProviderId(model?.providerId ?? defaultProviderId ?? providers[0]?.id ?? '');
    setModelId(model?.modelId ?? '');
    setDisplayName(model?.displayName ?? '');
    setTemperature(String(model?.temperature ?? DEFAULT_TEMPERATURE));
    setMaxTokens(String(model?.maxTokens ?? DEFAULT_MAX_TOKENS));
    setTimeoutSeconds(String((model?.timeout ?? DEFAULT_TIMEOUT_MS) / 1000));
    setIsDefault(model?.isDefault ?? false);
    setEnabled(model?.enabled ?? true);
    setError(null);
  }, [open, model, defaultProviderId, providers]);

  const handleSubmit = async () => {
    setBusy(true);
    setError(null);
    try {
      const parsedTemperature = Number(temperature);
      const parsedMaxTokens = Number(maxTokens);
      const parsedTimeout = Number(timeoutSeconds);
      if (!Number.isFinite(parsedTemperature) || parsedTemperature < 0 || parsedTemperature > 2) {
        throw new Error('Temperature must be between 0 and 2.');
      }
      if (!Number.isInteger(parsedMaxTokens) || parsedMaxTokens < 1) {
        throw new Error('Max tokens must be a positive whole number.');
      }
      if (!Number.isFinite(parsedTimeout) || parsedTimeout < 5 || parsedTimeout > 300) {
        throw new Error('Timeout must be between 5 and 300 seconds.');
      }
      await onSubmit({
        providerId,
        modelId: modelId.trim(),
        displayName: displayName.trim(),
        temperature: parsedTemperature,
        maxTokens: parsedMaxTokens,
        timeoutSeconds: parsedTimeout,
        isDefault,
        enabled,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The model could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ProjectDialog
      open={open}
      title={model ? 'Edit model' : 'Add model'}
      description="Models are added manually. Enter the exact model ID your provider expects."
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void handleSubmit()}
            loading={busy}
            disabled={!providerId || !modelId.trim() || !displayName.trim()}
          >
            {model ? 'Save changes' : 'Add model'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Provider" htmlFor="model-provider" required>
          <Select
            id="model-provider"
            value={providerId}
            onChange={(event) => setProviderId(event.target.value)}
            disabled={busy || Boolean(model)}
          >
            {providers.length === 0 ? <option value="">No providers — add one first</option> : null}
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Model ID" htmlFor="model-model-id" required hint="The exact ID sent to the API, e.g. gpt-4o-mini.">
          <TextInput
            id="model-model-id"
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
            placeholder="gpt-4o-mini"
            disabled={busy}
            className="font-mono"
          />
        </Field>

        <Field label="Display name" htmlFor="model-display-name" required>
          <TextInput
            id="model-display-name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="e.g. GPT-4o mini"
            disabled={busy}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Temperature" htmlFor="model-temperature" hint="0–2. Higher is more creative.">
            <NumberInput
              id="model-temperature"
              value={temperature}
              min={0}
              max={2}
              step={0.1}
              onChange={(event) => setTemperature(event.target.value)}
              disabled={busy}
            />
          </Field>
          <Field label="Max tokens" htmlFor="model-max-tokens" hint="Upper bound on the reply length.">
            <NumberInput
              id="model-max-tokens"
              value={maxTokens}
              min={1}
              step={64}
              onChange={(event) => setMaxTokens(event.target.value)}
              disabled={busy}
            />
          </Field>
        </div>

        <Field label="Timeout (seconds)" htmlFor="model-timeout" hint="Requests longer than this are cancelled.">
          <NumberInput
            id="model-timeout"
            value={timeoutSeconds}
            min={5}
            max={300}
            step={5}
            onChange={(event) => setTimeoutSeconds(event.target.value)}
            disabled={busy}
          />
        </Field>

        <div className="space-y-1.5">
          <label className="text-muted flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(event) => setIsDefault(event.target.checked)}
              disabled={busy}
              className="accent-accent size-3.5"
            />
            Make this the provider’s default model
          </label>
          <label className="text-muted flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
              disabled={busy}
              className="accent-accent size-3.5"
            />
            Enable this model
          </label>
        </div>

        {error ? (
          <p className="text-danger text-xs" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </ProjectDialog>
  );
}
