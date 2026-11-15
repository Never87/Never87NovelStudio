import { z } from 'zod';

/**
 * Portfolio profile schema (P9 Batch E).
 *
 * A `PortfolioProfile` holds ONLY *curated display overrides* for a project's
 * presentation in the Portfolio module. It is deliberately separate from the
 * project row so that editing what the world sees can NEVER overwrite the
 * author's INTERNAL `NovelProject.description` or the public
 * `NovelProject.blurb` produced by the Blurb Generator (P9 Batch D).
 *
 * ## What is stored vs. what is read live
 *
 * Stored here (per project, one row):
 *   - optional display-title / pen-name OVERRIDES (empty ⇒ fall back to the
 *     project's own title / `settings.author`);
 *   - a short `tagline` for the catalog card (distinct from the long blurb);
 *   - curation flags: `featured`, `displayOrder`;
 *   - optional category label + external links for a richer catalog card.
 *
 * NOT stored here (read LIVE from existing modules — no duplication):
 *   - the cover image        → resolved via `coverService.getCurrentCover`;
 *   - the public blurb       → `NovelProject.blurb`;
 *   - genre / tags / status  → `NovelProject.*`;
 *   - word count / target    → `NovelProject.targetWordCount` etc.
 *
 * If a profile row is absent, the Portfolio falls back entirely to the project
 * row and its live cover/blurb — so a project appears in the catalog without
 * any profile ever being created.
 */

const overrideTextSchema = z.string().trim().max(200);

const taglineSchema = z.string().trim().max(280, 'Tagline must be at most 280 characters');

const categorySchema = z.string().trim().max(60);

const linkSchema = z
  .object({
    /** Human-readable label, e.g. "Store page". */
    label: z.string().trim().min(1).max(60),
    /** Absolute URL. Kept short; the schema never fetches it. */
    url: z.string().trim().url('Links must be valid URLs').max(2_000),
  })
  .strict();

const timestampSchema = z
  .number()
  .int('Timestamp must be an integer')
  .nonnegative('Timestamp must be non-negative');

export const PortfolioProfileSchema = z
  .object({
    /** Stable primary key, prefixed (`pfp_...`). */
    id: z.string().min(1, 'Profile id is required'),
    /** Owning project. One profile per project (enforced by a unique index). */
    projectId: z.string().min(1, 'Project id is required'),
    /**
     * Display-title override. `''` means "use the project title". This is a
     * CURATED label only — it never changes `NovelProject.title`.
     */
    displayTitle: overrideTextSchema.optional(),
    /**
     * Pen-name override. `''` means "use the project's `settings.author`". A
     * CURATED label only — it never changes the project's author setting.
     */
    penName: overrideTextSchema.optional(),
    /** Short catalog tagline (distinct from the long public blurb). */
    tagline: taglineSchema.optional(),
    /** Curated category label (e.g. "Space Opera"); distinct from project genre. */
    category: categorySchema.optional(),
    /** Whether the work is pinned/featured in the catalog. */
    featured: z.boolean(),
    /** Curated ordering hint (lower first); ties fall back to `updatedAt`. */
    displayOrder: z.number().int().min(0).max(1_000_000),
    /** Optional external links (store page, reviews, portfolio site…). */
    links: z.array(linkSchema).max(20),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .refine((p) => p.updatedAt >= p.createdAt, {
    message: 'updatedAt cannot be earlier than createdAt',
    path: ['updatedAt'],
  });

/** A persisted portfolio display profile. */
export type PortfolioProfile = z.infer<typeof PortfolioProfileSchema>;

/**
 * The fields a caller may set when upserting a profile. Everything is optional:
 * a partial update leaves untouched display fields intact. `null` clears a
 * field (removing the override so the project value is shown again).
 */
export interface UpdatePortfolioProfileInput {
  displayTitle?: string | null;
  penName?: string | null;
  tagline?: string | null;
  category?: string | null;
  featured?: boolean;
  displayOrder?: number;
  links?: Array<{ label: string; url: string }>;
}

/**
 * The fully-resolved presentation of one work, as the Portfolio UI renders it.
 *
 * This is NOT persisted — it is assembled on the fly from the project row, its
 * live cover and blurb, plus the (optional) profile overrides. Each field notes
 * whether it came from the project, the profile, or is a computed fallback, so
 * the UI can clearly show what the author curated vs. what is derived.
 */
export interface PortfolioEntry {
  readonly projectId: string;
  /** Display title (profile override, else project title). */
  readonly title: string;
  /** Pen name (profile override, else `settings.author`, else null). */
  readonly author: string | null;
  /** Short catalog tagline (profile), or null when unset. */
  readonly tagline: string | null;
  /** Public blurb from the Blurb Generator / project (may be null). */
  readonly blurb: string | null;
  readonly genre: readonly string[];
  readonly tags: readonly string[];
  readonly status: string;
  /** Curated category (profile), or null. */
  readonly category: string | null;
  /** Target word count from the project, or null when unset. */
  readonly targetWordCount: number | null;
  readonly featured: boolean;
  readonly displayOrder: number;
  readonly links: ReadonlyArray<{ label: string; url: string }>;
  /** Whether a profile row exists for this project at all. */
  readonly hasProfile: boolean;
  readonly updatedAt: number;
  readonly createdAt: number;
}
