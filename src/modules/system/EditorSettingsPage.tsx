import { Monitor, Moon, PenLine, Sun, Timer } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge, Card, CardHeader, PageHeader } from '@/components/ui';
import { setThemeMode, useThemeMode, type ThemeMode } from '@/core/theme/theme';
import { cn } from '@/utils/cn';

/**
 * Editor Settings (Round 1 — System, was PLACEHOLDER).
 *
 * Editor behaviour in this app is fixed by the autosave engine's real
 * guarantees, so this page reports them HONESTLY as facts rather than exposing
 * fake toggles that would do nothing. The one genuinely configurable editor
 * preference — appearance (theme) — is wired to the real theme store.
 *
 * Autosave constants mirror `modules/editor/autosave-engine.ts` defaults
 * (`debounceMs` 800, `maxWaitMs` 5_000). If those change, update the copy here.
 */
export function EditorSettingsPage() {
  const themeMode = useThemeMode();

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<PenLine className="size-4" />}
        eyebrow="System"
        title="Editor Settings"
        description="Appearance and how writing is saved while you work."
      />

      <Card padding="md">
        <CardHeader title="Editor appearance" description="Theme applies to the editor as well as the rest of the app" icon={<Sun className="size-4" />} />
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <ThemeOption label="Light" value="light" current={themeMode} onSelect={setThemeMode} icon={<Sun className="size-4" />} />
          <ThemeOption label="Dark" value="dark" current={themeMode} onSelect={setThemeMode} icon={<Moon className="size-4" />} />
          <ThemeOption label="System" value="system" current={themeMode} onSelect={setThemeMode} icon={<Monitor className="size-4" />} />
        </div>
      </Card>

      <Card padding="md">
        <CardHeader title="Autosave" description="How your drafts are protected (built in)" icon={<Timer className="size-4" />} />
        <dl className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <Fact label="Debounce" value="800 ms after you stop typing" hint="Edits are coalesced so a burst of keystrokes makes one write." />
          <Fact label="Max wait" value="5 s during continuous typing" hint="A long unbroken streak still saves at least every 5 seconds." />
          <Fact label="Version history" value="Every save keeps a version" hint="Restore any earlier draft from Version History." />
          <Fact label="Crash safety" value="Recovered on reopen" hint="In-progress drafts are restored when you return to a chapter." />
        </dl>
        <p className="text-subtle mt-3 text-2xs">
          Autosave is always on and tuned for safety; these values are fixed so a draft can never be lost to a disabled save.
        </p>
      </Card>

      <Card padding="md">
        <CardHeader title="Markdown & shortcuts" description="Supported while writing" icon={<PenLine className="size-4" />} />
        <div className="mt-3 flex flex-wrap gap-2">
          <Badge tone="neutral" size="sm">Bold / italic</Badge>
          <Badge tone="neutral" size="sm">Headings</Badge>
          <Badge tone="neutral" size="sm">Lists</Badge>
          <Badge tone="neutral" size="sm">Blockquotes</Badge>
          <Badge tone="neutral" size="sm">Inline code</Badge>
          <Badge tone="neutral" size="sm">Scene breaks</Badge>
        </div>
        <p className="text-subtle mt-3 text-2xs">
          The editor writes plain, portable text you can export to Markdown, DOCX, PDF or EPUB.
        </p>
      </Card>
    </div>
  );
}

function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-subtle text-2xs font-medium uppercase tracking-wide">{label}</dt>
      <dd className="text-ink mt-0.5 text-sm font-medium">{value}</dd>
      {hint ? <dd className="text-subtle text-2xs">{hint}</dd> : null}
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
