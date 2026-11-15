/**
 * Shared publishing-preset state & persistence (P9 Batch B).
 *
 * ONE source of truth for the preset selection AND the user's custom presets,
 * consumed by BOTH `/publishing/presets` and `/publishing/chapter-export`. There
 * is no second copy of this logic anywhere in the UI.
 *
 * Storage decision
 * ----------------
 * This is a GLOBAL user preference (which preset is active, plus custom format
 * profiles) — NOT novel data. The app already persists global UI preferences in
 * `localStorage` (see `stores/ui-store.ts`, zustand `persist`, prefix `n87-`). A
 * Dexie table would force a schema migration for data that is neither novel
 * content nor relational, so we deliberately reuse the established
 * `localStorage` mechanism under a dedicated, versioned key.
 *
 * Safety
 * ------
 * - Every read is validated with Zod. Malformed / outdated / unreadable stored
 *   data NEVER throws: it is reported and replaced with safe defaults in memory
 *   WITHOUT overwriting the existing bytes silently (only an explicit mutation
 *   writes again).
 * - Built-in presets come from the Batch A registry and are returned by
 *   reference; the store NEVER mutates them. Custom presets are always built by
 *   cloning a built-in (or safe defaults) into a NEW plain object.
 * - The active id always resolves to a usable preset: if the saved id is
 *   missing/invalid, the safe default (`generic`) is used.
 *
 * This module is pure TypeScript (no React) so it is unit-testable directly and
 * reusable from any layer. The React binding lives in
 * `hooks/use-publishing-presets.ts`.
 */

import {
  DEFAULT_PRESET_ID,
  getDefaultPreset,
  getPreset,
  hasPreset,
  listPresets,
  UnknownPresetError,
} from './presets';
import type { CustomPublishingPreset, PublishingPreset } from './types';
import { CustomPresetDraftSchema, PresetStorageEnvelopeSchema, type CustomPresetDraft } from '@/schemas/publishing-preset';

/** The versioned localStorage key. Bumping the version enables a migration. */
export const PRESET_STORAGE_KEY = 'n87-publishing-presets';

/** Current envelope version. */
export const PRESET_STORAGE_VERSION = 1 as const;

/** A preset exposed to the UI: built-in OR custom. Custom presets carry audits. */
export interface CustomPresetEntry extends CustomPublishingPreset {
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Snapshot returned to React consumers; immutable and referentially stable. */
export interface PresetState {
  readonly activeId: string;
  readonly customPresets: readonly CustomPresetEntry[];
  /**
   * Set when stored data was found but could not be used (corrupt / wrong
   * version / schema failure). The UI can surface it; the pages never crash.
   */
  readonly recoveryNotice: string | null;
}

/** Raised when a mutation is requested with a built-in or unknown id. */
export class PresetMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PresetMutationError';
  }
}

/** Raised when a custom-preset draft fails validation. */
export class PresetValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(issues.join('; ') || 'Invalid preset.');
    this.name = 'PresetValidationError';
    this.issues = issues;
  }
}

/** The minimal storage surface (injectable so tests can use a fake). */
export interface PresetStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Resolves the browser localStorage, or `null` when unavailable (SSR/tests). */
function resolveBrowserStorage(): PresetStorage | null {
  try {
    if (typeof globalThis !== 'undefined') {
      const candidate = (globalThis as { localStorage?: PresetStorage }).localStorage;
      if (candidate && typeof candidate.getItem === 'function') return candidate;
    }
  } catch {
    // Access can throw (privacy mode / sandbox); treat as unavailable.
  }
  return null;
}

let idCounter = 0;
/**
 * Deterministic, collision-resistant custom-preset id. Prefixed & unique per
 * store instance; does not rely on `crypto` so it also works in a bare test.
 */
function createCustomPresetId(): string {
  idCounter += 1;
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `custom_${Date.now().toString(36)}_${rand}_${idCounter}`;
}

