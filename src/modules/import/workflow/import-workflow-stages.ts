import type {
  DocumentFormat,
  DocumentSection,
  DocumentSectionLevel,
  ExtractionKind,
  SourceDocument,
} from '@/types';
import { EXTRACTION_KINDS } from '@/types';
import { MAX_DOCUMENT_CHARS } from '@/schemas/document';

/**
 * Pure helpers for the P8 import workflow UI.
 *
 * This module owns the PRESENTATION-LEVEL rules that span more than one stage of
 * the workflow (Import → Parser → Structure → Extraction → Review →
 * Integration). It contains no React, no Dexie and no business rules: every
 * decision about whether an operation is ALLOWED lives in the existing P8
 * services (`ImportService`, `ExtractionService`, `ReviewService`,
 * `IntegrationService`). These helpers only decide what to SHOW, so the UI can
 * never disagree with the services about the underlying data.
 *
 * Keeping them pure and exported makes them verifiable in the browser
 * verification scripts without mounting React.
 */

/* -------------------------------------------------------------------------- */
/* Stages                                                                     */
/* -------------------------------------------------------------------------- */

/** The six workflow stages exposed in the "Import & Analysis" section. */
export type ImportWorkflowStage =
  | 'import'
  | 'parser'
  | 'structure'
  | 'extraction'
  | 'review'
  | 'integration';

export interface ImportWorkflowStageMeta {
  stage: ImportWorkflowStage;
  /** Nav id of the route that hosts this stage. */
  navId: string;
  /** Canonical route path (must match `config/navigation.ts`). */
  path: string;
  title: string;
  /** One-line explanation of what the stage produces. */
  summary: string;
}

/**
 * Ordered stage metadata.
 *
 * The first four stages are the ones THIS brick implements (`import`, `parser`,
 * `structure`, `extraction`). `review` and `integration` are listed so the
 * stepper can link to them, but their pages are NOT modified here — they stay
 * the authoritative review/integration surfaces (P8 Batch 4 / 5).
 */
export const IMPORT_WORKFLOW_STAGES: ImportWorkflowStageMeta[] = [
  {
    stage: 'import',
    navId: 'manuscript-import',
    path: '/import/manuscript',
    title: 'Manuscript Import',
    summary: 'Register TXT / Markdown files or pasted text against a project.',
  },
  {
    stage: 'parser',
    navId: 'document-parser',
    path: '/import/document-parser',
    title: 'Document Parser',
    summary: 'Parse the raw text into addressable sections and inspect the result.',
  },
  {
    stage: 'structure',
    navId: 'structure-recognition',
    path: '/import/structure-recognition',
    title: 'Structure Recognition',
    summary: 'Review and correct the detected hierarchy, then confirm it.',
  },
  {
    stage: 'extraction',
    navId: 'information-extraction',
    path: '/import/information-extraction',
    title: 'Information Extraction',
    summary: 'Produce review-pending candidates grounded in confirmed sections.',
  },
  {
    stage: 'review',
    navId: 'extraction-review',
    path: '/import/review-center',
    title: 'Extraction Review Center',
    summary: 'Confirm, edit, reject or merge each candidate.',
  },
  {
    stage: 'integration',
    navId: 'project-integration',
    path: '/import/project-integration',
    title: 'Project Integration',
    summary: 'Merge confirmed candidates into the project data model.',
  },
];

export function getStageMeta(stage: ImportWorkflowStage): ImportWorkflowStageMeta {
  const meta = IMPORT_WORKFLOW_STAGES.find((candidate) => candidate.stage === stage);
  if (!meta) throw new Error(`[import-workflow] unknown stage "${stage}"`);
  return meta;
}

/* -------------------------------------------------------------------------- */
/* Document lifecycle (derived, never stored)                                 */
/* -------------------------------------------------------------------------- */

/**
 * A document's progress through the pipeline, as the UI understands it.
 *
 * Derived ONLY from persisted fields (`status`, `structureConfirmedAt`) and the
 * section count — never cached in the UI, so it can never drift from the DB.
 *
 *   - `imported`   — registered, no sections yet (or never parsed).
 *   - `parsed`     — sections exist, structure NOT confirmed.
 *   - `confirmed`  — sections exist AND `structureConfirmedAt` is set.
 *   - `extracted`  — at least one extraction run has been recorded.
 */
export type DocumentLifecyclePhase = 'imported' | 'parsed' | 'confirmed' | 'extracted';

