/**
 * Portfolio entry assembly (P9 Batch E) — PURE.
 *
 * Combines a `NovelProject` row, its (optional) `PortfolioProfile` overrides and
 * a few resolved cover/blurb facts into a single `PortfolioEntry` the UI renders.
 *
 * It NEVER writes and NEVER duplicates data: it only chooses, per field, between
 *   - a profile OVERRIDE (what the author curated for the catalog), or
 *   - the PROJECT's own live value, or
 *   - a computed FALLBACK (e.g. "Untitled", or no author).
 *
 * Because this is pure it can be unit-tested exhaustively (fallbacks, override
 * precedence, ordering) without a browser or a database.
 */

import type { NovelProject } from '@/types';
import type {
  PortfolioEntry,
  PortfolioProfile,
} from '@/schemas/portfolio-profile';

/** A trimmed, non-empty string or null. */
function clean(value: string | undefined | null): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Builds the resolved `PortfolioEntry` for one project.
 *
 * @param project The project row (the source of truth for title/genre/status/…).
 * @param profile The optional curated profile row (overrides + curation flags).
 * @returns A render-ready entry; every field is non-undefined.
 *
 * Fallback rules:
 *   - title:        profile.displayTitle → project.title → "Untitled";
 *   - author:       profile.penName → project.settings.author → null;
 *   - tagline:      profile.tagline → null;
 *   - category:     profile.category → null;
 *   - blurb:        project.blurb (trimmed) → null  (NEVER the internal description);
 *   - genre/tags:   project values (always arrays);
 *   - status:       project.status;
 *   - featured/order/links: profile values, else safe defaults.
 */
export function buildPortfolioEntry(
  project: NovelProject,
  profile: PortfolioProfile | null,
): PortfolioEntry {
  const overrideTitle = clean(profile?.displayTitle);
  const overrideAuthor = clean(profile?.penName);

  const title = overrideTitle ?? (clean(project.title) ?? 'Untitled');
  const author = overrideAuthor ?? clean(project.settings?.author);
  const blurb = clean(project.blurb);

  return {
    projectId: project.id,
    title,
    author,
    tagline: clean(profile?.tagline),
    blurb,
    genre: project.genre ?? [],
    tags: project.tags ?? [],
    status: project.status,
    category: clean(profile?.category),
    targetWordCount: typeof project.targetWordCount === 'number' ? project.targetWordCount : null,
    featured: profile?.featured ?? false,
    displayOrder: profile?.displayOrder ?? 0,
    links: profile?.links ?? [],
    hasProfile: profile !== null,
    updatedAt: project.updatedAt,
    createdAt: project.createdAt,
  };
}

/**
 * Orders portfolio entries for display:
 *   1. featured first,
 *   2. then lower `displayOrder`,
 *   3. then most recently updated.
 *
 * Returns a NEW array (never mutates the input).
 */
export function orderPortfolioEntries(entries: readonly PortfolioEntry[]): PortfolioEntry[] {
  return [...entries].sort((a, b) => {
    if (a.featured !== b.featured) return a.featured ? -1 : 1;
    if (a.displayOrder !== b.displayOrder) return a.displayOrder - b.displayOrder;
    return b.updatedAt - a.updatedAt;
  });
}

/**
 * Filters entries by a free-text query (case-insensitive) across the fields a
 * reader would search: title, author, tagline, category, blurb, genre and tags.
 * An empty/blank query returns all entries unchanged.
 */
export function filterPortfolioEntries(
  entries: readonly PortfolioEntry[],
  query: string,
): PortfolioEntry[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...entries];
  return entries.filter((e) => {
    const haystack = [
      e.title,
      e.author ?? '',
      e.tagline ?? '',
      e.category ?? '',
      e.blurb ?? '',
      ...e.genre,
      ...e.tags,
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });
}
