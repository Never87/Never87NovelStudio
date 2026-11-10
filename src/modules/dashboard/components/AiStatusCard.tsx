import { Bot, Plug, ShieldAlert } from 'lucide-react';
import { Badge, Button, Card, CardHeader } from '@/components/ui';
import { DEMO_AI_STATUS } from '@/modules/dashboard/demo-data';

/**
 * AI workspace / API connection status.
 *
 * IMPORTANT: this panel must never imply a real connection. Since no provider
 * adapter exists yet (P5) and no key has been supplied, it renders an explicit
 * "Not configured" state rather than a fake "Connected" badge.
 */
export function AiStatusCard() {
  return (
    <Card padding="md">
      <CardHeader
        title="AI Workspace"
        description="Provider & model connectivity"
        icon={<Bot className="size-4" />}
        action={<Badge tone="neutral" dot>{DEMO_AI_STATUS.provider}</Badge>}
      />

      <div className="bg-surface-muted/60 mt-3 rounded-md border border-line px-3 py-2.5">
        <p className="text-ink inline-flex items-center gap-1.5 text-xs font-medium">
          <Plug className="text-subtle size-3.5" aria-hidden />
          No provider configured
        </p>
        <p className="text-muted mt-1 text-2xs leading-relaxed">{DEMO_AI_STATUS.note}</p>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-subtle inline-flex items-center gap-1 text-2xs">
          <ShieldAlert className="size-3" aria-hidden />
          Keys are never stored server-side
        </span>
        <Button variant="secondary" size="sm" disabled title="API Settings ships in P5">
          Configure API
        </Button>
      </div>
    </Card>
  );
}
