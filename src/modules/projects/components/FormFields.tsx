import type { ReactNode, InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { useId } from 'react';
import { cn } from '@/utils/cn';

/** Shared visual treatment so text/select/textarea look identical. */
const CONTROL_CLASSES =
  'bg-surface text-ink placeholder:text-subtle border-line focus:border-accent-ring focus:ring-accent-ring/30 h-9 w-full rounded-md border px-2.5 text-sm outline-none focus:ring-2 disabled:opacity-60';
const CONTROL_CLASSES_MULTILINE = cn(CONTROL_CLASSES, 'h-auto min-h-[4.5rem] py-2 resize-y');

export interface FieldProps {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: ReactNode;
  required?: boolean;
  children: ReactNode;
  className?: string;
}

/** Label + control + inline error, with consistent spacing. */
export function Field({ label, htmlFor, error, hint, required, children, className }: FieldProps) {
  return (
    <div className={cn('space-y-1', className)}>
      <label htmlFor={htmlFor} className="text-ink flex items-center gap-1 text-xs font-medium">
        {label}
        {required ? (
          <span className="text-danger" aria-hidden>
            *
          </span>
        ) : null}
      </label>
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} className="text-danger text-2xs" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={`${htmlFor}-hint`} className="text-subtle text-2xs">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  error?: string;
  hint?: ReactNode;
  required?: boolean;
  className?: string;
}

export function TextField({ label, error, hint, required, className, ...rest }: TextFieldProps) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id} error={error} hint={hint} required={required} className={className}>
      <input
        id={id}
        className={cn(CONTROL_CLASSES, error && 'border-danger focus:border-danger focus:ring-danger/30')}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        {...rest}
      />
    </Field>
  );
}

export interface TextAreaFieldProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> {
  label: string;
  error?: string;
  hint?: ReactNode;
  className?: string;
}

export function TextAreaField({ label, error, hint, className, ...rest }: TextAreaFieldProps) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id} error={error} hint={hint} className={className}>
      <textarea
        id={id}
        className={cn(
          CONTROL_CLASSES_MULTILINE,
          error && 'border-danger focus:border-danger focus:ring-danger/30',
        )}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        {...rest}
      />
    </Field>
  );
}

export interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  label: string;
  error?: string;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function SelectField({ label, error, hint, className, children, ...rest }: SelectFieldProps) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id} error={error} hint={hint} className={className}>
      <select
        id={id}
        className={cn(CONTROL_CLASSES, 'pr-2', error && 'border-danger focus:border-danger focus:ring-danger/30')}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        {...rest}
      >
        {children}
      </select>
    </Field>
  );
}
