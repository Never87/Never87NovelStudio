import type { SaveDraftInput, SaveDraftResult } from '@/services/manuscript-service';

/**
 * Autosave engine for the writing editor (P4).
 *
 * Extracted from React on purpose: the *hard* part of autosave is a state
 * machine (dirty tracking, debounce, serialisation, staleness), and a plain
 * class can be exercised deterministically without a DOM.
 *
 * Guarantees:
 *
 * 1. **Debounce** — edits are coalesced; only the last value after `debounceMs`
 *    of quiet is sent.
 * 2. **Serialised writes** — at most one request is in flight. A request that
 *    arrives while another is running sets `pending` instead of racing it.
 * 3. **No lost updates** — `pending` always holds the NEWEST text, so a queued
 *    intermediate value is superseded rather than queued up and replayed later
 *    over fresher content.
 * 4. **Optimistic concurrency** — every request carries the revision it is
 *    based on. When the store rejects a stale write (`DraftConflictError`), the
 *    engine reloads the current revision and, if the user still has unsaved
 *    text, retries against the fresh revision instead of overwriting blind.
 * 5. **Target switching** — `switchTo()` flushes the outgoing document first,
 *    then binds the new owner and resets every piece of state, so a save for
 *    chapter A can never land on chapter B.
 * 6. **Failure recovery** — a failed save keeps the text dirty and exposes the
 *    error; `retry()` re-sends. Nothing is dropped on failure.
 */

/** Coarse save status rendered by the editor. */
export type AutosaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'blocked';

export interface AutosaveSnapshot {
  status: AutosaveStatus;
  /** Epoch ms of the last successful save, or `null`. */
  lastSavedAt: number | null;
  /** Error from the most recent failed attempt. */
  error: unknown;
  /** Number of saves that lost a race and were reconciled. */
  conflicts: number;
  /** Revision currently known to be persisted. */
  revision: number;
  /** True when the editor text differs from the persisted text. */
  dirty: boolean;
}

/** Persists one draft. Injected so tests can supply a fake store. */
export interface AutosaveStore {
  /**
   * Writes one document.
   *
   * Receives the FULL target (owner + project) rather than just the owner id,
   * so the store can never write into the wrong project even if the editor
   * moves between projects.
   */
  save(
    target: AutosaveTarget,
    input: SaveDraftInput,
    options: { snapshotOnSave: boolean },
  ): Promise<SaveDraftResult>;
}

export interface AutosaveOptions {
  /** Quiet period before a save fires. Default 800 ms. */
  debounceMs?: number;
  /** Hard cap on how long continuous typing may postpone a save. Default 5 s. */
  maxWaitMs?: number;
  /** Capture an automatic version snapshot on each save. Default false. */
  snapshotOnSave?: boolean;
  /** Called after every state transition (the editor mirrors it into React). */
  onChange?: (snapshot: AutosaveSnapshot) => void;
  /** Injected clock, for deterministic debounce tests. */
  now?: () => number;
  /** Injected timer factory, for deterministic debounce tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Max conflict reconciliations per save before surfacing an error. */
  maxConflictRetries?: number;
}

/** A save target: exactly one chapter or scene manuscript. */
export interface AutosaveTarget {
  /** Owning project — carried through so writes stay project-scoped. */
  projectId: string;
  ownerId: string;
  /** Revision at load time. */
  revision: number;
  /** Persisted content, used to decide whether a save is needed. */
  content: string;
}

/**
 * Plain, framework-free autosave machine.
 *
 * Lifecycle: `bind()` → `update()` (any number of times) → `flush()` /
 * `switchTo()` / `dispose()`.
 */
export class AutosaveEngine {
  private readonly store: AutosaveStore;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly snapshotOnSave: boolean;
  private readonly onChange?: (snapshot: AutosaveSnapshot) => void;
  private readonly clock: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly maxConflictRetries: number;

  private target: AutosaveTarget | null = null;
  /** Newest unsaved text, or `null` when there is nothing to write. */
  private pending: string | null = null;
  private inFlight: Promise<void> | null = null;
  /** Guards against a disposed engine writing after unmount. */
  private disposed = false;
  /** Increments on every target switch so late responses are discarded. */
  private generation = 0;
  private timer: unknown = null;
  /** When the current dirty streak started (for `maxWaitMs`). */
  private dirtySince: number | null = null;

  private status: AutosaveStatus = 'idle';
  private lastSavedAt: number | null = null;
  private error: unknown = null;
  private conflictCount = 0;

