import { useEffect, useRef, useState } from 'react';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { useThemeMode, setThemeMode, type ThemeMode } from '@/core/theme/theme';
import { cn } from '@/utils/cn';

const OPTIONS: { mode: ThemeMode; label: string; icon: typeof Sun; hint: string }[] = [
  { mode: 'light', label: 'Light', icon: Sun, hint: 'Always use the light theme' },
  { mode: 'dark', label: 'Dark', icon: Moon, hint: 'Always use the dark theme' },
  { mode: 'system', label: 'System', icon: Monitor, hint: 'Follow the OS setting' },
];

/**
 * Theme switcher.
 *
 * Reuses the existing `core/theme/theme.ts` store (persisted to the `n87-theme`
 * key that `index.html` reads before first paint), so switching never causes a
 * flash and no second theme system is introduced.
 */
export function ThemeToggle() {
  const mode = useThemeMode();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const ActiveIcon = OPTIONS.find((option) => option.mode === mode)?.icon ?? Monitor;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={`Theme: ${mode}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Theme: ${mode}`}
        className="text-muted hover:bg-surface-muted hover:text-ink grid size-8 place-items-center rounded-md"
      >
        <ActiveIcon className="size-4" />
      </button>

      {open ? (
        <div
          role="menu"
          className="bg-surface absolute right-0 top-9 z-40 w-44 overflow-hidden rounded-lg border border-line p-1 shadow-[var(--n87-shadow-popover)]"
        >
          <p className="text-subtle px-2 pb-1 pt-1 text-2xs font-medium uppercase tracking-wider">Theme</p>
          {OPTIONS.map((option) => {
            const Icon = option.icon;
            const selected = mode === option.mode;
            return (
              <button
                key={option.mode}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                title={option.hint}
                onClick={() => {
                  setThemeMode(option.mode);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                  selected ? 'bg-accent-soft text-accent-soft-text' : 'text-muted hover:bg-surface-muted hover:text-ink',
                )}
              >
                <Icon className="size-3.5 shrink-0" aria-hidden />
                <span className="flex-1">{option.label}</span>
                {selected ? <Check className="size-3.5 shrink-0" aria-hidden /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
