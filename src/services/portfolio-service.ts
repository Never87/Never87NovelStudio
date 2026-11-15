/**
 * Portfolio service (P9 Batch E).
 *
 * The business layer for the author's curated catalog:
 *
 *   - Lists a project's works as resolved `PortfolioEntry` objects by joining the
 *     PROJECT rows (title/genre/tags/status/blurb/target — the source of truth)
 *     with their optional `PortfolioProfile` display OVERRIDES.
 *   - Upserts a project's display profile (curated title/pen-name/tagline/
 *     category/featured/order/links) WITHOUT ever touching the project's own
 *     `description` or `blurb`. Editing the catalog can therefore never clobber
 *     the author's internal summary or the Blurb Generator output.
 *   - Deletes a display profile (reverting the work to pure project values).
 *
 * ## No duplication, no accidental overwrite
 *
 * A profile row stores ONLY curated labels/flags. Anything a reader sees that is
 * not curated (cover, blurb, genre, tags, status, word target) is read LIVE from
 * the project / cover modules when the entry is assembled. Consequently:
 *   - there is exactly one copy of the blurb (on the project);
 *   - the cover is resolved from the Book Covers module, never copied here;
 *   - saving a profile never writes `NovelProject.description`/`blurb`.
 *
 * The service is pure of UI/blob concerns: it never loads cover bytes. The hook
 * resolves each project's current cover for display (object URLs, cleanup) and
 * hands the title/author back to the renderer.
 */

import { ZodError } from 'zod';
import { createPortfolioProfileId } from '@/utils/id';
import { now } from '@/utils/date';
import type { NovelProject } from '@/types';
import {
  type PortfolioEntry,
  type PortfolioProfile,
  type UpdatePortfolioProfileInput,
} from '@/schemas/portfolio-profile';
import {
  PortfolioProfileRepository,
} from '@/repositories/portfolio-profile-repository';
import {
  ProjectRepository,
  ProjectRepositoryError,
  ProjectValidationError,
} from '@/repositories/project-repository';
import {
  buildPortfolioEntry,
  orderPortfolioEntries,
} from '@/modules/publishing/portfolio/portfolio-entry';

/** Base error for portfolio business-rule failures. */
export class PortfolioServiceError extends Error {
  /** Machine-readable discriminator. */
  readonly code: string;
  readonly cause?: unknown;

  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'PortfolioServiceError';
    this.code = code;
    this.cause = cause;
  }
}

/** Stable codes the UI can branch on without parsing messages. */
export const PORTFOLIO_ERROR_CODES = [
  'project-not-found',
  'write-failed',
  'read-failed',
] as const;

export type PortfolioErrorCode = (typeof PORTFOLIO_ERROR_CODES)[number];

export class PortfolioService {
  private readonly profileRepository: PortfolioProfileRepository;
  private readonly projectRepository: ProjectRepository;

  constructor(
    profileRepository: PortfolioProfileRepository = new PortfolioProfileRepository(),
    projectRepository: ProjectRepository = new ProjectRepository(),
  ) {
    this.profileRepository = profileRepository;
    this.projectRepository = projectRepository;
  }

  /**
   * Every work as a resolved, ordered `PortfolioEntry`.
   *
   * Joins the project list with the profile store in ONE pass. A project without
   * a profile still produces an entry (pure project values). Ordering: featured
   * first, then display order, then most recently updated.
   */
  async listEntries(): Promise<PortfolioEntry[]> {
    let projects: NovelProject[];
    let profiles: PortfolioProfile[];
    try {
      [projects, profiles] = await Promise.all([
        this.projectRepository.getAll(),
        this.profileRepository.getAll(),
      ]);
    } catch (error) {
      throw this.wrap('read-failed', 'The portfolio could not be loaded.', error);
    }

    const byProject = new Map(profiles.map((p) => [p.projectId, p]));
    const entries = projects.map((project) => buildPortfolioEntry(project, byProject.get(project.id) ?? null));
    return orderPortfolioEntries(entries);
  }

  /** The raw profile of a project, or null when none exists. */
  async getProfile(projectId: string): Promise<PortfolioProfile | null> {
    try {
      return await this.profileRepository.getByProjectId(projectId);
    } catch (error) {
      throw this.wrap('read-failed', `The portfolio profile of "${projectId}" could not be loaded.`, error);
    }
  }

