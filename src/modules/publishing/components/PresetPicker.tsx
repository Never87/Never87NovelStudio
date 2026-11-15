/**
 * Shared preset picker (P9 Batch B).
 *
 * Used by BOTH publishing pages so preset selection looks and behaves the same
 * everywhere, and reads the SAME shared state. It is a controlled component:
 * the parent passes the current `value` (active preset id) and an `onChange`
 * that calls the shared store. It never keeps its own selection state.
 */

import type { PublishingPreset } from '@/modules/publishing';
import { Badge } from '@/components/ui';
import { cn } from '@/utils/cn';

export function PresetPicker({
  presets,
  value,
  onChange,
  isBuiltin,
  id = 'preset-picker',
  label = 'Preset',
  disabled,
}: {
  presets: readonly PublishingPreset[];
  value: string;
  onChange: (id: string) => void;
  isBuiltin: (id: string) => boolean;
  id?: string;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-subtle text-2xs font-medium uppercase tracking-wide">
        {label}
      </label>
      <select
        id={id}
        data-testid="preset-picker"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="border-line bg-surface text-ink min-w-52 rounded-md border px-2 py-1.5 text-xs"
      >
        {presets.map((preset) => (
          <option key={preset.id} value={preset.id}>
            {preset.label}
            {isBuiltin(preset.id) ? '' : '  (custom)'}
          </option>
        ))}
      </select>
    </div>
  );
}

/** A compact inline summary badge: Built-in vs Custom. */
export function PresetKindBadge({ builtin }: { builtin: boolean }) {
  return builtin ? (
    <Badge tone="neutral" size="sm">
      Built-in
    </Badge>
  ) : (
    <Badge tone="accent" size="sm">
      Custom
    </Badge>
  );
}

/** A read-only list of concise characteristics for a preset (shared). */
export function PresetCharacteristics({
  lines,
  className,
}: {
  lines: readonly string[];
  className?: string;
}) {
  return (
    <ul className={cn('text-subtle space-y-1 text-2xs leading-relaxed', className)}>
      {lines.map((line) => (
        <li key={line} className="flex items-start gap-1.5">
          <span aria-hidden className="bg-line-strong mt-1.5 size-1 shrink-0 rounded-full" />
          <span>{line}</span>
        </li>
      ))}
    </ul>
  );
}