/** Parses a validated draft (`CustomPresetDraftSchema`) or throws a typed error. */
function parseDraft(draft: unknown): CustomPresetDraft {
  const result = CustomPresetDraftSchema.safeParse(draft);
  if (!result.success) {
    const issues = result.error.issues.map((i) => {
      const path = i.path.join('.');
      return path ? `${path}: ${i.message}` : i.message;
    });
    throw new PresetValidationError(issues);
  }
  return result.data;
}

/** The safe default seed for a brand-new custom preset. */
export function defaultDraft(): CustomPresetDraft {
  const base = getDefaultPreset();
  return {
    label: 'My preset',
    metadata: base.metadata,
    includeVolumeHeadings: base.includeVolumeHeadings,
    volumeHeadingTemplate: base.volumeHeadingTemplate,
    chapterHeadingStyle: base.chapterHeadingStyle,
    chapterHeadingTemplate: base.chapterHeadingTemplate,
    paragraphStyle: base.paragraphStyle,
    paragraphIndent: base.paragraphIndent,
    paragraphSpacing: base.paragraphSpacing,
    sceneBreak: base.sceneBreak,
    fileNameTemplate: base.fileNameTemplate,
    fileExtension: base.fileExtension,
  };
}

/** Builds a draft seeded from an existing preset (a clone — never a reference). */
export function draftFromPreset(preset: PublishingPreset): CustomPresetDraft {
  return {
    label: `${preset.label} (custom)`.slice(0, 80),
    metadata: preset.metadata,
    includeVolumeHeadings: preset.includeVolumeHeadings,
    volumeHeadingTemplate: preset.volumeHeadingTemplate,
    chapterHeadingStyle: preset.chapterHeadingStyle,
    chapterHeadingTemplate: preset.chapterHeadingTemplate,
    paragraphStyle: preset.paragraphStyle,
    paragraphIndent: preset.paragraphIndent,
    paragraphSpacing: preset.paragraphSpacing,
    sceneBreak: preset.sceneBreak,
    fileNameTemplate: preset.fileNameTemplate,
    fileExtension: preset.fileExtension,
  };
}

/** Converts a stored custom entry into the `CustomPublishingPreset` the pipeline consumes. */
function entryToPreset(entry: CustomPresetEntry): CustomPublishingPreset {
  return {
    id: entry.id,
    label: entry.label,
    builtin: false,
    metadata: entry.metadata,
    includeVolumeHeadings: entry.includeVolumeHeadings,
    volumeHeadingTemplate: entry.volumeHeadingTemplate,
    chapterHeadingStyle: entry.chapterHeadingStyle,
    chapterHeadingTemplate: entry.chapterHeadingTemplate,
    paragraphStyle: entry.paragraphStyle,
    paragraphIndent: entry.paragraphIndent,
    paragraphSpacing: entry.paragraphSpacing,
    sceneBreak: entry.sceneBreak,
    fileNameTemplate: entry.fileNameTemplate,
    fileExtension: entry.fileExtension,
  };
}

/**
 * Projects a stored entry down to just the DRAFT fields, so it can be fed back
 * through the strict draft schema (e.g. when renaming) without the store-owned
 * `id`/`builtin`/timestamps tripping the `.strict()` unknown-key check.
 */
function entryToDraftLoose(entry: CustomPresetEntry): CustomPresetDraft {
  return {
    label: entry.label,
    metadata: entry.metadata,
    includeVolumeHeadings: entry.includeVolumeHeadings,
    volumeHeadingTemplate: entry.volumeHeadingTemplate,
    chapterHeadingStyle: entry.chapterHeadingStyle,
    chapterHeadingTemplate: entry.chapterHeadingTemplate,
    paragraphStyle: entry.paragraphStyle,
    paragraphIndent: entry.paragraphIndent,
    paragraphSpacing: entry.paragraphSpacing,
    sceneBreak: entry.sceneBreak,
    fileNameTemplate: entry.fileNameTemplate,
    fileExtension: entry.fileExtension,
  };
}

/**
 * The shared preset store.
 *
 * Construct once in the app (`publishingPresetStore` singleton) and share it
 * everywhere. All reads return fresh immutable snapshots; subscribers are
 * notified on every mutation / external `storage` change.
 */