  constructor(store: AutosaveStore, options: AutosaveOptions = {}) {
    this.store = store;
    this.debounceMs = options.debounceMs ?? 800;
    this.maxWaitMs = options.maxWaitMs ?? 5_000;
    this.snapshotOnSave = options.snapshotOnSave ?? false;
    this.onChange = options.onChange;
    this.clock = options.now ?? (() => Date.now());
    this.setTimer =
      options.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown as ReturnType<typeof setTimeout>);
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as never));
    this.maxConflictRetries = options.maxConflictRetries ?? 2;
  }

  /** Binds a freshly loaded document. Discards any previous target state. */
  bind(target: AutosaveTarget): void {
    this.cancelTimer();
    this.generation += 1;
    this.target = { ...target };
    this.pending = null;
    this.status = 'idle';
    this.error = null;
    this.dirtySince = null;
    this.emit();
  }

  /**
   * Records an edit.
   *
   * Reverting the text back to the persisted value clears `dirty` instead of
   * scheduling a pointless write.
   */
  update(content: string): void {
    if (!this.target) return;
    if (content === this.target.content) {
      this.pending = null;
      this.cancelTimer();
      this.dirtySince = null;
      if (this.status === 'dirty') this.status = 'idle';
      this.emit();
      return;
    }

    this.pending = content;
    if (this.dirtySince === null) this.dirtySince = this.clock();
    if (this.status !== 'saving') this.status = 'dirty';
    this.error = null;
    this.emit();
    this.schedule();
  }

  /**
   * Schedules the next write.
   *
   * Uses a trailing debounce, but never postpones past `maxWaitMs` from the
   * moment the document first became dirty — so a continuous typist still gets
   * periodic saves instead of one save at the end of the session.
   */
  private schedule(): void {
    this.cancelTimer();
    if (this.pending === null) return;

    const elapsed = this.dirtySince === null ? 0 : this.clock() - this.dirtySince;
    const remainingMax = Math.max(0, this.maxWaitMs - elapsed);
    const delay = Math.min(this.debounceMs, remainingMax);

    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  /**
   * Writes immediately, bypassing the debounce (e.g. Ctrl+S, blur, unmount).
   *
   * Safe to call concurrently: if a request is already running, this returns
   * that in-flight promise, and any newer pending text is picked up by the
   * running loop before it resolves.
   */
  async flush(): Promise<void> {
    this.cancelTimer();
    if (!this.target) return;

    // Wait for the running write, then decide whether more work remains.
    if (this.inFlight) {
      await this.inFlight;
      if (this.pending === null || !this.target) return;
    }

    const run = this.drain();
    this.inFlight = run;
    try {
      await run;
    } finally {
      if (this.inFlight === run) this.inFlight = null;
    }
  }

  /**
   * Serialised write loop.
   *
   * Each iteration sends the CURRENT `pending` value and then clears it only if
   * no newer edit arrived while the request was running. This is what makes two
   * fast saves safe: the second cannot send stale text, and the first cannot
   * clear text it never wrote.
   */
  private async drain(): Promise<void> {
    while (this.pending !== null && this.target && !this.disposed) {
      const generation = this.generation;
      const target = this.target;
      const content = this.pending;

      this.status = 'saving';
      this.emit();

      try {
        const result = await this.saveWithConflictRecovery(target, content);

        // A switch/dispose happened while the request was running.
        if (generation !== this.generation || this.disposed) return;

        target.content = content;
        target.revision = result.draft.revision;
        this.lastSavedAt = this.clock();
        this.error = null;

        // Only clear `pending` if it still holds what we just wrote.
        if (this.pending === content) {
          this.pending = null;
          this.dirtySince = null;
          this.status = 'saved';
        } else {
          // A newer edit arrived mid-flight; loop again for it.
          this.status = 'dirty';
        }
        this.emit();
      } catch (error) {
        if (generation !== this.generation || this.disposed) return;
        // Keep the text dirty so nothing is lost and Retry can resend it.
        this.error = error;
        this.status = 'error';
        this.emit();
        return;
      }
    }
  }

  /**
   * Sends one save, reconciling optimistic-concurrency conflicts.
   *
   * On `DraftConflictError` the local revision is stale (another tab save, or a
   * restore). We adopt the server revision and retry — preserving the user's
   * text — a bounded number of times.
   */
  private async saveWithConflictRecovery(
    target: AutosaveTarget,
    content: string,
  ): Promise<SaveDraftResult> {
    let attempts = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const expectedRevision = this.target?.revision ?? 0;
      try {
        return await this.store.save(
          target,
          { content, expectedRevision },
          { snapshotOnSave: this.snapshotOnSave },
        );
      } catch (error) {
        if (!isConflictError(error) || attempts >= this.maxConflictRetries) throw error;
        attempts += 1;
        this.conflictCount += 1;
        const current = conflictRevision(error);
        if (this.target) this.target.revision = current;
        this.emit();
      }
    }
  }

  /** Re-sends failed text immediately. */
  async retry(): Promise<void> {
    this.status = 'dirty';
    this.emit();
    await this.flush();
  }

  /**
   * Switches the bound document.
   *
   * Flushes the outgoing document first (so its text is never dropped), then
   * binds the new one. The generation bump makes any still-running request for
   * the old document unable to touch the new one's state.
   */
  async switchTo(target: AutosaveTarget): Promise<void> {
    await this.flush();
    this.cancelTimer();
    const hadPending = this.pending !== null;
    if (hadPending) {
      // The flush failed (status 'error'); surface it rather than silently
      // switching away from unsaved text.
      this.emit();
      return;
    }
    this.bind(target);
  }

  /** Current state, for rendering. */
  snapshot(): AutosaveSnapshot {
    return {
      status: this.status,
      lastSavedAt: this.lastSavedAt,
      error: this.error,
      conflicts: this.conflictCount,
      revision: this.target?.revision ?? 0,
      dirty: this.pending !== null,
    };
  }

  /** True when there is text that has not reached the database. */
  get hasUnsavedChanges(): boolean {
    return this.pending !== null;
  }

  /** Cancels timers and marks the engine dead. Call on unmount. */
  dispose(): void {
    this.cancelTimer();
    this.disposed = true;
    this.generation += 1;
    this.target = null;
    this.pending = null;
  }

  private emit(): void {
    this.onChange?.(this.snapshot());
  }
}

/** Structural check for the Service's `DraftConflictError`, without importing it. */
function isConflictError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'DraftConflictError'
  );
}

/** Reads the freshest revision out of a conflict error (0 when unavailable). */
function conflictRevision(error: unknown): number {
  const value = (error as { currentRevision?: unknown }).currentRevision;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
