import { useCallback, useEffect, useRef, useState } from 'react';
import type { DocumentSection, DocumentSectionLevel, SourceDocument } from '@/types';
import type {
  CreateDocumentInput,
  ParseDocumentResult,
  UpdateSectionInput,
} from '@/services';
import { importService } from '@/services';

export type ImportDocumentsStatus = 'idle' | 'loading' | 'success' | 'error';

export interface UseImportDocumentsResult {
  documents: SourceDocument[];
  status: ImportDocumentsStatus;
  loading: boolean;
  /** True while a mutating operation (create/parse/delete/edit) is in flight. */
  mutating: boolean;
  error: unknown;
  /** Reloads the project's document list. */
  refresh: () => Promise<void>;
  /** Registers a new document (status `imported`, not yet parsed). */
  createDocument: (input: CreateDocumentInput) => Promise<SourceDocument>;
  /** Parses a document into sections (idempotent). */
  parseDocument: (documentId: string) => Promise<ParseDocumentResult>;
  /** Re-parses a document whose raw text changed (guarded). */
  reparseDocument: (documentId: string, options?: { force?: boolean }) => Promise<ParseDocumentResult>;
  /** Deletes a document and its sections + extraction records. */
  deleteDocument: (documentId: string) => Promise<void>;
  /** Loads a document's sections (does not touch the documents list). */
  getSections: (documentId: string) => Promise<DocumentSection[]>;
  /** Edits a section's structure (title / level / parent), invalidating confirmation. */
  updateSection: (sectionId: string, input: UpdateSectionInput) => Promise<DocumentSection>;
  /** Reassigns sibling order for a document (all ids, in the new order). */
  reorderSections: (documentId: string, orderedIds: string[]) => Promise<DocumentSection[]>;
  /** Confirms the current structure as the official extraction input. */
  confirmStructure: (documentId: string) => Promise<SourceDocument>;
}

/**
 * Loads and mutates a project's imported documents (P8 Batch 2).
 *
 * Mirrors the P2–P7 hook conventions: it never touches Dexie, never re-derives
 * business rules, and always delegates to the singleton `importService`.
 * A monotonic request-id guard ensures a slow load can never overwrite a newer
 * one (e.g. after switching projects), and `mountedRef` prevents state writes
 * after unmount.
 *
 * Section reads are exposed as an imperative `getSections()` (they are per-
 * document and change independently of the documents list), so this hook keeps
 * just the documents list in reactive state and returns freshly-loaded sections
 * to the caller. Mutations that change a document's status/confirmation reload
 * the list so it stays authoritative in the database.
 */
export function useImportDocuments(
  projectId: string | null | undefined,
): UseImportDocumentsResult {
  const [documents, setDocuments] = useState<SourceDocument[]>([]);
  const [status, setStatus] = useState<ImportDocumentsStatus>('idle');
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async (token: number, id: string | null | undefined) => {
    if (!id) {
      if (mountedRef.current && token === requestIdRef.current) {
        setDocuments([]);
        setStatus('idle');
      }
      return;
    }
    setStatus('loading');
    try {
      const next = await importService.listDocuments(id);
      if (!mountedRef.current || token !== requestIdRef.current) return;
      setDocuments(next);
      setStatus('success');
      setError(null);
    } catch (err) {
      if (!mountedRef.current || token !== requestIdRef.current) return;
      setDocuments([]);
      setStatus('error');
      setError(err);
    }
  }, []);

  const refresh = useCallback(async () => {
    requestIdRef.current += 1;
    await load(requestIdRef.current, projectId);
  }, [load, projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const requireId = (action: string): string => {
    if (!projectId) throw new Error(`Cannot ${action} without a project id.`);
    return projectId;
  };

  /** Runs a mutation with `mutating` state, reloads the list, surfaces errors. */
  const mutate = useCallback(
    async <T>(operation: () => Promise<T>, reload = true): Promise<T> => {
      setMutating(true);
      try {
        const result = await operation();
        if (reload) await refresh();
        return result;
      } catch (err) {
        if (mountedRef.current) setError(err);
        throw err;
      } finally {
        if (mountedRef.current) setMutating(false);
      }
    },
    [refresh],
  );

  return {
    documents,
    status,
    loading: status === 'loading',
    mutating,
    error,
    refresh,
    createDocument: useCallback(
      (input: CreateDocumentInput) => mutate(() => importService.createDocument(requireId('register a document'), input)),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [mutate, projectId],
    ),
    parseDocument: useCallback(
      (documentId: string) => mutate(() => importService.parseDocument(requireId('parse a document'), documentId)),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [mutate, projectId],
    ),
    reparseDocument: useCallback(
      (documentId: string, options?: { force?: boolean }) =>
        mutate(() => importService.reparseDocument(requireId('re-parse a document'), documentId, options)),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [mutate, projectId],
    ),
    deleteDocument: useCallback(
      (documentId: string) => mutate(() => importService.deleteDocument(requireId('delete a document'), documentId)).then(() => undefined),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [mutate, projectId],
    ),
    getSections: useCallback(
      (documentId: string) => importService.getSections(requireId('load sections'), documentId),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [projectId],
    ),
    updateSection: useCallback(
      (sectionId: string, input: UpdateSectionInput) =>
        mutate(() => importService.updateSection(requireId('update a section'), sectionId, input)),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [mutate, projectId],
    ),
    reorderSections: useCallback(
      (documentId: string, orderedIds: string[]) =>
        mutate(() => importService.reorderSections(requireId('reorder sections'), documentId, orderedIds)),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [mutate, projectId],
    ),
    confirmStructure: useCallback(
      (documentId: string) => mutate(() => importService.confirmStructure(requireId('confirm structure'), documentId)),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [mutate, projectId],
    ),
  };
}

/** Helper re-export used by panels' level filters. */
export type { DocumentSectionLevel, DocumentSection, SourceDocument };
