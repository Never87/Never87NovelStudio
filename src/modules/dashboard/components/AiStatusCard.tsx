import { Bot, Plug, ShieldAlert } from 'lucide-react';
import { Badge, Button, Card, CardHeader } from '@/components/ui';

/**
 * AI workspace / API connection status.
 *
 * IMPORTANT: this panel must never imply a real connection. It renders an
 * explicit "Not configured" state rather than a fake "Connected" badge. It is
 * intentionally static (no fabricated provider name or usage numbers).
 */
export function AiStatusCard() {
  return (
    <Card padding="md">
      <CardHeader
        title="AI Workspace"
        description="Provider & model connectivity"
        icon={<Bot className="size-4" />}
        action={<Badge tone="neutral" dot>Not configured</Badge>}
      />

      <div className="bg-surface-muted/60 mt-3 rounded-md border border-line px-3 py-2.5">
        <p className="text-ink inline-flex items-center gap-1.5 text-xs font-medium">
          <Plug className="text-subtle size-3.5" aria-hidden />
          No provider configured
        </p>
        <p className="text-muted mt-1 text-2xs leading-relaxed">
          Add a provider and API key in API Settings to enable AI assistance. Keys are stored locally
          in your browser only.
        </p>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-subtle inline-flex items-center gap-1 text-2xs">
          <ShieldAlert className="size-3" aria-hidden />
          Keys are never stored server-side
        </span>
        <Button variant="secondary" size="sm" disabled title="Configure API under Settings → AI">
          Configure API
        </Button>
      </div>
    </Card>
  );
}
