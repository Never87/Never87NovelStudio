import type { AiMessage } from '@/types';
import type { ChapterAnalysisEntity, ChapterAnalysisRelationship } from '@/types';
import {
  ANALYSIS_ENTITY_KINDS,
  AnalysisEntityStatusSchema,
  buildEntityKey,
  normalizeCandidateName,
} from '@/schemas/chapter-analysis';
import { groundChapterQuotes } from '@/utils/chapter-evidence';
import { z } from 'zod';

/** Builds the initial (unreviewed / unintegrated) integration state for a candidate. */
function emptyIntegrationState(): ChapterAnalysisEntity['integration'] {
  return {
    status: 'unreviewed',
    canonicalType: 'none',
    canonicalEntityId: null,
    matchedBy: 'none',
    possibleDuplicateId: null,
    possibleDuplicateLabel: '',
    decidedAt: null,
  };
}

/**
 * AI prompt + parsing for chapter analysis (P11).
 *
 * Kept separate from the service so the pure, unit-testable pieces (message
 * building + strict JSON parsing) can be imported by verification harnesses
 * without dragging in the Dexie/service singletons.
 *
 * The model is instructed to return STRICT JSON only; its output is validated
 * with Zod before ANY persistence. Malformed output throws
 * `ChapterAnalysisParseError` (the service maps it to a domain error).
 */

/** Raised when the model's JSON output cannot be parsed/validated. */
export class ChapterAnalysisParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChapterAnalysisParseError';
  }
}

/** A single candidate entity as the model reported it (pre-normalisation). */
export interface RawCandidateEntity {
  kind: string;
  name: string;
  summary: string;
  detail: string;
  tags: string[];
  /** Short verbatim passages from the chapter supporting this entity. */
  quotes: string[];
  /** Alternate names / aliases the model associated with this entity. */
  aliases: string[];
  confidence: number | null;
}

/** A single relationship as the model reported it (by names + kinds). */
export interface RawCandidateRelationship {
  relation: string;
  fromKind: string;
  fromName: string;
  toKind: string;
  toName: string;
  summary: string;
  /** Short verbatim passages from the chapter supporting this relationship. */
  quotes: string[];
  confidence: number | null;
}

export interface ParsedAnalysis {
  entities: RawCandidateEntity[];
  relationships: RawCandidateRelationship[];
}

/* -------------------------------------------------------------------------- */
/* Prompt                                                                     */
/* -------------------------------------------------------------------------- */

