import { ZodError } from 'zod';
import { now } from '@/utils/date';
import { createNarrativePlanId, createPlotBeatId } from '@/utils/id';
import type {
  NarrativePlan,
  NarrativeStatus,
  NarrativeStructure,
  PlotBeat,
} from '@/types';
import {
  NarrativeRepository,
} from '@/repositories/narrative-repository';
import { ProjectRepositoryError, ProjectValidationError } from '@/repositories/project-repository';

/** Raised when a project already has a narrative plan (one plan per project). */
export class NarrativeAlreadyExistsError extends ProjectValidationError {
  readonly projectId: string;

  constructor(projectId: string, existingId?: string) {
    super(
      `Project "${projectId}" already has a narrative plan${existingId ? ` ("${existingId}")` : ''}. Edit it instead.`,
      [],
    );
    this.name = 'NarrativeAlreadyExistsError';
    this.projectId = projectId;
  }
}

/** Raised when an update targets a project that has no narrative plan yet. */
export class NarrativeNotFoundError extends ProjectRepositoryError {
  readonly projectId: string;

  constructor(projectId: string) {
    super(`Project "${projectId}" has no narrative plan yet`);
    this.name = 'NarrativeNotFoundError';
    this.projectId = projectId;
  }
}

/** Base error for business-rule failures raised by this Service. */
export class NarrativeServiceError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'NarrativeServiceError';
    this.cause = cause;
  }
}

export { ProjectRepositoryError, ProjectValidationError };

/** A beat as supplied by a caller — its id is optional and assigned by the Service. */
export interface PlotBeatInput {
  id?: string;
  title: string;
  description?: string;
  position: number;
}

/** Fields callable on create. Id/timestamps/beat-ids are Service-owned. */
export interface CreateNarrativeInput {
  logline?: string;
  theme?: string;
  premise?: string;
  centralConflict?: string;
  stakes?: string;
  ending?: string;
  structure?: NarrativeStructure;
  status?: NarrativeStatus;
  beats?: PlotBeatInput[];
  motifs?: string[];
}

/**
 * Fields a caller may change on an existing plan.
 *
 * Every field is optional so a partial patch leaves untouched data intact.
 * Text fields accept `null` to CLEAR them explicitly (mirrors the project
 * `cover`/`targetWordCount` semantics).
 */
export interface UpdateNarrativeInput {
  logline?: string | null;
  theme?: string | null;
  premise?: string | null;
  centralConflict?: string | null;
  stakes?: string | null;
  ending?: string | null;
  structure?: NarrativeStructure;
  status?: NarrativeStatus;
  /** Replaces the full ordered beat list when provided. */
  beats?: PlotBeatInput[];
  motifs?: string[];
}

// Defaults for a brand-new plan: an empty but structurally valid skeleton.
const EMPTY_TEXT = '';
const DEFAULT_STRUCTURE: NarrativeStructure = 'three-act';
const DEFAULT_STATUS: NarrativeStatus = 'draft';

/**
 * Business layer for narrative plans.
 *
 * Owns ids, timestamps, defaults and the one-plan-per-project rule. Persistence
 * goes exclusively through the injected `NarrativeRepository`.
 */
export class NarrativeService {
  private readonly repository: NarrativeRepository;

  constructor(repository: NarrativeRepository = new NarrativeRepository()) {
    this.repository = repository;
  }

