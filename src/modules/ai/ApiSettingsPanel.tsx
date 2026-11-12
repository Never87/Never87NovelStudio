import { Link } from 'react-router-dom';
import { AlertTriangle, Boxes, Plug, ShieldAlert, SlidersHorizontal } from 'lucide-react';
import { Badge, Card, PageHeader } from '@/components/ui';
import { useAiConfig } from '@/hooks';

/**
 * API Settings (P5).
 *
 * A status overview of the workspace's AI configuration: how many providers and
 * models exist, whether a default is set, and the security/CORS realities of
 * calling APIs directly from a static browser app. It links into the detailed
 * Provider and Model pages rather than duplicating their forms.
 */
export function ApiSettingsPanel() {
  const { providers, models, status, globalDefaultModelId, taskModels } = useAiConfig();

  const enabledProviders = providers.filter((provider) => provider.enabled).length;
  const enabledModels = models.filter((model) => model.enabled).length;
  const assignedTasks = Object.values(taskModels).filter((value) => value !== null).length;
  const defaultModel = models.find((model) => model.id === globalDefaultModelId);

  const ready = enabledProviders > 0 && enabledModels > 0 && Boolean(globalDefaultModelId);

  return (
    <div className="space-y-5">
      <PageHeader
        title="API Settings"
        description="An overview of your AI configuration. Providers and models are managed on their own pages."
      />

      <Card padding="md">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Badge tone={ready ? 'success' : 'warning'} size="md" dot>
              {ready ? 'Ready to use' : 'Setup incomplete'}
            </Badge>
            {status === 'loading' ? (
              <span className="text-subtle text-2xs" role="status">
                Loading…
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Link to="/settings/providers" className="text-accent text-xs font-medium hover:underline">
              Providers
            </Link>
            <Link to="/settings/models" className="text-accent text-xs font-medium hover:underline">
              Models
            </Link>
          </div>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Enabled providers" value={`${enabledProviders} / ${providers.length}`} />
          <Stat label="Enabled models" value={`${enabledModels} / ${models.length}`} />
          <Stat label="Tasks assigned" value={`${assignedTasks}`} />
          <Stat label="Default model" value={defaultModel ? defaultModel.displayName : 'None'} />
        </dl>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2">
        <Card padding="md" interactive className="flex flex-col justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <span className="bg-accent-soft text-accent-soft-text grid size-8 shrink-0 place-items-center rounded-lg">
              <Boxes className="size-4" aria-hidden />
            </span>
            <div>
              <h2 className="text-ink text-sm font-semibold">Provider Management</h2>
              <p className="text-muted mt-0.5 text-xs">Add endpoints, API keys, custom headers and test connections.</p>
            </div>
          </div>
          <Link to="/settings/providers" className="text-accent text-xs font-medium hover:underline">
            Manage providers →
          </Link>
        </Card>

        <Card padding="md" interactive className="flex flex-col justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <span className="bg-accent-soft text-accent-soft-text grid size-8 shrink-0 place-items-center rounded-lg">
              <SlidersHorizontal className="size-4" aria-hidden />
            </span>
            <div>
              <h2 className="text-ink text-sm font-semibold">Model Configuration</h2>
              <p className="text-muted mt-0.5 text-xs">Choose the default model, set per-task models and parameters.</p>
            </div>
          </div>
          <Link to="/settings/models" className="text-accent text-xs font-medium hover:underline">
            Configure models →
          </Link>
        </Card>
      </div>

      <Card padding="md" className="space-y-3">
        <div className="flex items-start gap-2.5">
          <span className="text-warning mt-0.5 shrink-0">
            <ShieldAlert className="size-4" aria-hidden />
          </span>
          <div>
            <h2 className="text-ink text-sm font-semibold">API key storage</h2>
            <p className="text-muted mt-0.5 text-xs leading-relaxed">
              API keys are stored unencrypted in this browser’s IndexedDB. This is not a secure vault:
              anyone with access to this browser, or a malicious script running on this page, could read
              them. Use a restricted key and avoid shared computers. Keys never leave your browser except to
              the provider you configured.
            </p>
          </div>
        </div>
        <div className="flex items-start gap-2.5">
          <span className="text-warning mt-0.5 shrink-0">
            <AlertTriangle className="size-4" aria-hidden />
          </span>
          <div>
            <h2 className="text-ink text-sm font-semibold">Browser CORS limits</h2>
            <p className="text-muted mt-0.5 text-xs leading-relaxed">
              Requests go directly from your browser to the provider. Some providers (notably Anthropic)
              may refuse browser-origin calls, and a connection test will then fail with a CORS/network
              error. This site is static and has no backend proxy, so such providers cannot be used until
              they allow browser access or a proxy is added.
            </p>
          </div>
        </div>
        <div className="flex items-start gap-2.5">
          <span className="text-subtle mt-0.5 shrink-0">
            <Plug className="size-4" aria-hidden />
          </span>
          <div>
            <h2 className="text-ink text-sm font-semibold">Supported protocols</h2>
            <p className="text-muted mt-0.5 text-xs leading-relaxed">
              OpenAI-compatible (Chat Completions), Anthropic (Messages) and Google Gemini
              (generateContent). “Custom endpoint” means an OpenAI-compatible service at your own URL — it
              does not support arbitrary protocols.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-subtle text-2xs font-medium uppercase tracking-wide">{label}</dt>
      <dd className="text-ink mt-0.5 truncate text-sm font-semibold">{value}</dd>
    </div>
  );
}