export class PublishingPresetStore {
  private readonly storage: PresetStorage | null;
  private readonly storageKey: string;
  private state: PresetState;
  private readonly listeners = new Set<() => void>();
  private loadedFromStorage = false;

  constructor(options: { storage?: PresetStorage | null; storageKey?: string } = {}) {
    this.storage = options.storage === undefined ? resolveBrowserStorage() : options.storage;
    this.storageKey = options.storageKey ?? PRESET_STORAGE_KEY;
    // Load synchronously so the very first render already has real state.
    this.state = this.load();
    this.loadedFromStorage = true;
  }

  /* ------------------------------ reading ------------------------------- */

  /** The current immutable snapshot (referentially stable until a mutation). */
  getState(): PresetState {
    return this.state;
  }

  /** Subscribe to changes; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** All built-in presets (shared registry instances — read-only). */
  listBuiltins(): readonly PublishingPreset[] {
    return listPresets();
  }

  /** All custom presets the user has created, in creation order. */
  listCustom(): readonly CustomPresetEntry[] {
    return this.state.customPresets;
  }

  /**
   * Every selectable preset: built-ins first (registry order), then customs.
   * The returned objects are safe to read; never mutate them.
   */
  listAll(): readonly PublishingPreset[] {
    return [...listPresets(), ...this.state.customPresets.map(entryToPreset)];
  }

  /** Looks up any preset (built-in or custom). Returns `null` when unknown. */
  find(id: string): PublishingPreset | null {
    const custom = this.state.customPresets.find((c) => c.id === id);
    if (custom) return entryToPreset(custom);
    if (hasPreset(id)) return getPreset(id);
    return null;
  }

  /** Whether `id` is a built-in preset. */
  isBuiltin(id: string): boolean {
    return hasPreset(id);
  }

  /**
   * The active preset. ALWAYS resolves to a usable preset: if the stored active
   * id is missing/invalid, the safe default is returned (never throws).
   */
  getActive(): PublishingPreset {
    const preset = this.find(this.state.activeId);
    if (preset) return preset;
    // Defensive fallback — the load() step already normalises, but be explicit.
    return getDefaultPreset();
  }

  /* ------------------------------ selection ----------------------------- */

  /**
   * Sets the active preset. Unknown ids are rejected (never a silent fallback
   * that hides a caller bug) — the UI only ever passes ids it listed.
   */
  setActive(id: string): void {
    if (!this.find(id)) {
      throw new PresetMutationError(`Cannot select unknown preset "${id}".`);
    }
    if (id === this.state.activeId) return;
    this.commit({ ...this.state, activeId: id });
  }

  /** Resets the active preset to the safe default (`generic`). */
  resetActiveToDefault(): void {
    this.setActive(DEFAULT_PRESET_ID);
  }

  /* ------------------------------ mutation ------------------------------ */

  /**
   * Creates a new custom preset from a validated draft and makes it active.
   * Returns the created entry.
   */
  createCustom(draft: unknown): CustomPresetEntry {
    const parsed = parseDraft(draft);
    const ts = Date.now();
    const entry: CustomPresetEntry = {
      ...parsed,
      id: createCustomPresetId(),
      builtin: false,
      createdAt: ts,
      updatedAt: ts,
    };
    const next: PresetState = {
      ...this.state,
      customPresets: [...this.state.customPresets, entry],
      activeId: entry.id,
    };
    this.commit(next);
    return entry;
  }

  /** Updates an existing custom preset from a validated draft. */
  updateCustom(id: string, draft: unknown): CustomPresetEntry {
    const existing = this.requireCustom(id);
    const parsed = parseDraft(draft);
    const updated: CustomPresetEntry = { ...existing, ...parsed, updatedAt: Date.now() };
    const customPresets = this.state.customPresets.map((entry) =>
      entry.id === id ? updated : entry,
    );
    this.commit({ ...this.state, customPresets });
    return updated;
  }