  /**
   * Creates or updates a project's display profile.
   *
   * - The project must exist (never creates an orphan profile).
   * - `null` for a text field CLEARS the override (the project value shows again).
   * - `undefined` leaves a field unchanged (partial update).
   * - NEVER touches `NovelProject.description` or `NovelProject.blurb`.
   */
  async upsertProfile(
    projectId: string,
    input: UpdatePortfolioProfileInput,
  ): Promise<PortfolioProfile> {
    const project = await this.loadProject(projectId);
    if (!project) {
      throw new PortfolioServiceError('project-not-found', `Project "${projectId}" was not found.`);
    }

    let existing: PortfolioProfile | null;
    try {
      existing = await this.profileRepository.getByProjectId(projectId);
    } catch (error) {
      throw this.wrap('read-failed', 'The existing portfolio profile could not be read.', error);
    }

    const timestamp = now();
    const base: PortfolioProfile = existing ?? {
      id: createPortfolioProfileId(),
      projectId,
      featured: false,
      displayOrder: 0,
      links: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const merged: PortfolioProfile = {
      ...base,
      ...applyTextOverride('displayTitle', input.displayTitle),
      ...applyTextOverride('penName', input.penName),
      ...applyTextOverride('tagline', input.tagline),
      ...applyTextOverride('category', input.category),
      ...(input.featured !== undefined ? { featured: input.featured } : {}),
      ...(input.displayOrder !== undefined ? { displayOrder: clampOrder(input.displayOrder) } : {}),
      ...(input.links !== undefined ? { links: input.links } : {}),
      updatedAt: timestamp,
    };

    try {
      return existing
        ? await this.profileRepository.update(merged)
        : await this.profileRepository.create(merged);
    } catch (error) {
      throw this.wrap('write-failed', 'The portfolio profile could not be saved.', error);
    }
  }

  /** Removes a project's display profile (idempotent). Reverts to pure project values. */
  async deleteProfile(projectId: string): Promise<void> {
    try {
      await this.profileRepository.deleteByProjectId(projectId);
    } catch (error) {
      throw this.wrap('write-failed', 'The portfolio profile could not be removed.', error);
    }
  }

  /* ------------------------------- helpers ------------------------------- */

  private async loadProject(projectId: string): Promise<NovelProject | null> {
    if (!projectId || !projectId.trim()) {
      throw new PortfolioServiceError('project-not-found', 'A project id is required.');
    }
    try {
      return await this.projectRepository.getById(projectId);
    } catch (error) {
      throw this.wrap('read-failed', `Failed to load project "${projectId}".`, error);
    }
  }

  private wrap(code: PortfolioErrorCode, message: string, error: unknown): Error {
    if (error instanceof PortfolioServiceError) return error;
    if (error instanceof ProjectRepositoryError || error instanceof ProjectValidationError) {
      return new PortfolioServiceError(code, message, error);
    }
    if (error instanceof ZodError) {
      return new PortfolioServiceError(code, message, error);
    }
    return new PortfolioServiceError(code, message, error);
  }
}

/**
 * Turns a text override into a partial patch.
 *
 * - `undefined` → `{}` (leave unchanged);
 * - `null` or whitespace-only → `{ [key]: undefined-field }` (clear the override);
 * - otherwise → the trimmed string.
 *
 * "Clearing" is done by omitting the key so it falls back to the project value.
 */
function applyTextOverride<K extends 'displayTitle' | 'penName' | 'tagline' | 'category'>(
  key: K,
  value: string | null | undefined,
): Partial<Record<K, string>> {
  if (value === undefined) return {};
  if (value === null) return { [key]: undefined } as Partial<Record<K, string>>;
  const trimmed = value.trim();
  if (trimmed === '') return { [key]: undefined } as Partial<Record<K, string>>;
  return { [key]: trimmed } as Partial<Record<K, string>>;
}

/** Clamps a display order into the schema's allowed range. */
function clampOrder(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const n = Math.floor(value);
  if (n < 0) return 0;
  if (n > 1_000_000) return 1_000_000;
  return n;
}
