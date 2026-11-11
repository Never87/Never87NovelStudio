/**
 * Entity id generation.
 *
 * Ids are `crypto.randomUUID()` values with a short, human-readable prefix so
 * they are identifiable in DevTools and exported backups (e.g. `proj_9f2c…`).
 * `Math.random()` is never used — it is not a valid uniqueness source.
 */

/** Prefixes for every entity type. Keep in sync with the Dexie schema. */
export const ID_PREFIX = {
  project: 'proj',
} as const;

export type IdPrefix = (typeof ID_PREFIX)[keyof typeof ID_PREFIX];

/**
 * Generates a prefixed unique id.
 *
 * @example createId(ID_PREFIX.project) // 'proj_1f0c6c1e-…'
 */
export function createId(prefix: IdPrefix): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

/** Convenience wrapper for project ids. */
export function createProjectId(): string {
  return createId(ID_PREFIX.project);
}