  /** Renames a custom preset (validated via the same label rule). */
  renameCustom(id: string, label: string): CustomPresetEntry {
    const existing = this.requireCustom(id);
    return this.updateCustom(id, { ...entryToDraftLoose(existing), label });
  }

  /** Duplicates a custom preset; the copy becomes active. Returns the copy. */
  duplicateCustom(id: string): CustomPresetEntry {
    const source = this.requireCustom(id);
    const ts = Date.now();
    const copy: CustomPresetEntry = {
      ...source,
      id: createCustomPresetId(),
      label: `${source.label} (copy)`.slice(0, 80),
      createdAt: ts,
      updatedAt: ts,
    };
    this.commit({
      ...this.state,
      customPresets: [...this.state.customPresets, copy],
      activeId: copy.id,
    });
    return copy;
  }

  /**
   * Deletes a custom preset. If it was active, the selection falls back to the
   * safe default. Built-in ids are rejected.
   */
  deleteCustom(id: string): void {
    this.requireCustom(id);
    const customPresets = this.state.customPresets.filter((c) => c.id !== id);
    const activeId = this.state.activeId === id ? DEFAULT_PRESET_ID : this.state.activeId;
    this.commit({ ...this.state, customPresets, activeId });
  }

  /**
   * Creates a custom preset directly from a built-in (clone) or from safe
   * defaults, without an intermediate draft. The new preset becomes active.
   */
  createFromBuiltin(builtinId: string): CustomPresetEntry {
    const source = hasPreset(builtinId) ? getPreset(builtinId) : getDefaultPreset();
    return this.createCustom(draftFromPreset(source));
  }

  /* ------------------------------ internals ----------------------------- */

  private requireCustom(id: string): CustomPresetEntry {
    if (hasPreset(id)) {
      throw new PresetMutationError(`Built-in preset "${id}" cannot be modified or deleted.`);
    }
    const entry = this.state.customPresets.find((c) => c.id === id);
    if (!entry) {
      throw new PresetMutationError(`Custom preset "${id}" was not found.`);
    }
    return entry;
  }

  /** Commits new state, persists it and notifies subscribers. */
  private commit(next: PresetState): void {
    this.state = next;
    this.persist(next);
    for (const listener of this.listeners) listener();
  }

  /** Writes the envelope to storage. Persistence failures never crash the UI. */
  private persist(state: PresetState): void {
    if (!this.storage) return;
    try {
      const envelope = {
        version: PRESET_STORAGE_VERSION,
        activePresetId: state.activeId,
        customPresets: state.customPresets.map(toStored),
      };
      this.storage.setItem(this.storageKey, JSON.stringify(envelope));
    } catch {
      // Quota / privacy mode: keep the in-memory state, do not throw.
    }
  }

  /**
   * Reads + validates stored state. Never throws; on any problem returns a safe
   * default state PLUS a human-readable `recoveryNotice`. Crucially, corrupt
   * bytes are NOT overwritten here (no `persist` during load) — valid data is
   * never silently clobbered by a bad read.
   */
  private load(): PresetState {
    const empty: PresetState = {
      activeId: DEFAULT_PRESET_ID,
      customPresets: [],
      recoveryNotice: null,
    };
    if (!this.storage) return empty;

    let raw: string | null;
    try {
      raw = this.storage.getItem(this.storageKey);
    } catch {
      return { ...empty, recoveryNotice: 'Saved presets could not be read; using defaults.' };
    }
    if (raw === null) return empty; // Nothing stored yet — a clean first run.

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return {
        ...empty,
        recoveryNotice:
          'Saved presets were not valid JSON, so defaults are in use. Saving a change will replace the stored data.',
      };
    }

    // Outdated / wrong-version envelopes are rejected explicitly.
    const version = (parsedJson as { version?: unknown })?.version;
    if (version !== PRESET_STORAGE_VERSION) {
      return {
        ...empty,
        recoveryNotice:
          'Saved presets use an unsupported version, so defaults are in use. Saving a change will replace the stored data.',
      };
    }

