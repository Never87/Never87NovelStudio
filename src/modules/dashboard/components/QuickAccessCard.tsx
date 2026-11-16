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
import { Link } from 'react-router-dom';
import { Card, CardHeader } from '@/components/ui';

interface QuickAction {
  label: string;
  description: string;
  icon: LucideIcon;
  /** Real route. Placeholder modules render an honest "planned" empty state. */
  to: string;
}

const QUICK_ACTIONS: QuickAction[] = [
  { label: 'World Building', description: 'Locations, factions, rules', icon: Globe2, to: '/novel/world-building' },
  { label: 'Characters', description: 'Cast, arcs and relationships', icon: Users, to: '/novel/characters' },
  { label: 'Manuscript Import', description: 'Parse an existing draft', icon: BookText, to: '/import/manuscript' },
  { label: 'Extraction Review', description: 'Verify extracted facts', icon: ClipboardCheck, to: '/import/review-center' },
  { label: 'AI Assistance', description: 'Draft and rewrite prose', icon: Sparkles, to: '/ai/assistance' },
  { label: 'Export Manager', description: 'Package for publishing', icon: Package, to: '/publishing/export-manager' },
  { label: 'Writing Statistics', description: 'Output over time', icon: BarChart3, to: '/statistics' },
  { label: 'Project Snapshots', description: 'Restore-safe checkpoints', icon: Download, to: '/data/snapshots' },
];

/**
 * Quick access grid.
 *
 * Every tile is a REAL link to its module's canonical route. Modules that have
 * not shipped yet render an honest "planned" empty state on their own page — the
 * dashboard never fakes their content here.
 */
export function QuickAccessCard() {
  return (
    <Card padding="md">
      <CardHeader title="Quick Access" description="Jump to a module" />
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {QUICK_ACTIONS.map((action) => {
          const Icon = action.icon;
          return (
            <Link
              key={action.label}
              to={action.to}
              className="bg-surface-muted/60 hover:border-line-strong focus-visible:border-line-strong flex flex-col items-start gap-2 rounded-md border border-line px-2.5 py-2 text-left transition-colors"
            >
              <span className="text-accent grid size-6 place-items-center rounded-md bg-accent-soft">
                <Icon className="size-3.5" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="text-ink block truncate text-xs font-medium">{action.label}</span>
                <span className="text-subtle block truncate text-2xs">{action.description}</span>
              </span>
            </Link>
          );
        })}
      </div>
    </Card>
  );
}
