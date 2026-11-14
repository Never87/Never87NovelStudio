import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { SourceDocument } from '@/types';
import { useImportDocuments, useProjects } from '@/hooks';
import type { UseImportDocumentsResult } from '@/hooks';

/**
 * Shared state for the "Import & Analysis" workflow pages.
 *
 * The P8 pipeline spans several routes
 * (`/import/manuscript` → `/import/document-parser` →
 * `/import/structure-recognition` → `/import/information-extraction`), and a
 * user expects to pick a project + document ONCE and then walk through the
 * stages without re-selecting them.
 *
 * This provider is mounted by the workflow shell, which wraps every import
 * page in the router. It owns:
 *
 *   - the selected project (defaulting to the first project),
 *   - the selected DOCUMENT, persisted in `sessionStorage` so it survives the
 *     route change between stages (a fresh reload still restores it as long as
 *     the tab stays open),
 *   - the project's document list, via the shared `useImportDocuments` hook so
 *     every page sees the SAME authoritative list (mutations there reload it).
 *
 * It deliberately holds NO business state (sections, extraction counts). Those
 * are per-document and are loaded by the page that needs them, straight from
 * the services — so a stage can never show a stale copy of pipeline data.
 */

const STORAGE_KEY = 'n87.import.workflow.v1';

interface PersistedSelection {
  projectId: string;
  documentId: string | null;
}

function readPersisted(): PersistedSelection | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedSelection>;
    if (typeof parsed?.projectId !== 'string' || !parsed.projectId) return null;
    return {
      projectId: parsed.projectId,
      documentId: typeof parsed.documentId === 'string' ? parsed.documentId : null,
    };
  } catch {
    return null;
  }
}

function writePersisted(selection: PersistedSelection): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // Private mode / quota — the in-memory selection still works for this page.
  }
}

export interface ImportWorkflowContextValue {
  /** All projects in the workspace. */
  projects: ReturnType<typeof useProjects>['projects'];
  projectsLoading: boolean;
  /** The selected project id ('' when none exist). */
  projectId: string;
  setProjectId: (projectId: string) => void;

  /** Document list of the selected project (authoritative, from the hook). */
  documents: SourceDocument[];
  documentsStatus: UseImportDocumentsResult['status'];
  documentsLoading: boolean;
  documentsError: unknown;
  /** Reloads the document list (after a mutation outside the hook). */
  refreshDocuments: () => Promise<void>;

  /** The document the following stages operate on, or null. */
  documentId: string | null;
  /** The resolved selected document object, or null when none/missing. */
  document: SourceDocument | null;
  /** Selects the document used by the parser/structure/extraction stages. */
  selectDocument: (documentId: string | null) => void;

  /** The shared `useImportDocuments` result (create/parse/confirm/delete…). */
  importDocs: UseImportDocumentsResult;
}

const ImportWorkflowContext = createContext<ImportWorkflowContextValue | null>(null);

export function ImportWorkflowProvider({ children }: { children: ReactNode }) {
  const { projects, initialLoading: projectsLoading } = useProjects();

  const [projectId, setProjectIdState] = useState<string>(() => readPersisted()?.projectId ?? '');
  const [documentId, setDocumentIdState] = useState<string | null>(
    () => readPersisted()?.documentId ?? null,
  );

  // Default to the first project once projects have loaded.
  const effectiveProjectId = projectId || projects[0]?.id || '';

  const importDocs = useImportDocuments(effectiveProjectId);

  /** Switching project invalidates the document selection (docs are project-scoped). */
  const setProjectId = useCallback(
    (nextProjectId: string) => {
      setProjectIdState((previous) => {
        if (previous !== nextProjectId) setDocumentIdState(null);
        return nextProjectId;
      });
    },
    [],
  );

  const selectDocument = useCallback((nextDocumentId: string | null) => {
    setDocumentIdState(nextDocumentId);
  }, []);

  // Persist the selection for the next route in the workflow.
  useEffect(() => {
    if (!effectiveProjectId) return;
    writePersisted({ projectId: effectiveProjectId, documentId });
  }, [effectiveProjectId, documentId]);

  // Drop a persisted document that no longer exists in this project (deleted
  // document, or a stale session from another project). Only acts once the list
  // has genuinely loaded, so it never clears a valid selection mid-load.
  useEffect(() => {
    if (documentId === null) return;
    if (importDocs.status !== 'success') return;
    const stillExists = importDocs.documents.some((doc) => doc.id === documentId);
    if (!stillExists) setDocumentIdState(null);
  }, [documentId, importDocs.documents, importDocs.status]);

  const document = useMemo(
    () => importDocs.documents.find((candidate) => candidate.id === documentId) ?? null,
    [importDocs.documents, documentId],
  );

  const value = useMemo<ImportWorkflowContextValue>(
    () => ({
      projects,
      projectsLoading,
      projectId: effectiveProjectId,
      setProjectId,
      documents: importDocs.documents,
      documentsStatus: importDocs.status,
      documentsLoading: importDocs.loading,
      documentsError: importDocs.error,
      refreshDocuments: importDocs.refresh,
      documentId,
      document,
      selectDocument,
      importDocs,
    }),
    [
      projects,
      projectsLoading,
      effectiveProjectId,
      setProjectId,
      importDocs,
      documentId,
      document,
      selectDocument,
    ],
  );

  return <ImportWorkflowContext.Provider value={value}>{children}</ImportWorkflowContext.Provider>;
}

/** Access the shared import-workflow state. Throws outside the workflow shell. */
export function useImportWorkflow(): ImportWorkflowContextValue {
  const context = useContext(ImportWorkflowContext);
  if (!context) {
    throw new Error('[import-workflow] useImportWorkflow must be used inside <ImportWorkflowProvider>.');
  }
  return context;
}
