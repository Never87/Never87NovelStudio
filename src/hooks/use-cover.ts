/**
 * React binding for the Book Covers service (P9 Batch D).
 *
 * Keeps ALL cover state for ONE project in a single place so the Cover Galley
 * UI never talks to the service or the DB directly:
 *
 *   - loads the project's current cover (asset / external / none / missing);
 *   - uploads a validated image and refreshes;
 *   - removes the current cover;
 *   - reads the project's stored cover variants;
 *   - revokes object URLs on unmount so blobs are not leaked.
 *
 * Everything reads through the shared `coverService` singleton; the hook adds
 * React lifecycle (mount/unmount, race safety, object-URL cleanup) and nothing
 * else. The service owns validation, storage and project-reference updates.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CoverAsset, NovelProject } from '@/types';
import {
  coverService,
  type CoverResolution,
  type UploadCoverOptions,
} from '@/services';

/** Why the cover could not be loaded / mutated (kept typed for the UI). */
export interface UseCoverResult {
  /** The project's current cover resolution (`null` while loading). */
  resolution: CoverResolution | null;
  /** A directly displayable URL for the resolved cover (`null` for none/missing). */
  displayUrl: string | null;
  /** The project row (carries the `cover` reference and title/author). */
  project: NovelProject | null;
  /** All stored cover variants for the project, newest first. */
  variants: CoverAsset[];
  /** True during the first load. */
  initialLoading: boolean;
  /** True during any load or mutation. */
  busy: boolean;
  /** The last error from a load or mutation (never stringified). */
  error: unknown;

  refresh: () => Promise<void>;
  /** Uploads validated bytes and points the project at the new cover. */
  uploadCover: (bytes: Uint8Array, options?: UploadCoverOptions) => Promise<void>;
  /** Removes the project's current cover. */
  removeCover: () => Promise<void>;
  /** Points the project at an external URL / data URI. */
  setExternalCover: (value: string) => Promise<void>;
}

/** Loads and mutates the cover of ONE project. */
export function useCover(projectId: string | null | undefined): UseCoverResult {
  const [resolution, setResolution] = useState<CoverResolution | null>(null);
  const [displayUrl, setDisplayUrl] = useState<string | null>(null);
  const [project, setProject] = useState<NovelProject | null>(null);
  const [variants, setVariants] = useState<CoverAsset[]>([]);
  const [initialLoading, setInitialLoading] = useState<boolean>(Boolean(projectId));
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<unknown>(null);

  const mountedRef = useRef(true);
  const requestIdRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Revoke every object URL this hook/serv was holding before unmount.
      coverService.release();
    };
  }, []);

  const load = useCallback(
    async (token: number) => {
      if (!projectId) {
        if (!mountedRef.current || token !== requestIdRef.current) return;
        setResolution(null);
        setDisplayUrl(null);
        setProject(null);
        setVariants([]);
        setInitialLoading(false);
        return;
      }
      setBusy(true);
      try {
        const [current, list] = await Promise.all([
          coverService.getCurrentCover(projectId),
          coverService.listProjectCovers(projectId),
        ]);
        if (!mountedRef.current || token !== requestIdRef.current) {
          // A stale response must not leak the object URL it created.
          if (current.displayUrl && typeof URL !== 'undefined') URL.revokeObjectURL(current.displayUrl);
          return;
        }
        setResolution(current.resolution);
        setDisplayUrl(current.displayUrl);
        setProject(current.project);
        setVariants(list);
        setError(null);
      } catch (err) {
        if (!mountedRef.current || token !== requestIdRef.current) return;
        // Keep the previous state on a failed refetch; only surface the error.
        setError(err);
      } finally {
        if (mountedRef.current && token === requestIdRef.current) {
          setBusy(false);
          setInitialLoading(false);
        }
      }
    },
    [projectId],
  );

  const refresh = useCallback(async () => {
    requestIdRef.current += 1;
    await load(requestIdRef.current);
  }, [load]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const uploadCover = useCallback(
    async (bytes: Uint8Array, options?: UploadCoverOptions): Promise<void> => {
      if (!projectId) throw new Error('No project selected.');
      setBusy(true);
      try {
        // Release the URLs for the OLD cover before the new one replaces it.
        coverService.release();
        await coverService.uploadCover(projectId, bytes, options);
        await refresh();
      } catch (err) {
        if (mountedRef.current) setError(err);
        throw err;
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [projectId, refresh],
  );

  const removeCover = useCallback(async (): Promise<void> => {
    if (!projectId) throw new Error('No project selected.');
    setBusy(true);
    try {
      coverService.release();
      await coverService.removeCover(projectId);
      await refresh();
    } catch (err) {
      if (mountedRef.current) setError(err);
      throw err;
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [projectId, refresh]);

  const setExternalCover = useCallback(
    async (value: string): Promise<void> => {
      if (!projectId) throw new Error('No project selected.');
      setBusy(true);
      try {
        coverService.release();
        await coverService.setExternalCover(projectId, value);
        await refresh();
      } catch (err) {
        if (mountedRef.current) setError(err);
        throw err;
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [projectId, refresh],
  );

  return useMemo(
    () => ({
      resolution,
      displayUrl,
      project,
      variants,
      initialLoading,
      busy,
      error,
      refresh,
      uploadCover,
      removeCover,
      setExternalCover,
    }),
    [
      resolution,
      displayUrl,
      project,
      variants,
      initialLoading,
      busy,
      error,
      refresh,
      uploadCover,
      removeCover,
      setExternalCover,
    ],
  );
}
