import { z } from 'zod';
import { EvidenceSchema } from './knowledge';

/**
 * Story-analysis domain schemas (P7) — single source of truth.
 *
 * The Plot Hole Detector produces `AnalysisFinding` records. Every finding MUST
 * carry at least one valid, traceable `Evidence` record (chapter/scene locator
 * minimum) — unsupported conclusions are rejected at the SCHEMA level, not just
 * by convention. This is the schema-level enforcement of the "no unsupported
 * conclusion" rule.
 *
 * Analysis is DETERMINISTIC-FIRST: the built-in detectors (`AnalysisService`)
 * find issues by cross-referencing continuity facts, world rules, focus
 * characters and foreshadowing. AI-assisted suggestions were specified as an
 * OPTIONAL future path but are NOT implemented in this phase; the `origin: 'ai'`
 * enum value is reserved so a future, explicitly user-triggered, evidence-backed
 * AI suggestion can be recorded through the same reviewed `saveDraft` path.
 *
 * tsconfig constraints honoured here:
 *   - `erasableSyntaxOnly`: no `enum`; literal unions + `z.enum`.
 *   - `verbatimModuleSyntax`: type-only imports use `import type`.
 */

/* -------------------------------------------------------------------------- */
/* Finding classification                                                     */
/* -------------------------------------------------------------------------- */

/** Category of a detected issue. */
export const ANALYSIS_CATEGORIES = [
  'timeline',
  'continuity',
  'character',
  'world-rule',
  'foreshadowing',
  'logic',
] as const;
export const AnalysisCategorySchema = z.enum(ANALYSIS_CATEGORIES);
export type AnalysisCategory = z.infer<typeof AnalysisCategorySchema>;

/** How serious the issue is. */
export const ANALYSIS_SEVERITIES = ['info', 'warning', 'error'] as const;
export const AnalysisSeveritySchema = z.enum(ANALYSIS_SEVERITIES);
export type AnalysisSeverity = z.infer<typeof AnalysisSeveritySchema>;

/**
 * Review lifecycle of a finding.
 *
 *   - `open`       — detected and awaiting the user's judgement.
 *   - `confirmed`  — the user agrees it is a real issue.
 *   - `dismissed`  — the user disagrees / it is a false positive.
 *   - `resolved`   — the underlying issue has been fixed in the manuscript.
 */
export const ANALYSIS_STATUSES = ['open', 'confirmed', 'dismissed', 'resolved'] as const;
export const AnalysisStatusSchema = z.enum(ANALYSIS_STATUSES);
export type AnalysisStatus = z.infer<typeof AnalysisStatusSchema>;

/**
 * How a finding was produced.
 *
 *   - `deterministic` — a built-in detector over continuity/knowledge data.
 *   - `ai`            — an optional, user-triggered AI suggestion (still a
 *                       proposal: it starts `open` and requires evidence).
 *   - `manual`        — authored by the user directly.
 */
export const ANALYSIS_ORIGINS = ['deterministic', 'ai', 'manual'] as const;
export const AnalysisOriginSchema = z.enum(ANALYSIS_ORIGINS);
export type AnalysisOrigin = z.infer<typeof AnalysisOriginSchema>;

/* -------------------------------------------------------------------------- */
/* Findings                                                                   */
/* -------------------------------------------------------------------------- */

const timestampSchema = z
  .number()
  .int('Timestamp must be an integer')
  .nonnegative('Timestamp must be non-negative');

/**
 * A single detected issue.
 *
 * The `.refine` on `evidence` is the hard guarantee: a finding without at least
 * one evidence record cannot be validated, so it can never be persisted. The
 * database write path (Repository) validates against this schema, so an
 * evidence-less finding is rejected before it reaches storage.
 */
export const AnalysisFindingSchema = z
  .object({
    /** Stable primary key, prefixed (`find_…`). */
    id: z.string().min(1, 'Finding id is required'),
    /** Owning project. Indexed. */
    projectId: z.string().min(1, 'Finding projectId is required'),

    category: AnalysisCategorySchema,
    severity: AnalysisSeveritySchema,
    status: AnalysisStatusSchema,
    origin: AnalysisOriginSchema,

    /** Short title, e.g. "Character appears in two places". */
    title: z.string().trim().min(1, 'Title is required').max(200, 'Title must be at most 200 characters'),
    /** Human-readable explanation of the issue. */
    description: z.string().trim().min(1, 'Description is required').max(4_000, 'Description must be at most 4000 characters'),

    /**
     * REQUIRED, non-empty. Every finding must cite at least one traceable source
     * location (chapter or scene). Enforced here so persistence cannot bypass it.
     */
    evidence: z.array(EvidenceSchema).min(1, 'A finding must cite at least one evidence location').max(50),

    /** Optional link to the continuity fact(s) that triggered the finding. */
    relatedFactIds: z.array(z.string().min(1)).max(50).default([]),
    /** Optional link to knowledge entries / world rules involved. */
    relatedEntryIds: z.array(z.string().min(1)).max(50).default([]),

    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .refine((finding) => finding.updatedAt >= finding.createdAt, {
    message: 'updatedAt cannot be earlier than createdAt',
    path: ['updatedAt'],
  });

export type AnalysisFinding = z.infer<typeof AnalysisFindingSchema>;
