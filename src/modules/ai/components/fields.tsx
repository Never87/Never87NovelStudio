import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { cn } from '@/utils/cn';

/**
 * Small form primitives for the AI settings panels.
 *
 * Plain labelled wrappers over native inputs so every field gets a consistent
 * label/hint/error treatment and the dark/light tokens, without pulling in a
 * form library. Kept local to the AI module because the rest of the app uses
 * one-off inputs inside its dialogs.
 */

const FIELD_BASE =
  'bg-surface border-line-strong text-ink w-full rounded-md border px-2.5 text-sm ' +
  'placeholder:text-subtle focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ' +
  'disabled:opacity-60';

export interface FieldProps {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
  /** Right-aligned helper (e.g. a "show" toggle). */
  action?: ReactNode;
}

/** Label + control + hint/error column. */
export function Field({ label, hint, error, required, htmlFor, children, className, action }: FieldProps) {
  return (
    <div className={cn('space-y-1', className)}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={htmlFor} className="text-subtle text-2xs font-medium uppercase tracking-wide">
          {label}
          {required ? <span className="text-danger ml-0.5">*</span> : null}
        </label>
        {action}
      </div>
      {children}
      {error ? (
        <p className="text-danger text-2xs" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-subtle text-2xs leading-relaxed">{hint}</p>
      ) : null}
    </div>
  );
}

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(FIELD_BASE, 'h-9', className)} {...rest} />;
}

export function NumberInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input type="number" className={cn(FIELD_BASE, 'h-9 tabular-nums', className)} {...rest} />;
}

export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(FIELD_BASE, 'min-h-[80px] py-2 leading-relaxed', className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(FIELD_BASE, 'h-9 pr-8', className)} {...rest}>
      {children}
    </select>
  );
}

/** A simple on/off switch used for enable/disable rows. */
export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
        checked ? 'bg-accent' : 'bg-line-strong',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'inline-block size-4 transform rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}
