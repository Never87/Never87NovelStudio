import { Monitor, Moon, Settings, Sun } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge, Card, CardHeader, PageHeader } from '@/components/ui';
import { setThemeMode, useThemeMode, type ThemeMode } from '@/core/theme/theme';
import { useUiStore } from '@/stores/ui-store';
import { cn } from '@/utils/cn';

/**
 * General Settings (Round 1 — System, was PLACEHOLDER).
 *
 * Exposes REAL, persisted application preferences:
 *   - Theme mode (light / dark / system) — writes through `setThemeMode`, the
 *     same store the boot script reads (key `n87-theme`), so the choice applies
 *     instantly and survives reload with no flash.
 *   - Default sidebar state — persisted through `useUiStore` (key `n87-ui`).
 *
 * Both controls are wired to the actual persistence layer; nothing here is a
 * decorative toggle.
 */
export function GeneralSettingsPage() {
  const themeMode = useThemeMode();
  const { sidebarCollapsed, setSidebarCollapsed } = useUiStore();

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Settings className="size-4" />}
        eyebrow="System"
        title="General Settings"
        description="Appearance and layout preferences for the whole workspace."
      />

      <Card padding="md">
        <CardHeader title="Theme" description="Applies immediately and is remembered on this device" icon={<Sun className="size-4" />} />
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <ThemeOption label="Light" value="light" current={themeMode} onSelect={setThemeMode} icon={<Sun className="size-4" />} />
          <ThemeOption label="Dark" value="dark" current={themeMode} onSelect={setThemeMode} icon={<Moon className="size-4" />} />
          <ThemeOption label="System" value="system" current={themeMode} onSelect={setThemeMode} icon={<Monitor className="size-4" />} />
        </div>
        <p className="text-subtle mt-3 text-2xs">
          &ldquo;System&rdquo; follows your operating system&apos;s light/dark setting and updates automatically.
        </p>
      </Card>

      <Card padding="md">
        <CardHeader title="Layout" description="How the sidebar behaves by default" icon={<Settings className="size-4" />} />
        <label className="mt-4 flex items-center justify-between gap-4">
          <span>
            <span className="text-ink block text-sm">Collapse sidebar by default</span>
            <span className="text-subtle text-2xs">Shrinks the navigation rail to icons. You can still toggle it any time.</span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={sidebarCollapsed}
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className={cn(
              'relative h-5 w-9 shrink-0 rounded-full transition-colors',
              sidebarCollapsed ? 'bg-accent' : 'bg-surface-muted border border-line',
            )}
          >
            <span
              className={cn(
                'bg-surface absolute top-0.5 size-4 rounded-full shadow transition-transform',
                sidebarCollapsed ? 'translate-x-[18px]' : 'translate-x-0.5',
              )}
            />
          </button>
        </label>
      </Card>

      <Card padding="md">
        <CardHeader title="Storage" description="Where your data lives" icon={<Settings className="size-4" />} />
        <div className="mt-3 space-y-1.5 text-xs">
          <p className="text-muted">
            All novel content (projects, chapters, drafts, versions) is stored locally in your browser&apos;s IndexedDB.
            Nothing leaves this device unless you export or explicitly use an AI provider.
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Badge tone="neutral" size="sm">Local-first</Badge>
            <Badge tone="neutral" size="sm">Offline capable</Badge>
            <Badge tone="success" size="sm" dot>No account required</Badge>
          </div>
        </div>
      </Card>
    </div>
  );
}

function ThemeOption({
  label,
  value,
  current,
  onSelect,
  icon,
}: {
  label: string;
  value: ThemeMode;
  current: ThemeMode;
  onSelect: (mode: ThemeMode) => void;
  icon: ReactNode;
}) {
  const selected = current === value;
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      aria-pressed={selected}
      className={cn(
        'flex items-center gap-2 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors',
        selected
          ? 'border-accent bg-accent-soft text-accent-soft-text'
          : 'border-line text-muted hover:bg-surface-muted hover:text-ink',
      )}
    >
      {icon}
      <span className="font-medium">{label}</span>
      {selected ? <span className="ml-auto text-2xs">Selected</span> : null}
    </button>
  );
}
