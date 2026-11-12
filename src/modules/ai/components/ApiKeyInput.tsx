import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { cn } from '@/utils/cn';

/**
 * API key input that HIDES the key by default.
 *
 * Principle of least exposure: the secret is masked until the user explicitly
 * clicks reveal, and re-masks on blur. Reveal state is local and transient — it
 * is never persisted. The field is a normal password input, so the value is
 * never rendered into the DOM as text while hidden.
 */
export interface ApiKeyInputProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export function ApiKeyInput({ id, value, onChange, placeholder, disabled, className }: ApiKeyInputProps) {
  const [revealed, setRevealed] = useState(false);

  return (
    <div className={cn('relative', className)}>
      <input
        id={id}
        type={revealed ? 'text' : 'password'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => setRevealed(false)}
        placeholder={placeholder ?? 'sk-…'}
        disabled={disabled}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        className="bg-surface border-line-strong text-ink placeholder:text-subtle h-9 w-full rounded-md border py-1 pr-9 pl-2.5 font-mono text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:opacity-60"
      />
      <button
        type="button"
        onClick={() => setRevealed((previous) => !previous)}
        disabled={disabled || !value}
        aria-label={revealed ? 'Hide API key' : 'Show API key'}
        title={revealed ? 'Hide API key' : 'Show API key'}
        className="text-subtle hover:text-ink absolute top-1/2 right-1.5 grid size-7 -translate-y-1/2 place-items-center rounded disabled:opacity-40"
      >
        {revealed ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
      </button>
    </div>
  );
}