  /**
   * Creates the narrative plan of `projectId`.
   *
   * Defaults to an empty three-act plan in `draft`. Fails when the project
   * already has one, so this method can never silently clobber a plan.
   */
  async createPlan(projectId: string, input: CreateNarrativeInput = {}): Promise<NarrativePlan> {
    let existing: NarrativePlan | null;
    try {
      existing = await this.repository.getByProjectId(projectId);
    } catch (error) {
      throw this.wrap(error, `Failed to load the narrative plan of project "${projectId}"`);
    }
    if (existing) {
      throw new NarrativeAlreadyExistsError(projectId, existing.id);
    }

    const timestamp = now();
    const plan: NarrativePlan = {
      id: createNarrativePlanId(),
      projectId,
      logline: input.logline ?? EMPTY_TEXT,
      theme: input.theme ?? EMPTY_TEXT,
      premise: input.premise ?? EMPTY_TEXT,
      centralConflict: input.centralConflict ?? EMPTY_TEXT,
      stakes: input.stakes ?? EMPTY_TEXT,
      ending: input.ending ?? EMPTY_TEXT,
      structure: input.structure ?? DEFAULT_STRUCTURE,
      status: input.status ?? DEFAULT_STATUS,
      beats: normalizeBeats(input.beats ?? []),
      motifs: input.motifs ?? [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    try {
      return await this.repository.create(plan);
    } catch (error) {
      throw this.wrap(error, `Failed to create the narrative plan of project "${projectId}"`);
    }
  }

  /** Returns the plan of `projectId`, or `null` when none exists. */
  async getPlan(projectId: string): Promise<NarrativePlan | null> {
    try {
      return await this.repository.getByProjectId(projectId);
    } catch (error) {
      throw this.wrap(error, `Failed to load the narrative plan of project "${projectId}"`);
    }
  }

  /** Whether `projectId` already has a narrative plan. */
  async hasPlan(projectId: string): Promise<boolean> {
    return (await this.getPlan(projectId)) !== null;
  }

  /**
   * Applies a partial update to the plan of `projectId`.
   *
   * - Fails when no plan exists (never creates one — use `createPlan`).
   * - Leaves omitted fields untouched.
   * - `null` clears a text field; `undefined` leaves it unchanged.
   * - `beats` replaces the whole ordered list (ids preserved when supplied).
   * - Refreshes `updatedAt` and re-validates the merged plan.
   */
  async updatePlan(projectId: string, input: UpdateNarrativeInput): Promise<NarrativePlan> {
    let existing: NarrativePlan | null;
    try {
      existing = await this.repository.getByProjectId(projectId);
    } catch (error) {
      throw this.wrap(error, `Failed to load the narrative plan of project "${projectId}"`);
    }
    if (!existing) {
      throw new NarrativeNotFoundError(projectId);
    }

    const merged: NarrativePlan = {
      ...existing,
      ...applyText('logline', input.logline),
      ...applyText('theme', input.theme),
      ...applyText('premise', input.premise),
      ...applyText('centralConflict', input.centralConflict),
      ...applyText('stakes', input.stakes),
      ...applyText('ending', input.ending),
      ...(input.structure !== undefined ? { structure: input.structure } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.beats !== undefined ? { beats: normalizeBeats(input.beats) } : {}),
      ...(input.motifs !== undefined ? { motifs: input.motifs } : {}),
      updatedAt: now(),
      // `id`, `projectId` and `createdAt` are never spread from input.
    };

    try {
      return await this.repository.update(merged);
    } catch (error) {
      throw this.wrap(error, `Failed to update the narrative plan of project "${projectId}"`);
    }
  }

  /** Deletes the plan of `projectId` (idempotent — no plan is a success). */
  async deletePlan(projectId: string): Promise<void> {
    try {
      await this.repository.deleteByProjectId(projectId);
    } catch (error) {
      throw this.wrap(error, `Failed to delete the narrative plan of project "${projectId}"`);
    }
  }

  /**
   * Re-throws known domain errors unchanged and wraps the rest, preserving the
   * original cause (same contract as `ProjectService.wrap`).
   */
  private wrap(error: unknown, message: string): Error {
    if (error instanceof ProjectRepositoryError) return error;
    if (error instanceof NarrativeServiceError) return error;
    if (error instanceof ProjectValidationError) return error;
    if (error instanceof NarrativeNotFoundError) return error;
    if (error instanceof ZodError) {
      return new ProjectValidationError(message, error.issues, error);
    }
    return new NarrativeServiceError(message, error);
  }
}

/**
 * Merges one nullable text field.
 *
 * `undefined` → key omitted (unchanged); `null` → cleared to ''; a string is
 * stored trimmed of surrounding whitespace only.
 */
function applyText(
  key: keyof NarrativePlan,
  next: string | null | undefined,
): Partial<NarrativePlan> {
  if (next === undefined) return {};
  return { [key]: next === null ? '' : next } as Partial<NarrativePlan>;
}

/**
 * Assigns a stable id to every beat and clamps positions into 0–100.
 *
 * Ids supplied by the caller are preserved so an edited beat keeps its
 * identity; new beats get a generated id.
 */
function normalizeBeats(beats: PlotBeatInput[]): PlotBeat[] {
  return beats.map((beat) => ({
    id: beat.id && beat.id.trim() !== '' ? beat.id : createPlotBeatId(),
    title: beat.title,
    description: beat.description ?? '',
    position: clampPosition(beat.position),
  }));
}

/** Coerces a number into an integer percentage within 0–100. */
function clampPosition(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}
