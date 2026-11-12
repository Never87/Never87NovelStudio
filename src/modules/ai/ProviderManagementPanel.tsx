import { useState } from 'react';
import { Boxes, Plug, Plus, Trash2 } from 'lucide-react';
import { Badge, Button, Card, EmptyState, IconButton, PageHeader } from '@/components/ui';
import type { AiProvider } from '@/types';
import { AiError, isAiError, aiService } from '@/services';
import { useAiConfig } from '@/hooks';
import { cn } from '@/utils/cn';
import { ProviderFormDialog } from './components/ProviderFormDialog';
import { Toggle } from './components/fields';

/** Connection-test state per provider id. */
interface TestState {
  status: 'idle' | 'testing' | 'success' | 'error';
  message?: string;
  hint?: string;
}

/**
 * Provider Management (P5).
 *
 * Lists configured providers, lets the user add/edit/enable/delete them and run
 * a real connection test. It never disguises a failure: if a provider rejects
 * browser calls (CORS) the error says so.
 */
export function ProviderManagementPanel() {
  const {
    providers,
    models,
    status,
    error,
    createProvider,
    updateProvider,
    setProviderEnabled,
    deleteProvider,
  } = useAiConfig();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AiProvider | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});

  const modelCount = (providerId: string) => models.filter((model) => model.providerId === providerId).length;

  const runTest = async (provider: AiProvider) => {
    setTests((previous) => ({ ...previous, [provider.id]: { status: 'testing' } }));
    try {
      const result = await aiService.testConnection(provider.id);
      setTests((previous) => ({
        ...previous,
        [provider.id]: {
          status: 'success',
          message: `Connected — ${result.model} replied.`,
        },
      }));
    } catch (err) {
      const aiError = isAiError(err) ? err : null;
      setTests((previous) => ({
        ...previous,
        [provider.id]: {
          status: 'error',
          message: aiError ? describeTestFailure(aiError) : err instanceof Error ? err.message : 'The test failed.',
          hint: aiError?.hint,
        },
      }));
    }
  };

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (provider: AiProvider) => {
    setEditing(provider);
    setFormOpen(true);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Provider Management"
        description="Connect the AI services you use. Settings are stored in this browser and shared across all projects."
        actions={
          <Button variant="primary" size="sm" iconLeft={<Plus className="size-4" />} onClick={openCreate}>
            Add provider
          </Button>
        }
      />

      {status === 'error' ? (
        <Card padding="lg">
          <p className="text-danger text-sm">Providers could not be loaded.</p>
          <p className="text-subtle mt-1 text-xs">{error instanceof Error ? error.message : ''}</p>
        </Card>
      ) : null}

      {status === 'loading' && providers.length === 0 ? (
        <Card padding="lg">
          <p className="text-subtle text-xs" role="status">
            Loading providers…
          </p>
        </Card>
      ) : null}

      {status !== 'loading' && providers.length === 0 ? (
        <EmptyState
          icon={<Boxes className="size-5" aria-hidden />}
          title="No providers yet"
          description="Add an OpenAI-compatible, Anthropic, Gemini or custom endpoint provider to start using AI features."
          action={
            <Button variant="primary" size="sm" iconLeft={<Plus className="size-4" />} onClick={openCreate}>
              Add your first provider
            </Button>
          }
        />
      ) : null}

      {providers.length > 0 ? (
        <div className="space-y-2.5">
          {providers.map((provider) => {
            const test = tests[provider.id] ?? { status: 'idle' as const };
            return (
              <Card key={provider.id} padding="md">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-ink truncate text-sm font-semibold">{provider.name}</h3>
                      <Badge tone="neutral" size="sm">
                        {providerTypeLabel(provider.providerType)}
                      </Badge>
                      {provider.enabled ? (
                        <Badge tone="success" size="sm" dot>
                          Enabled
                        </Badge>
                      ) : (
                        <Badge tone="neutral" size="sm" dot>
                          Disabled
                        </Badge>
                      )}
                    </div>
                    <p className="text-subtle mt-0.5 truncate text-2xs">
                      {provider.baseUrl || 'Default endpoint'} · {modelCount(provider.id)} model
                      {modelCount(provider.id) === 1 ? '' : 's'}
                    </p>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <Toggle
                      checked={provider.enabled}
                      onChange={(next) => void setProviderEnabled(provider.id, next)}
                      label={`${provider.enabled ? 'Disable' : 'Enable'} ${provider.name}`}
                    />
                    <Button
                      variant="secondary"
                      size="sm"
                      iconLeft={<Plug className="size-3.5" />}
                      loading={test.status === 'testing'}
                      onClick={() => void runTest(provider)}
                    >
                      Test
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => openEdit(provider)}>
                      Edit
                    </Button>
                    <IconButton
                      label={`Delete ${provider.name}`}
                      icon={<Trash2 className="size-3.5" aria-hidden />}
                      onClick={() => {
                        if (window.confirm(`Delete "${provider.name}" and its ${modelCount(provider.id)} model(s)?`)) {
                          void deleteProvider(provider.id);
                        }
                      }}
                    />
                  </div>
                </div>

                {test.status !== 'idle' && test.status !== 'testing' ? (
                  <p
                    className={cn(
                      'mt-2 rounded-md px-2 py-1.5 text-2xs',
                      test.status === 'success' ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger',
                    )}
                    role="status"
                  >
                    {test.message}
                    {test.hint ? <span className="text-subtle mt-0.5 block">{test.hint}</span> : null}
                  </p>
                ) : null}
              </Card>
            );
          })}
        </div>
      ) : null}

      <ProviderFormDialog
        open={formOpen}
        provider={editing}
        onClose={() => setFormOpen(false)}
        onSubmit={async (values) => {
          if (editing) {
            await updateProvider(editing.id, values);
          } else {
            await createProvider(values);
          }
        }}
      />
    </div>
  );
}

function providerTypeLabel(type: AiProvider['providerType']): string {
  switch (type) {
    case 'openai':
      return 'OpenAI';
    case 'anthropic':
      return 'Anthropic';
    case 'gemini':
      return 'Gemini';
    case 'custom':
      return 'Custom endpoint';
    default:
      return type;
  }
}

/** Turns an AiError into a one-line, user-facing test result. */
function describeTestFailure(error: AiError): string {
  switch (error.kind) {
    case 'cors':
      return 'Could not reach the provider from the browser (CORS or network).';
    case 'auth':
      return 'Authentication failed — check the API key.';
    case 'model':
      return 'The model or endpoint was not found.';
    case 'rate-limit':
      return 'Rate limit or quota exceeded.';
    case 'timeout':
      return 'The request timed out.';
    default:
      return error.message;
  }
}
