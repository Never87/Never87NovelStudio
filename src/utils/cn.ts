/**
 * Tiny class-name joiner: `cn('a', cond && 'b', undefined)` -> 'a b'.
 * Kept dependency-free on purpose so the design system has no runtime coupling.
 */
export type ClassValue = string | number | false | null | undefined | ClassValue[];

export function cn(...inputs: ClassValue[]): string {
  const out: string[] = [];
  const walk = (value: ClassValue): void => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    out.push(String(value));
  };
  inputs.forEach(walk);
  return out.join(' ');
}