export interface DocumentLifecycle {
  phase: DocumentLifecyclePhase;
  /** Human label for badges. */
  label: string;
  /** Next action the user should take, or null when nothing is pending. */
  nextAction: string | null;
  /** True when `ImportService` will accept extraction (`getConfirmedSections`). */
  structureConfirmed: boolean;
  /** True when the document has been parsed at least once. */
  parsed: boolean;
}

export function describeDocumentLifecycle(
  document: Pick<SourceDocument, 'status' | 'structureConfirmedAt'>,
  sectionCount: number,
): DocumentLifecycle {
  const structureConfirmed = document.structureConfirmedAt != null;
  if (document.status === 'extracted') {
    return {
      phase: 'extracted',
      label: 'Extracted',
      nextAction: 'Review the candidates in the Extraction Review Center.',
      structureConfirmed,
      parsed: true,
    };
  }
  if (document.status === 'imported' || sectionCount === 0) {
    return {
      phase: 'imported',
      label: 'Not parsed',
      nextAction: 'Parse the document to produce sections.',
      structureConfirmed: false,
      parsed: false,
    };
  }
  if (structureConfirmed) {
    return {
      phase: 'confirmed',
      label: 'Structure confirmed',
      nextAction: 'Run information extraction on the confirmed structure.',
      structureConfirmed: true,
      parsed: true,
    };
  }
  return {
    phase: 'parsed',
    label: 'Structure unconfirmed',
    nextAction: 'Review the detected structure, then confirm it.',
    structureConfirmed: false,
    parsed: true,
  };
}

/* -------------------------------------------------------------------------- */
/* Format support                                                             */
/* -------------------------------------------------------------------------- */

/** Formats the importer accepts today (mirrors `DOCUMENT_FORMATS`). */
export const SUPPORTED_IMPORT_FORMATS = ['txt', 'markdown'] as const;

/** File-picker `accept` value covering the supported extensions. */
export const IMPORT_ACCEPT_ATTRIBUTE = '.txt,.md,.markdown,text/plain,text/markdown';

/** Extensions → format, in the order the file picker may report them. */
const EXTENSION_FORMATS: Array<{ test: RegExp; format: DocumentFormat }> = [
  { test: /\.(md|markdown)$/i, format: 'markdown' },
  { test: /\.txt$/i, format: 'txt' },
];

/**
 * Infers the document format from a file name.
 *
 * Returns `null` for anything else (DOCX/PDF/unknown) so the caller can reject
 * the file with a precise message INSTEAD of silently importing it as `txt`,
 * which would store binary garbage as a manuscript. `fallback` is used when the
 * name has no extension at all (some browsers omit it for pasted/dropped text).
 */
export function inferDocumentFormat(fileName: string, fallback: DocumentFormat = 'txt'): DocumentFormat | null {
  const name = fileName.trim();
  if (!name) return fallback;
  for (const entry of EXTENSION_FORMATS) {
    if (entry.test.test(name)) return entry.format;
  }
  // No recognised extension: treat as plain text ONLY when there is no
  // extension at all. A known-unsupported extension must be rejected.
  const hasExtension = /\.[A-Za-z0-9]{1,5}$/.test(name);
  return hasExtension ? null : fallback;
}

/** User-facing explanation of the current format limitations. */
export const IMPORT_FORMAT_LIMITS = [
  'Supported formats: plain text (.txt) and Markdown (.md, .markdown).',
  'DOCX and PDF are not supported yet — export them to .txt or Markdown first.',
  'The text is stored verbatim; parsing never rewrites it.',
];

/**
 * Validates raw text before it reaches `ImportService`.
 *
 * Mirrors the schema/service limits so the user gets the reason immediately
 * instead of a validation error after the write attempt. Returns `null` when the
 * text is acceptable.
 */
