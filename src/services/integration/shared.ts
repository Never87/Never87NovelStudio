/**
 * Shared entity-integration logic (P8 Extraction ⇄ P11 Chapter Analysis).
 *
 * ## Why this module exists
 *
 * P8 (`IntegrationService`, imported documents) and P11
 * (`ChapterAnalysisIntegrationService`, live chapters) turn *reviewed* source
 * records into the SAME canonical project entities (`Character`, `World.sections`,
 * `KnowledgeEntry`). They have DIFFERENT source records, review workflows,
 * provenance and history — so their persistence layers must stay separate — but
 * the DECISIONS they make are identical:
 *
 *   - which canonical family a record KIND routes to,
 *   - how a candidate name is normalised / how aliases are derived,
 *   - how a proposed value maps onto a canonical entity's fields.
 *
 * Those are PURE functions with no I/O. This module is the single source of
 * truth for them, so the two pipelines can never drift on routing or matching.
 * It deliberately contains NO persistence, NO transactions and NO entity store —
 * each pipeline keeps writing through its own repositories/services.
 *
 * tsconfig constraints honoured here: no `enum`, type-only imports.
 */

import type { KnowledgeEntryKind } from '@/types';

/* -------------------------------------------------------------------------- */
/* Routing — record kind → canonical target family                            */
/* -------------------------------------------------------------------------- */

/**
 * The canonical family a reviewed record resolves to. This is the SHARED
 * vocabulary both pipelines use; it matches `IntegrationTargetType` (P8) and
 * `AnalysisCanonicalType` (P11) minus their sentinel values.
 */
export type CanonicalTargetKind = 'character' | 'world-section' | 'knowledge-entry';

/** Kinds that map onto a dedicated `Character` entity. */
export const CHARACTER_KINDS: ReadonlySet<string> = new Set(['character']);

/**
 * Kinds that map onto a `World` section (setting / world-building facts).
 *
 * Locations, factions and world rules are structural world-building, NOT loose
 * facts, so they belong in the World record's `sections` — never folded into a
 * generic knowledge entry.
 */
export const WORLD_KINDS: ReadonlySet<string> = new Set(['location', 'faction', 'rule']);

/**
 * The canonical target family a record kind routes to (pure, no I/O).
 *
 * Order of precedence: character → world-section → knowledge-entry. Shared by
 * P8 routing and P11 routing so both pipelines classify identically.
 */
export function targetKindForRecordKind(kind: string): CanonicalTargetKind {
  if (CHARACTER_KINDS.has(kind)) return 'character';
  if (WORLD_KINDS.has(kind)) return 'world-section';
  return 'knowledge-entry';
}

/**
 * P11-facing alias with the narrower legacy return vocabulary extended to
 * include `world-section`. Kept as a named helper so the analysis service and
 * its previews share ONE mapping with P8.
 */
export function canonicalTargetForKind(kind: KnowledgeEntryKind): CanonicalTargetKind {
  return targetKindForRecordKind(kind);
}

/**
 * The knowledge-entry KIND a record is indexed as when it does NOT route to a
 * character or world section. Relationship/style facts are folded into a generic
 * `concept` entry (they describe connections/voice, not a first-class entity).
 */
export function knowledgeKindForRecordKind(kind: string): KnowledgeEntryKind {
  if (kind === 'relationship' || kind === 'style') return 'concept';
  return kind as KnowledgeEntryKind;
}

/** Back-compat alias kept for existing P8 imports/tests. */
export const knowledgeKindFor = knowledgeKindForRecordKind;

