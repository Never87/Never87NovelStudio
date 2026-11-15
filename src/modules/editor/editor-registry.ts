/**
 * Editor coordination registry for full-project restore (P9 Batch 4-3).
 *
 * ## Why this exists
 *
 * A full-project RESTORE (a backup restore, or a snapshot restore) replaces the
 * entire project — including every chapter/scene draft. A live editor holds the
 * OLD prose in memory and has a debounced {@link AutosaveEngine} that may fire a
 * write AFTER the restore completes, silently resurrecting pre-restore text.
 *
 * The established protection for that race is the autosave engine's optimistic
 * concurrency (`expectedRevision` → `DraftConflictError`): a stale in-flight save
 * is rejected and the engine re-reads the current revision. That fully protects
 * OTHER TABS (which we cannot reach synchronously) and is unchanged here.
 *
 * For editors mounted in the SAME tab, though, we can do better: FLUSH their
 * pending autosave *before* the destructive restore, and REBIND/RELOAD them
 * *after* it. This module is the tab-local seam that makes that possible without
 * coupling the restore UI to the editor hooks.
 *
 * ## Contract
 *
 *  - An editor hook registers a {@link EditorHandle} on mount and unregisters on
 *    unmount. The handle exposes a `projectId`, a `flush()` (drain pending
 *    autosave) and a `reload()` (re-read its document from the database).
 *  - `flushProjectEditors(projectId)` awaits every registered editor for that
 *    project. The restore UI calls it BEFORE the restore.
 *  - `reloadProjectEditors(projectId)` reloads every registered editor for that
 *    project AFTER a successful restore, so the editor shows restored prose and
 *    its autosave baseline is the restored revision.
 *
 * This is INTENTIONALLY tab-local. It is NOT a cross-tab lock and NOT a data
 * channel; other tabs coordinate via `PROJECT_RESTORED_EVENT` + reload-on-mount,
 * exactly as the B3 snapshot restore does. The restore UI tells the user to
 * reload other tabs.
 *
 * Registration is a plain module-level `Set`, so it never leaks across tests: a
 * hook always unregisters in its effect cleanup.
 */

/** A chapter or scene autosave editor that can be coordinated around a restore. */
export type EditorKind = 'chapter' | 'scene';

/** The functions a mounted editor exposes to the restore coordinator. */
export interface EditorHandle {
  readonly kind: EditorKind;
  /** Project the editor's document belongs to. */
  readonly projectId: string;
  /** Owner (chapter/scene) id, for diagnostics. */
  readonly ownerId: string;
  /** Drain any pending debounced autosave now (awaits in-flight writes). */
  flush: () => Promise<void>;
  /** Re-read the document from the database and rebind the autosave baseline. */
  reload: () => Promise<void>;
}

const registry = new Set<EditorHandle>();

/**
 * Registers a live editor for coordination. Returns an unregister function that
 * MUST be called from the hook's effect cleanup.
 */
export function registerEditor(handle: EditorHandle): () => void {
  registry.add(handle);
  return () => {
    registry.delete(handle);
  };
}

/** Snapshot of the currently-registered editors for a project (tab-local). */
export function editorsForProject(projectId: string): EditorHandle[] {
  return [...registry].filter((h) => h.projectId === projectId);
}

/**
 * Thrown when the mandatory PRE-restore flush cannot guarantee that every open
 * editor's pending autosave has been persisted. A destructive restore MUST NOT
 * proceed past this point: a single editor whose flush failed could still have a
 * debounced/in-flight write that would land AFTER the replacement and resurrect
 * pre-restore text. The caller (the restore UI) treats this as an abort.
 */
export class EditorFlushError extends Error {
  /** Per-editor failures, so the caller can report exactly which editors failed. */
  readonly failures: ReadonlyArray<{ readonly ownerId: string; readonly reason: unknown }>;

  constructor(
    message: string,
    failures: ReadonlyArray<{ readonly ownerId: string; readonly reason: unknown }>,
  ) {
    super(message);
    this.name = 'EditorFlushError';
    this.failures = failures;
  }
}

/**
 * Flushes every registered editor belonging to `projectId`, awaiting ALL of them.
 *
 * This is the MANDATORY pre-restore flush. If **any** editor fails to flush the
 * whole operation REJECTS with an {@link EditorFlushError}: a destructive
 * restore must never proceed when even one open editor's autosave might not be
 * persisted (its debounced write could fire after the replacement). This is
 * deliberately stricter than the best-effort flush-on-cleanup the editor hooks
 * perform — cleanup cannot surface failures, but a restore CAN and MUST.
 *
 * The symmetric POST-restore `reloadProjectEditors` remains best-effort (a
 * failed reload after the data is already written must not abort the others).
 *
 * @returns the number of editors flushed.
 * @throws {EditorFlushError} if any editor flush rejects.
 */
export async function flushProjectEditors(projectId: string): Promise<number> {
  const editors = editorsForProject(projectId);
  if (editors.length === 0) return 0;

  // Await ALL flushes (never short-circuit, so every pending autosave is given a
  // chance to persist), then reject if ANY failed.
  const results = await Promise.allSettled(editors.map((h) => h.flush()));
  const failures: Array<{ ownerId: string; reason: unknown }> = [];
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      failures.push({ ownerId: editors[index].ownerId, reason: result.reason });
    }
  });

  if (failures.length > 0) {
    throw new EditorFlushError(
      failures.length === editors.length
        ? 'None of the open editors could be flushed, so the restore was aborted.'
        : 'One or more open editors could not be flushed, so the restore was aborted to avoid overwriting unsaved text.',
      failures,
    );
  }
  return editors.length;
}

/**
 * Reloads every registered editor belonging to `projectId` (after a successful
 * restore), so each editor shows restored prose and rebinds its autosave baseline.
 *
 * A reload failure for one editor must not abort the others (each reload is
 * independent and the data is already written); failures are logged.
 *
 * @returns the number of editors reloaded.
 */
export async function reloadProjectEditors(projectId: string): Promise<number> {
  const editors = editorsForProject(projectId);
  if (editors.length === 0) return 0;

  const results = await Promise.allSettled(editors.map((h) => h.reload()));
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('[restore-coordinator] An editor failed to reload after the restore.', result.reason);
    }
  }
  return editors.length;
}

/** Test-only: number of currently registered editors (all projects). */
export function registeredEditorCount(): number {
  return registry.size;
}