export function validateRawText(rawText: string): string | null {
  if (typeof rawText !== 'string') return 'No text was supplied.';
  if (rawText.length === 0) return 'The document is empty. Add some text first.';
  if (rawText.trim().length === 0) {
    return 'The document contains only whitespace. Add some text first.';
  }
  if (rawText.length > MAX_DOCUMENT_CHARS) {
    return `The document is ${rawText.length.toLocaleString()} characters; the limit is ${MAX_DOCUMENT_CHARS.toLocaleString()}. Split it into smaller files.`;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Duplicate protection                                                       */
/* -------------------------------------------------------------------------- */

/** Normalises a file name for duplicate comparison (case/space insensitive). */
export function normaliseFileName(fileName: string | null | undefined): string {
  return (fileName ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Best-effort synchronous duplicate detection for the Import stage.
 *
 * The service layer has NO duplicate rule for documents (each import creates a
 * new id), so the UI must surface the choice explicitly rather than let the user
 * silently accumulate copies. This compares normalised file name AND the exact
 * raw text — enough to warn about a re-import immediately, before any write.
 *
 * The page additionally compares `hashRawText(rawText)` against each stored
 * `parsedTextHash` before writing, so a byte-identical re-import of an already
 * parsed document is caught even if its text is not loaded here.
 */
export function findPotentialDuplicate(
  documents: ReadonlyArray<SourceDocument>,
  input: { fileName: string | null; rawText: string },
): { byName: SourceDocument[]; identical: SourceDocument[] } {
  const name = normaliseFileName(input.fileName);
  const byName = name
    ? documents.filter((doc) => normaliseFileName(doc.fileName) === name)
    : [];
  const identical = documents.filter(
    (doc) => doc.rawText.length === input.rawText.length && doc.rawText === input.rawText,
  );
  return { byName, identical };
}

/* -------------------------------------------------------------------------- */
/* Section tree                                                               */
/* -------------------------------------------------------------------------- */

export interface SectionTreeNode {
  section: DocumentSection;
  /** Nesting depth (0 at the root). */
  depth: number;
  /** Direct children, in `order`. */
  children: SectionTreeNode[];
}

/**
 * Builds the display tree from a flat, document-ordered section list.
 *
 * Sections are grouped by `parentId` and sorted by their document-wide `order`
 * (the service guarantees a single ascending sequence), so this mirrors exactly
 * what `Structure Recognition` will display and what `reorderSections` expects.
 * Orphaned sections (parent id missing from the list) are promoted to the root
 * rather than dropped — the UI must never hide data.
 */
export function buildSectionTree(sections: ReadonlyArray<DocumentSection>): SectionTreeNode[] {
  const ordered = [...sections].sort((a, b) => a.order - b.order);
  const byId = new Map(ordered.map((section) => [section.id, section]));
  const childrenOf = new Map<string | null, DocumentSection[]>();

  for (const section of ordered) {
    const parentKey = section.parentId && byId.has(section.parentId) ? section.parentId : null;
    const bucket = childrenOf.get(parentKey);
    if (bucket) bucket.push(section);
    else childrenOf.set(parentKey, [section]);
  }

  const build = (parentKey: string | null, depth: number): SectionTreeNode[] =>
    (childrenOf.get(parentKey) ?? []).map((section) => ({
      section,
      depth,
      children: build(section.id, depth + 1),
    }));

  return build(null, 0);
}

/** Flattens a tree back into document order (depth-first, `order`-sorted). */
export function flattenSectionTree(nodes: ReadonlyArray<SectionTreeNode>): SectionTreeNode[] {
  const out: SectionTreeNode[] = [];
  const walk = (list: ReadonlyArray<SectionTreeNode>) => {
    for (const node of list) {
      out.push(node);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/** Counts sections per level (for the parser summary). */
export function countSectionsByLevel(
  sections: ReadonlyArray<DocumentSection>,
): Record<DocumentSectionLevel, number> {
  const counts: Record<DocumentSectionLevel, number> = {
    volume: 0,
    chapter: 0,
    scene: 0,
    paragraph: 0,
  };
  for (const section of sections) counts[section.level] += 1;
  return counts;
}

/** Level rank shared with `ImportService` (a child must strictly outrank its parent). */
export const SECTION_LEVEL_RANK: Record<DocumentSectionLevel, number> = {
  volume: 0,
  chapter: 1,
  scene: 2,
  paragraph: 3,
};

/**
 * Candidate parents for a section, matching `ImportService.validateParent`.
 *
 * Excludes the section itself and all of its descendants (cycles) and anything
 * whose level does not strictly outrank the section's level. Offering only valid
 * options prevents the user from making a change the service will reject.
 */
export function listValidParents(
  sections: ReadonlyArray<DocumentSection>,
  section: DocumentSection,
): Array<DocumentSection | null> {
  const byId = new Map(sections.map((candidate) => [candidate.id, candidate]));

  // Collect descendants of `section` so they can never become its parent.
  const descendants = new Set<string>();
  const stack = [section.id];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const candidate of sections) {
      if (candidate.parentId === current && !descendants.has(candidate.id)) {
        descendants.add(candidate.id);
        stack.push(candidate.id);
      }
    }
  }

  const valid = sections.filter(
    (candidate) =>
      candidate.id !== section.id &&
      !descendants.has(candidate.id) &&
      SECTION_LEVEL_RANK[candidate.level] < SECTION_LEVEL_RANK[section.level],
  );
  // Keep the document order for a stable, predictable list.
  return [null, ...valid.sort((a, b) => a.order - b.order)].map((candidate) =>
    candidate === null ? null : (byId.get(candidate.id) ?? null),
  ) as Array<DocumentSection | null>;
}

/** Levels strictly below `level` (valid child levels), used by the level picker. */
export function listChildLevels(level: DocumentSectionLevel): DocumentSectionLevel[] {
  const all: DocumentSectionLevel[] = ['volume', 'chapter', 'scene', 'paragraph'];
  return all.filter((candidate) => SECTION_LEVEL_RANK[candidate] > SECTION_LEVEL_RANK[level]);
}

/* -------------------------------------------------------------------------- */
/* Extraction readiness                                                       */
/* -------------------------------------------------------------------------- */

export interface ExtractionReadiness {
  /** True when the service will accept a manual/AI extraction for this doc. */
  ready: boolean;
  /** The reason extraction is blocked, or null when ready. */
  reason: string | null;
  /** Section count (for the "nothing to extract" case). */
  sectionCount: number;
}

/** Whether extraction can run for a document, mirroring
 * `ExtractionService.loadConfirmedSections` (which throws
 * `ExtractionValidationError('unconfirmed-structure')`).
 *
 * The service remains the gate; this only lets the page DISABLE the action and
 * explain why instead of surfacing a service error after a click.
 */
export function describeExtractionReadiness(
  document: Pick<SourceDocument, 'status' | 'structureConfirmedAt'>,
  sectionCount: number,
): ExtractionReadiness {
  if (document.status === 'imported' || sectionCount === 0) {
    return {
      ready: false,
      reason: 'Parse this document first — extraction needs addressable sections.',
      sectionCount,
    };
  }
  if (document.structureConfirmedAt == null) {
    return {
      ready: false,
      reason: 'Confirm the document structure before extracting. Confirmation is the gate extraction relies on.',
      sectionCount,
    };
  }
  return { ready: true, reason: null, sectionCount };
}

/**
 * Validates the MANUAL candidate form BEFORE it reaches the service.
 *
 * Mirrors the `CreateManualExtractionInput` / evidence rules so the user sees
 * the problem inline instead of as a thrown service error:
 *   - title is required, trimmed (dedupe keys depend on it),
 *   - at least one evidence quote is required,
 *   - every quote must be non-empty.
 *
 * Whether the quote is VERBATIM in the section, resolves to exactly one location
 * and stays within that section is decided by the service against the stored raw
 * text — this helper cannot and must not pre-judge that.
 */
export interface ManualExtractionDraft {
  kind: string;
  title: string;
  summary: string;
  body: string;
  sectionId: string;
  quote: string;
}

export function validateManualExtractionDraft(draft: ManualExtractionDraft): string[] {
  const problems: string[] = [];
  if (!draft.title.trim()) problems.push('A title is required.');
  if (!draft.sectionId) problems.push('Choose the section the quote comes from.');
  if (!draft.quote.trim()) {
    problems.push('An evidence quote is required — every candidate must be grounded in the text.');
  }
  return problems;
}

/**
 * A quick, NON-AUTHORITATIVE hint for the manual form: does the quote appear at
 * all in the chosen section's text?
 *
 * The authoritative check (exactly one occurrence, correct section) is performed
 * by the service. This only helps the user see a typo early; it never blocks the
 * submit on its own beyond what `validateManualExtractionDraft` requires.
 */
export function quoteAppearsInSection(quote: string, sectionText: string): boolean {
  if (!quote.trim()) return false;
  return sectionText.includes(quote);
}

/**
 * Kinds the AI extraction path accepts.
 *
 * Re-exported from the schema (single source of truth) instead of being
 * duplicated, so the picker can never offer a kind the AI parser rejects.
 */
export const AI_EXTRACTION_KINDS: ReadonlyArray<ExtractionKind> = EXTRACTION_KINDS;

/** Default cap offered in the UI for how many sections to send to the model. */
export const DEFAULT_AI_SECTION_LIMIT = 40;
