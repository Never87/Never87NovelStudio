import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Global shell UI state.
 *
 * Persisted under `n87-ui` in localStorage. Only ephemeral layout preferences
 * live here — never novel data (that belongs to IndexedDB via repositories).
 */
interface UiState {
  /** Desktop rail collapse (icon-only mode). */
  sidebarCollapsed: boolean;
  /** Mobile drawer visibility. */
  mobileNavOpen: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setMobileNavOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      mobileNavOpen: false,
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      setMobileNavOpen: (mobileNavOpen) => set({ mobileNavOpen }),
    }),
    {
      name: 'n87-ui',
      // `mobileNavOpen` is transient and must not survive a reload.
      partialize: (state) => ({ sidebarCollapsed: state.sidebarCollapsed }),
    },
  ),
);
