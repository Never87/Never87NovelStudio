/**
 * Character domain types.
 *
 * Re-exports only — every type originates from the Zod schemas in
 * `@/schemas/character` via `z.infer`. No interfaces are re-declared here.
 */
export type { Character, CharacterRole, CharacterStatus } from '@/schemas/character';

/** Runtime lists of valid role/status values, for UI selects and validation. */
export { CHARACTER_ROLES, CHARACTER_STATUSES } from '@/schemas/character';
