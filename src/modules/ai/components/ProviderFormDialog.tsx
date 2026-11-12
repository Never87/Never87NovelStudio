import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui';
import type { AiProvider, AiProviderType } from '@/types';
import { getAdapter } from '@/services';
import { ProjectDialog } from '@/modules/projects/components/ProjectDialog';
import { ApiKeyInput } from './ApiKeyInput';
import { Field, Select, TextInput } from './fields';
import { cn } from '@/utils/cn';

export interface ProviderFormDialogProps {
  open: boolean;
  /** Existing provider to edit, or null to create. */
  provider: AiProvider | null;
  onClose: () => void;
  onSubmit: (values: {
    name: string;
    providerType: AiProviderType;
    baseUrl: string;
    apiKey: string;
    customHeaders: Array<{ name: string; value: string }>;
    enabled: boolean;
  }) => Promise<void>;
}

interface ProviderTypeOption {
  value: AiProviderType;
  label: string;
  description: string;
}

const TYPE_OPTIONS: ProviderTypeOption[] = [
  { value: 'openai', label: 'OpenAI', description: 'Official OpenAI API (Chat Completions).' },
  {
    value: 'anthropic',
    label: 'Anthropic',
    description: 'Claude Messages API. May be blocked by CORS in the browser.',
  },
  { value: 'gemini', label: 'Google Gemini', description: 'Gemini generateContent API.' },
  {
    value: 'custom',
    label: 'Custom endpoint',
    description: 'Any service that speaks the OpenAI Chat Completions format.',
  },
];

/** Create/edit form for a provider. */
export function ProviderFormDialog({ open, provider, onClose, onSubmit }: ProviderFormDialogProps) {
  const [name, setName] = useState('');
  const [providerType, setProviderType] = useState<AiProviderType>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [headers, setHeaders] = useState<Array<{ name: string; value: string }>>([]);
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the form whenever the dialog opens for a (possibly different) provider.
  useEffect(() => {
    if (!open) return;
    setName(provider?.name ?? '');
    setProviderType(provider?.providerType ?? 'openai');
    setBaseUrl(provider?.baseUrl ?? '');
    setApiKey(provider?.apiKey ?? '');
    setHeaders(provider?.customHeaders.map((header) => ({ ...header })) ?? []);
    setEnabled(provider?.enabled ?? true);
    setError(null);
  }, [open, provider]);

  const defaultBaseUrl = getAdapter(providerType).defaultBaseUrl;
  const isCustom = providerType === 'custom';

  const handleSubmit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        providerType,
        baseUrl: baseUrl.trim(),
        apiKey,
        customHeaders: headers.filter((header) => header.name.trim() !== ''),
        enabled,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The provider could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ProjectDialog
      open={open}
      title={provider ? 'Edit provider' : 'Add provider'}
      description="Provider settings are stored in this browser only and shared across all your projects."
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
            disabled={!name.trim() || !apiKey.trim() || (isCustom && !baseUrl.trim())}
          >
            {provider ? 'Save changes' : 'Add provider'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Provider type" htmlFor="provider-type" required>
          <Select
            id="provider-type"
            value={providerType}
            onChange={(event) => setProviderType(event.target.value as AiProviderType)}
            disabled={busy}
          >
            {TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          <p className="text-subtle text-2xs leading-relaxed">
            {TYPE_OPTIONS.find((option) => option.value === providerType)?.description}
          </p>
        </Field>

        <Field label="Name" htmlFor="provider-name" required>
          <TextInput
            id="provider-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. My OpenAI account"
            maxLength={80}
            disabled={busy}
          />
        </Field>

        <Field
          label="Base URL"
          htmlFor="provider-base-url"
          required={isCustom}
          hint={
            isCustom
              ? 'Full URL of your OpenAI-compatible endpoint, e.g. https://api.example.com/v1'
              : `Leave blank to use the default: ${defaultBaseUrl}`
          }
        >
          <TextInput
            id="provider-base-url"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder={isCustom ? 'https://api.example.com/v1' : defaultBaseUrl}
            disabled={busy}
          />
        </Field>

        <Field label="API key" htmlFor="provider-api-key" required>
          <ApiKeyInput id="provider-api-key" value={apiKey} onChange={setApiKey} disabled={busy} />
          <p className="text-warning text-2xs leading-relaxed">
            The key is stored unencrypted in this browser’s IndexedDB. Anyone with access to this
            browser or a malicious script on this page could read it. Do not use a shared computer.
          </p>
        </Field>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-subtle text-2xs font-medium uppercase tracking-wide">Custom headers</span>
            <Button
              variant="ghost"
              size="sm"
              iconLeft={<Plus className="size-3.5" />}
              onClick={() => setHeaders((rows) => [...rows, { name: '', value: '' }])}
              disabled={busy || headers.length >= 20}
            >
              Add header
            </Button>
          </div>
          {headers.length === 0 ? (
            <p className="text-subtle text-2xs italic">No custom headers. Authorization is added automatically.</p>
          ) : (
            <ul className="space-y-1.5">
              {headers.map((header, index) => (
                <li key={index} className="flex items-center gap-1.5">
                  <TextInput
                    aria-label={`Header ${index + 1} name`}
                    placeholder="Header name"
                    value={header.name}
                    onChange={(event) =>
                      setHeaders((rows) => rows.map((row, i) => (i === index ? { ...row, name: event.target.value } : row)))
                    }
                    disabled={busy}
                    className={cn('flex-1')}
                  />
                  <TextInput
                    aria-label={`Header ${index + 1} value`}
                    placeholder="Value"
                    value={header.value}
                    onChange={(event) =>
                      setHeaders((rows) => rows.map((row, i) => (i === index ? { ...row, value: event.target.value } : row)))
                    }
                    disabled={busy}
                    className="flex-1"
                  />
                  <button
                    type="button"
                    aria-label={`Remove header ${index + 1}`}
                    onClick={() => setHeaders((rows) => rows.filter((_, i) => i !== index))}
                    disabled={busy}
                    className="text-subtle hover:text-danger grid size-8 shrink-0 place-items-center rounded"
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <label className="text-muted flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            disabled={busy}
            className="accent-accent size-3.5"
          />
          Enable this provider
        </label>

        {error ? (
          <p className="text-danger text-xs" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </ProjectDialog>
  );
}
