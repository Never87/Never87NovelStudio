import { ArrowRight, CircleDot, Clock3, ListChecks } from 'lucide-react';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui';
import { findGroupByItemId, NAV_ITEMS_BY_ID } from '@/config/navigation';

export interface ModulePlaceholderProps {
  /** Navigation item id — the page pulls all its copy from the nav config. */
  moduleId: string;
}

/**
 * Shared shell for every not-yet-implemented module.
 *
 * All copy is read from `config/navigation.ts` so titles, descriptions and
 * empty states stay module-specific (never a repeated generic "Coming Soon")
 * and remain in one place.
 */
export function ModulePlaceholder({ moduleId }: ModulePlaceholderProps) {
  const item = NAV_ITEMS_BY_ID[moduleId];

  if (!item) {
    throw new Error(`[ModulePlaceholder] unknown module id "${moduleId}"`);
  }

  const group = findGroupByItemId(item.id);
  const Icon = item.icon;

  return (
    <div className="space-y-5">
      <PageHeader
        icon={Icon ? <Icon className="size-4" /> : undefined}
        eyebrow={group?.label ?? 'Module'}
        title={item.label}
        description={item.description}
        actions={
          <>
            <Badge tone="accent" icon={<Clock3 className="size-3" />}>
              Coming Soon
            </Badge>
            <Badge tone="neutral" variant="outline">
              P0 · Placeholder
            </Badge>
          </>
        }
      />

      <EmptyState
        icon={Icon ? <Icon className="size-5" /> : undefined}
        title={item.emptyTitle}
        description={item.emptyDescription}
        variant="bordered"
        className="py-14"
      />

      {item.plannedFeatures && item.plannedFeatures.length > 0 ? (
        <Card padding="md">
          <div className="flex items-center gap-2">
            <ListChecks className="text-accent size-4" aria-hidden />
            <h2 className="text-ink text-sm font-semibold">Planned for this module</h2>
          </div>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {item.plannedFeatures.map((feature) => (
              <li key={feature} className="text-muted flex items-start gap-2 text-xs">
                <CircleDot className="text-subtle mt-0.5 size-3 shrink-0" aria-hidden />
                <span>{feature}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <p className="text-subtle flex items-center gap-1.5 text-2xs">
        <ArrowRight className="size-3" aria-hidden />
        This module is scheduled for a later phase. No data is created or stored on this page yet.
      </p>
    </div>
  );
}

