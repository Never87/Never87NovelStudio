import { z } from 'zod';
import {
  TransferIntegritySchema,
  TransferProjectSchema,
} from './transfer';

/**
 * Project snapshot schema (P9 Batch 3-1) — single source of truth.
 *
 * A `ProjectSnapshot` is an IMMUTABLE, point-in-time capture of exactly one
 * project and everything it owns. It is the persisted form of the B1 transfer
 * layer's single-project payload: `payload` is a full `TransferProject`
 * (`{project, data, integrity}`) produced by `TransferService.exportProject`.
 *
 * ## Why it reuses the transfer schema instead of duplicating it
 *
 * The B1 foundation was explicitly designed so that "Project Snapshots
 * (`.n87snapshot` later)" share the same envelope (`src/schemas/transfer.ts`).
 * Reusing `TransferProjectSchema` means:
 *   - the payload is validated by the SAME rules a package/import is;
 *   - `integrity` (a SHA-256 over `{project, data}`) is already defined;
 *   - a snapshot can be re-validated with `validateTransferPackage` (wrap it as
 *     a one-project envelope) without a second reader.
 *
 * ## Payload completeness & immutability
 *
 * `payload` MUST contain the COMPLETE project data — all 19 project-owned
 * collections, never a subset. Snapshots are immutable once written: the
 * repository never updates `label`/`payload` in place; a new capture is a new
 * row. This keeps the integrity digest durable and makes a restore's source
 * trustworthy.
 *
 * ## Two version numbers (do NOT conflate — mirrors transfer semantics)
 *
 *   - `schemaVersion` — the Dexie/domain schema version the snapshot was
 *     CAPTURED from (recorded for diagnostics / future migration decisions).
 *   - `formatVersion` — the transfer envelope version the payload conforms to.
 *
 * `snapshot.formatVersion` equals `payload`'s transfer format version and
 * `snapshot.schemaVersion` is the DB schema version at capture time. They are
 * stored separately so a snapshot stays self-describing even if either evolves.
 *
 * tsconfig constraints honoured here:
 *   - `erasableSyntaxOnly`: no `enum`; literal unions + `z.enum`.
 *   - `verbatimModuleSyntax`: type-only imports use `import type`.
 */

/* -------------------------------------------------------------------------- */
/* Reasons                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Why a snapshot was captured.
 *
 *   - `manual`      — the user explicitly created it.
 *   - `pre-restore` — captured automatically immediately before a destructive
 *                     restore so the pre-restore state can be recovered (B3-2).
 */
export const SNAPSHOT_REASONS = ['manual', 'pre-restore'] as const;

export const SnapshotReasonSchema = z.enum(SNAPSHOT_REASONS);

export type SnapshotReason = z.infer<typeof SnapshotReasonSchema>;

/* -------------------------------------------------------------------------- */
/* Snapshot record                                                            */
/* -------------------------------------------------------------------------- */

/** Upper bound for a snapshot label (it is a name, not a document). */
export const MAX_SNAPSHOT_LABEL_CHARS = 200;

/** Unix epoch milliseconds. Rejects negatives and non-integers. */
const timestampSchema = z
  .number()
  .int('Timestamp must be an integer')
  .nonnegative('Timestamp must be non-negative');

/**
 * Per-collection row counts captured at snapshot time.
 *
 * Keyed by the `TransferProjectData` collection name (`worlds`, `chapters`, …).
 * Denormalised so a list/inspection view never has to load and count the full
 * `payload`. Values are non-negative integers.
 */
export const SnapshotCountsSchema = z.record(
  z.string().min(1),
  z.number().int('Count must be an integer').nonnegative('Count must be non-negative'),
);

export type SnapshotCounts = z.infer<typeof SnapshotCountsSchema>;

/**
 * A persisted, immutable point-in-time capture of one project.
 *
 * The metadata columns (`projectId`, `label`, `reason`, `createdAt`,
 * `projectTitle`, `counts`, `wordCount`, `integrity`) are ALL denormalised from
 * `payload` so listing a project's snapshots is a cheap indexed read that never
 * deserialises the (potentially large) payload object.
 */
export const ProjectSnapshotSchema = z
  .object({
    /** Stable primary key, prefixed (`snap_…`). */
    id: z.string().min(1, 'Snapshot id is required'),
    /** The project this snapshot captures. Strict ownership scope. */
    projectId: z.string().min(1, 'Snapshot projectId is required'),
    /** User-provided label. Empty is allowed (unnamed snapshot). */
    label: z.string().trim().max(MAX_SNAPSHOT_LABEL_CHARS, `Label must be at most ${MAX_SNAPSHOT_LABEL_CHARS} characters`),
    /** Why the snapshot was captured. */
    reason: SnapshotReasonSchema,
    /** When the snapshot was captured (epoch ms). Immutable. */
    createdAt: timestampSchema,
    /** Dexie/domain schema version the project data was captured from. */
    schemaVersion: z.number().int('schemaVersion must be an integer').positive('schemaVersion must be positive'),
    /** Transfer envelope version the payload conforms to. */
    formatVersion: z.number().int('formatVersion must be an integer').positive('formatVersion must be positive'),
    /** The captured project title (denormalised for list display). */
    projectTitle: z.string().trim().max(200, 'Project title must be at most 200 characters'),
    /** Row count per owned collection (denormalised for list display). */
    counts: SnapshotCountsSchema,
    /** Total written words in the captured project (denormalised). */
    wordCount: z.number().int('wordCount must be an integer').nonnegative('wordCount must be non-negative'),
    /**
     * Integrity digest over the full payload. MUST equal `payload.integrity`
     * (enforced below) so the digest can be checked without trusting the
     * exporter and there is exactly ONE source of truth for the hash.
     */
    integrity: TransferIntegritySchema,
    /** The COMPLETE captured project (project row + all owned collections). */
    payload: TransferProjectSchema,
  })
  .strict()
  // The denormalised digest must match the payload's own digest: a single
  // source of truth, so a tampered column can never disagree with the data.
  .refine((snapshot) => snapshot.integrity.digest === snapshot.payload.integrity.digest, {
    message: 'Snapshot integrity must match payload.integrity',
    path: ['integrity'],
  })
  // The denormalised projectId must match the captured project's id.
  .refine((snapshot) => snapshot.projectId === snapshot.payload.project.id, {
    message: 'Snapshot projectId must match payload.project.id',
    path: ['projectId'],
  });

export type ProjectSnapshot = z.infer<typeof ProjectSnapshotSchema>;