    const validation = PresetStorageEnvelopeSchema.safeParse(parsedJson);
    if (!validation.success) {
      return {
        ...empty,
        recoveryNotice:
          'Saved presets were malformed and have been ignored; defaults are in use. Saving a change will replace the stored data.',
      };
    }

    // Validate each custom entry again and drop any that are individually bad,
    // rather than losing the whole set because of one corrupted record.
    const validCustoms: CustomPresetEntry[] = [];
    for (const stored of validation.data.customPresets) {
      const entry = fromStored(stored);
      if (entry) validCustoms.push(entry);
    }

    // Resolve the active id; fall back to default if it no longer exists.
    const allIds = new Set<string>([
      ...listPresets().map((p) => p.id),
      ...validCustoms.map((c) => c.id),
    ]);
    let activeId = validation.data.activePresetId;
    let notice: string | null = null;
    if (validCustoms.length !== validation.data.customPresets.length) {
      notice = 'One or more saved custom presets were invalid and were skipped.';
    }
    if (!allIds.has(activeId)) {
      activeId = DEFAULT_PRESET_ID;
      notice =
        (notice ? `${notice} ` : '') +
        'The previously selected preset no longer exists, so the default was selected.';
    }

    return { activeId, customPresets: validCustoms, recoveryNotice: notice };
  }

  /** Re-reads from storage (e.g. after a cross-tab `storage` event). */
  reloadFromStorage(): void {
    if (!this.loadedFromStorage) return;
    this.state = this.load();
    for (const listener of this.listeners) listener();
  }
}

/** Maps a custom entry to the persisted shape (drops the derived `builtin`). */
function toStored(entry: CustomPresetEntry) {
  return {
    id: entry.id,
    label: entry.label,
    metadata: entry.metadata,
    includeVolumeHeadings: entry.includeVolumeHeadings,
    volumeHeadingTemplate: entry.volumeHeadingTemplate,
    chapterHeadingStyle: entry.chapterHeadingStyle,
    chapterHeadingTemplate: entry.chapterHeadingTemplate,
    paragraphStyle: entry.paragraphStyle,
    paragraphIndent: entry.paragraphIndent,
    paragraphSpacing: entry.paragraphSpacing,
    sceneBreak: entry.sceneBreak,
    fileNameTemplate: entry.fileNameTemplate,
    fileExtension: entry.fileExtension,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

/** Rebuilds a validated custom entry from its stored shape, or `null` if bad. */
function fromStored(stored: unknown): CustomPresetEntry | null {
  const record = stored as Record<string, unknown>;
  // Validate the DRAFT fields only — the envelope also carries store-owned
  // `id`/`createdAt`/`updatedAt`, which the strict draft schema would reject.
  const draftResult = CustomPresetDraftSchema.safeParse({
    label: record?.label,
    metadata: record?.metadata,
    includeVolumeHeadings: record?.includeVolumeHeadings,
    volumeHeadingTemplate: record?.volumeHeadingTemplate,
    chapterHeadingStyle: record?.chapterHeadingStyle,
    chapterHeadingTemplate: record?.chapterHeadingTemplate,
    paragraphStyle: record?.paragraphStyle,
    paragraphIndent: record?.paragraphIndent,
    paragraphSpacing: record?.paragraphSpacing,
    sceneBreak: record?.sceneBreak,
    fileNameTemplate: record?.fileNameTemplate,
    fileExtension: record?.fileExtension,
  });
  if (!draftResult.success) return null;
  const id = record?.id;
  const createdAt = record?.createdAt;
  const updatedAt = record?.updatedAt;
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null;
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return null;
  return {
    ...draftResult.data,
    id,
    builtin: false,
    createdAt,
    updatedAt,
  };
}

/** Thrown by `find`-style helpers when a preset id is genuinely unknown. */
export function assertKnownPreset(store: PublishingPresetStore, id: string): PublishingPreset {
  const preset = store.find(id);
  if (!preset) throw new UnknownPresetError(id);
  return preset;
}

/** The shared application singleton. Cross-tab sync is wired in the app layer. */
export const publishingPresetStore = new PublishingPresetStore();
