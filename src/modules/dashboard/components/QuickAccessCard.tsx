import type { LucideIcon } from 'lucide-react';
import {
  BarChart3,
  BookText,
  ClipboardCheck,
  Download,
  Globe2,
  Package,
  Sparkles,
  Users,
} from 'lucide-react';
import { Card, CardHeader } from '@/components/ui';

interface QuickAction {
  label: string;
  description: string;
  icon: LucideIcon;
}

const QUICK_ACTIONS: QuickAction[] = [
  { label: 'World Building', description: 'Locations, factions, rules', icon: Globe2 },
  { label: 'Characters', description: 'Cast, arcs and relationships', icon: Users },
  { label: 'Manuscript Import', description: 'Parse an existing draft', icon: BookText },
  { label: 'Extraction Review', description: 'Verify extracted facts', icon: ClipboardCheck },
  { label: 'AI Assistance', description: 'Draft and rewrite prose', icon: Sparkles },
  { label: 'Export Manager', description: 'Package for publishing', icon: Package },
  { label: 'Writing Statistics', description: 'Output over time', icon: BarChart3 },
  { label: 'Project Snapshots', description: 'Restore-safe checkpoints', icon: Download },
];

/**
 * Quick access grid. Every tile targets a module that has not shipped yet,
 * so tiles are rendered disabled with a "Soon" affordance rather than being
 * fake-clickable.
 */
export function QuickAccessCard() {
  return (
    <Card padding="md">
      <CardHeader title="Quick Access" description="Jump to a module" />
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {QUICK_ACTIONS.map((action) => {
          const Icon = action.icon;
          return (
            <button
              key={action.label}
              type="button"
              disabled
              title={`${action.label} — coming soon`}
              className="bg-surface-muted/60 hover:border-line-strong flex cursor-default flex-col items-start gap-2 rounded-md border border-line px-2.5 py-2 text-left opacity-90 transition-colors"
            >
              <span className="text-accent grid size-6 place-items-center rounded-md bg-accent-soft">
                <Icon className="size-3.5" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="text-ink block truncate text-xs font-medium">{action.label}</span>
                <span className="text-subtle block truncate text-2xs">{action.description}</span>
              </span>
            </button>
          );
        })}
      </div>
    </Card>
  );
}
