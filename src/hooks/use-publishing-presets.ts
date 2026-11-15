/**
 * React binding for the shared publishing-preset store (P9 Batch B).
 *
 * This is the ONLY React touch-point for preset state. Both pages consume this
 * same hook, so a preset change on one page is immediately reflected on the
 * other (they read the same store singleton via `useSyncExternalStore`).
 *
 * Cross-tab sync: the store itself is framework-agnostic; this hook bridges the
 * browser `storage` event to `store.reloadFromStorage()` so two tabs stay
 * consistent. That browser-specific concern belongs in the app layer, not the
 * pure store.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  publishingPresetStore,
  type CustomPresetEntry,
  type PublishingPresetStore,
  type PresetState,
} from '@/modules/publishing/preset-store';
import type { PublishingPreset } from '@/modules/publishing';

/** The API surface returned to components. */
export interface UsePublishingPresetsResult {
  /** The active (selected) preset — always resolvable. */
  active: PublishingPreset;
  /** The active preset id. */
  activeId: string;
  /** All selectable presets (built-ins then customs). Read-only. */
  presets: readonly PublishingPreset[];
  /** Built-in presets only. */
  builtins: readonly PublishingPreset[];
  /** Custom presets only. */
  customPresets: readonly CustomPresetEntry[];
  /** A recovery notice when stored data was ignored; `null` when clean. */
  recoveryNotice: string | null;
  /** Whether an id refers to a built-in preset (not editable/deletable). */
  isBuiltin: (id: string) => boolean;

  selectPreset: (id: string) => void;
  resetToDefault: () => void;
  createCustom: (draft: unknown) => CustomPresetEntry;
  updateCustom: (id: string, draft: unknown) => CustomPresetEntry;
  renameCustom: (id: string, label: string) => CustomPresetEntry;
  duplicateCustom: (id: string) => CustomPresetEntry;
  deleteCustom: (id: string) => void;
  createFromBuiltin: (builtinId: string) => CustomPresetEntry;
}

/**
 * Subscribes to the shared store. When `store` is omitted the app singleton is
 * used; an alternative store can be injected in tests.
 */
export function usePublishingPresets(
  store: PublishingPresetStore = publishingPresetStore,
): UsePublishingPresetsResult {
  const state: PresetState = useSyncExternalStore(
    useCallback((onChange) => store.subscribe(onChange), [store]),
    useCallback(() => store.getState(), [store]),
    useCallback(() => store.getState(), [store]),
  );

  // Keep two tabs in sync: a `storage` write in another tab reloads this store.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      // `key === null` means "clear()" was called elsewhere — reload too.
      if (event.key === null || event.key === undefined || event.key.startsWith('n87-publishing-presets')) {
        store.reloadFromStorage();
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [store]);

  const selectPreset = useCallback((id: string) => store.setActive(id), [store]);
  const resetToDefault = useCallback(() => store.resetActiveToDefault(), [store]);
  const createCustom = useCallback((draft: unknown) => store.createCustom(draft), [store]);
  const updateCustom = useCallback((id: string, draft: unknown) => store.updateCustom(id, draft), [store]);
  const renameCustom = useCallback((id: string, label: string) => store.renameCustom(id, label), [store]);
  const duplicateCustom = useCallback((id: string) => store.duplicateCustom(id), [store]);
  const deleteCustom = useCallback((id: string) => store.deleteCustom(id), [store]);
  const createFromBuiltin = useCallback((builtinId: string) => store.createFromBuiltin(builtinId), [store]);

  // Derived lists are recomputed from the live snapshot each render.
  const active = store.getActive();
  const builtins = store.listBuiltins();
  const presets = store.listAll();

  return {
    active,
    activeId: state.activeId,
    presets,
    builtins,
    customPresets: state.customPresets,
    recoveryNotice: state.recoveryNotice,
    isBuiltin: (id: string) => store.isBuiltin(id),
    selectPreset,
    resetToDefault,
    createCustom,
    updateCustom,
    renameCustom,
    duplicateCustom,
    deleteCustom,
    createFromBuiltin,
  };
}