/** Builds the system + user messages instructing the model to return JSON. */
export function buildChapterAnalysisMessages(input: {
  chapterTitle: string;
  prose: string;
  instruction?: string;
  /** Optional pre-known entity names to help the model stay consistent. */
  knownNames?: string[];
}): AiMessage[] {
  const system =
    'You are a precise story analyst for a novel manuscript. ' +
    'Read the chapter prose and extract the STORY ENTITIES it actually contains and the RELATIONSHIPS between them. ' +
    'Extract ONLY what the prose directly supports; never invent facts or entities. ' +
    'Entity kinds allowed: ' +
    ANALYSIS_ENTITY_KINDS.join(', ') +
    '. ' +
    'Return ONLY a JSON object of the form ' +
    '{"entities":[{"kind","name","summary","detail","tags","aliases","quotes","confidence"}],' +
    '"relationships":[{"relation","fromKind","fromName","toKind","toName","summary","quotes","confidence"}]} ' +
    'with no prose or markdown fences. Every relationship endpoint MUST name an entity present in "entities". ' +
    'CRITICAL: "quotes" MUST be short passages copied VERBATIM (character for character) from the chapter prose that ' +
    'directly support the entity/relationship. Never paraphrase a quote and never invent one — an unsupported quote is ' +
    'discarded. Provide one or more quotes per item when appropriate.';

  const known = (input.knownNames ?? []).filter((n) => n.trim().length > 0);
  const user = [
    `Chapter: ${input.chapterTitle}`,
    input.instruction ? `Additional focus: ${input.instruction}` : '',
    known.length > 0
      ? `Prefer these existing names for consistency when they appear: ${known.join(', ')}`
      : '',
    '',
    'Rules:',
    '  - kind must be one of the allowed kinds.',
    '  - summary: one concise line. detail: a short paragraph of portrayal/notes.',
    '  - tags: 0–8 short lowercase labels.',
    '  - aliases: 0–3 alternate names/titles/nicknames the prose uses for this entity.',
    '  - quotes: short passages copied VERBATIM from the prose (do not paraphrase).',
    '  - confidence: a number from 0 to 1 (advisory).',
    "  - A relationship's from/to entities must each appear in \"entities\".",
    '',
    'CHAPTER PROSE:',
    '"""',
    input.prose,
    '"""',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/* -------------------------------------------------------------------------- */
/* Parsing + validation                                                      */
/* -------------------------------------------------------------------------- */

const RawEntitySchema = z
  .object({
    kind: z.string().min(1),
    name: z.string().trim().min(1).max(200),
    summary: z.string().max(1_000).optional().default(''),
    detail: z.string().max(20_000).optional().default(''),
    tags: z.array(z.string()).optional().default([]),
    aliases: z.array(z.string().trim().min(1).max(200)).optional().default([]),
    quotes: z.array(z.string()).optional().default([]),
    confidence: z.number().min(0).max(1).nullable().optional().default(null),
  })
  .passthrough();

const RawRelationshipSchema = z
  .object({
    relation: z.string().trim().min(1).max(120),
    fromKind: z.string().min(1),
    fromName: z.string().trim().min(1).max(200),
    toKind: z.string().min(1),
    toName: z.string().trim().min(1).max(200),
    summary: z.string().max(1_000).optional().default(''),
    quotes: z.array(z.string()).optional().default([]),
    confidence: z.number().min(0).max(1).nullable().optional().default(null),
  })
  .passthrough();

const RawAnalysisSchema = z
  .object({
    entities: z.array(RawEntitySchema).max(500).optional().default([]),
    relationships: z.array(RawRelationshipSchema).max(1_000).optional().default([]),
  })
  .passthrough();

const KIND_SET = new Set<string>(ANALYSIS_ENTITY_KINDS);

/** Strips a single wrapping ```json … ``` fence, if present. */
function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[a-zA-Z0-9]*\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

/**
 * Parses the model's raw response into validated raw candidates.
 *
 * Tolerant of a wrapping fence, but otherwise strict: a malformed response
 * throws `ChapterAnalysisParseError`. Unknown entity kinds are dropped (never
 * coerced). Relationships whose endpoints do not resolve to a kept entity are
 * dropped (never persisted dangling).
 */
export function parseAnalysisResponse(content: string): ParsedAnalysis {
  const json = stripJsonFence(content);
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new ChapterAnalysisParseError(`AI response was not valid JSON: ${(error as Error).message}`);
  }

  const parsed = RawAnalysisSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ChapterAnalysisParseError(
      `AI response did not match the expected schema: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }

  // Keep only known kinds, dedupe by stable key (first occurrence wins).
  const seenKeys = new Set<string>();
  const entities: RawCandidateEntity[] = [];
  for (const e of parsed.data.entities) {
    if (!KIND_SET.has(e.kind)) continue;
    const key = buildEntityKey(e.kind, e.name);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    entities.push({
      kind: e.kind,
      name: e.name,
      summary: e.summary,
      detail: e.detail,
      tags: e.tags.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0 && t.length <= 80).slice(0, 50),
      aliases: e.aliases.map((a) => a.trim()).filter((a) => a.length > 0).slice(0, 20),
      quotes: e.quotes.filter((q) => typeof q === 'string' && q.length > 0).slice(0, 20),
      confidence: e.confidence,
    });
  }

  const relationships: RawCandidateRelationship[] = [];
  for (const r of parsed.data.relationships) {
    if (!KIND_SET.has(r.fromKind) || !KIND_SET.has(r.toKind)) continue;
    const fromKey = buildEntityKey(r.fromKind, r.fromName);
    const toKey = buildEntityKey(r.toKind, r.toName);
    if (!seenKeys.has(fromKey) || !seenKeys.has(toKey)) continue;
    if (fromKey === toKey) continue;
    relationships.push({
      relation: r.relation,
      fromKind: r.fromKind,
      fromName: r.fromName,
      toKind: r.toKind,
      toName: r.toName,
      summary: r.summary,
      quotes: r.quotes.filter((q) => typeof q === 'string' && q.length > 0).slice(0, 20),
      confidence: r.confidence,
    });
  }

  return { entities, relationships };
}

/* -------------------------------------------------------------------------- */
/* Candidate construction (pure)                                              */
/* -------------------------------------------------------------------------- */

/**
 * Builds a fresh, UNREVIEWED candidate entity (`status: 'proposed'`) from a raw
 * candidate. `key` is the stable relationship anchor derived from kind + name.
 *
 * When `prose` is supplied, each model quote is GROUNDED against it: only
 * quotes that appear verbatim are kept, with exact `start`/`end` offsets. An
 * unsupported quote is DROPPED (never persisted with a fabricated offset). A
 * candidate with zero grounded quotes is still returned (its evidence is empty)
 * so the UI can surface it as "unsupported" for the author to reject.
 */
export function toCandidateEntity(raw: RawCandidateEntity, prose?: string): ChapterAnalysisEntity {
  const grounded = prose !== undefined ? groundChapterQuotes(prose, raw.quotes ?? []) : [];
  return {
    key: buildEntityKey(raw.kind, raw.name),
    kind: raw.kind as ChapterAnalysisEntity['kind'],
    name: raw.name,
    summary: raw.summary,
    detail: raw.detail,
    tags: raw.tags,
    status: AnalysisEntityStatusSchema.enum.proposed,
    linkedEntityId: null,
    evidence: grounded.map((g) => ({
      quote: g.quote,
      offset: g.start,
      start: g.start,
      end: g.end,
      grounded: true,
      note: '',
    })),
    aliases: raw.aliases ?? [],
    integration: emptyIntegrationState(),
    reviewed: false,
    confidence: raw.confidence,
  };
}

/**
 * Builds a candidate relationship from a raw relationship, resolving the two
 * endpoints to their stable candidate keys. `index` keeps keys unique per run.
 * When `prose` is supplied, relationship quotes are grounded into evidence.
 */
export function toCandidateRelationship(
  raw: RawCandidateRelationship,
  index: number,
  prose?: string,
): ChapterAnalysisRelationship {
  const fromKey = buildEntityKey(raw.fromKind, raw.fromName);
  const toKey = buildEntityKey(raw.toKind, raw.toName);
  const grounded = prose !== undefined ? groundChapterQuotes(prose, raw.quotes ?? []) : [];
  return {
    key: `rel:${index}:${fromKey}->${toKey}`,
    relation: raw.relation,
    fromKey,
    toKey,
    summary: raw.summary,
    status: AnalysisEntityStatusSchema.enum.proposed,
    linkedFromEntityId: null,
    linkedToEntityId: null,
    evidence: grounded.map((g) => ({
      quote: g.quote,
      offset: g.start,
      start: g.start,
      end: g.end,
      grounded: true,
      note: '',
    })),
    integration: emptyIntegrationState(),
    reviewed: false,
    confidence: raw.confidence,
  };
}

/** Exposed for tests: normalized key helper re-exported at this boundary. */
export { normalizeCandidateName };
