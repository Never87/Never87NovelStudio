import { z } from 'zod';

/**
 * Character domain schemas (single source of truth for character types).
 *
 * Every character belongs to exactly ONE project (`projectId`, indexed).
 * A project may have any number of characters.
 *
 * Same tsconfig constraints as the project schema:
 *   - `erasableSyntaxOnly`: no `enum`, use literal unions.
 *   - `verbatimModuleSyntax`: type-only imports must use `import type`.
 */

/** Story role of a character. Literal union — never a TS enum. */
export const CHARACTER_ROLES = ['protagonist', 'antagonist', 'supporting', 'minor'] as const;

export const CharacterRoleSchema = z.enum(CHARACTER_ROLES);

/** Lifecycle status of a character. */
export const CHARACTER_STATUSES = ['active', 'deceased', 'missing', 'unused'] as const;

export const CharacterStatusSchema = z.enum(CHARACTER_STATUSES);

const nameSchema = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .max(120, 'Name must be at most 120 characters');

/** A long-form free-text field (bio, background, personality, motivation). */
const longTextSchema = z.string().max(20_000, 'Must be at most 20000 characters');

const stringListSchema = z.array(z.string().trim().min(1).max(80)).max(50);

/** Unix epoch milliseconds. Rejects negatives and non-integers. */
const timestampSchema = z
  .number()
  .int('Timestamp must be an integer')
  .nonnegative('Timestamp must be non-negative');

export const CharacterSchema = z
  .object({
    /** Stable primary key, prefixed (e.g. `char_...`). */
    id: z.string().min(1, 'Character id is required'),
    /** Owning project. Indexed. */
    projectId: z.string().min(1, 'Character projectId is required'),

    /** Display name. Required and unique-by-convention inside a project (not enforced). */
    name: nameSchema,
    /** Short one-line summary shown in lists. Empty is allowed. */
    summary: z.string().max(500, 'Summary must be at most 500 characters'),
    /** Longer biography / backstory. */
    background: longTextSchema,
    /** Personality traits and behaviour. */
    personality: longTextSchema,
    /** Goals, wants and internal motivation. */
    motivation: longTextSchema,
    /** Physical description. */
    appearance: longTextSchema,

    role: CharacterRoleSchema,
    status: CharacterStatusSchema,
    /** Free-form labels (e.g. "mentor", "sea-folk"). */
    tags: stringListSchema,

    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  // A character can never be modified before it was created.
  .refine((character) => character.updatedAt >= character.createdAt, {
    message: 'updatedAt cannot be earlier than createdAt',
    path: ['updatedAt'],
  });

/** Story role of a character. */
export type CharacterRole = z.infer<typeof CharacterRoleSchema>;
/** Lifecycle status of a character. */
export type CharacterStatus = z.infer<typeof CharacterStatusSchema>;
/** A persisted character. */
export type Character = z.infer<typeof CharacterSchema>;
