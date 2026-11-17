import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Story Editor view preferences.
 *
 * These are EPHEMERAL layout/typography choices (which panel is collapsed, how
 * wide the side panels are, the chosen font size…) — never novel data. They are
 * persisted under `n87-story-editor` so the author's workspace feels stable
 * across reloads, exactly like the sidebar collapse in `ui-store`. Focus Mode is
 * deliberately NOT persisted: a reload must return to the normal, safe layout
 * (a user should never be "stuck" inside Focus Mode after a crash).
 *
 * Kept in its own store so the global `ui-store` stays focused on shell chrome
 * and so the editor can subscribe narrowly without re-rendering the app shell.
 */

/** Editor typography presets — mapped to concrete CSS by `EditorSurface`. */
export const EDITOR_FONT_FAMILIES = ['serif', 'sans', 'mono'] as const;
export type EditorFontFamily = (typeof EDITOR_FONT_FAMILIES)[number];

/** Line-height presets for the writing surface. */
export const EDITOR_LINE_HEIGHTS = ['compact', 'normal', 'relaxed'] as const;
export type EditorLineHeight = (typeof EDITOR_LINE_HEIGHTS)[number];

/** Paragraph indentation style (common in CJK / literary manuscripts). */
export const EDITOR_INDENTS = ['none', 'first'] as const;
export type EditorIndent = (typeof EDITOR_INDENTS)[number];

export interface EditorTypography {
  fontFamily: EditorFontFamily;
  /** Base font size in px (13–24). */
  fontSize: number;
  lineHeight: EditorLineHeight;
  indent: EditorIndent;
  /** Max content width in ch-ish px; 0 = full width. */
  maxWidth: number;
}

export const DEFAULT_TYPOGRAPHY: EditorTypography = {
  fontFamily: 'serif',
  fontSize: 16,
  lineHeight: 'normal',
  indent: 'none',
  maxWidth: 720,
};

/** Width bounds for the resizable side panels (px). */
export const PANEL_WIDTH_BOUNDS = { min: 180, max: 420 } as const;

interface StoryEditorState {
  /** Focus Mode hides the global sidebar/topbar and peripheral UI. Not persisted. */
  focusMode: boolean;
  /** Left manuscript panel collapsed. */
  manuscriptCollapsed: boolean;
  /** Right AI panel collapsed. */
  aiCollapsed: boolean;
  /** Width in px of the expanded manuscript panel. */
  manuscriptWidth: number;
  /** Width in px of the expanded AI panel. */
  aiWidth: number;
  typography: EditorTypography;

  setFocusMode: (value: boolean) => void;
  toggleFocusMode: () => void;
  toggleManuscript: () => void;
  toggleAi: () => void;
  setManuscriptWidth: (width: number) => void;
  setAiWidth: (width: number) => void;
  updateTypography: (patch: Partial<EditorTypography>) => void;
  resetTypography: () => void;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

export const useStoryEditorStore = create<StoryEditorState>()(
  persist(
    (set) => ({
      focusMode: false,
      manuscriptCollapsed: false,
      aiCollapsed: false,
      manuscriptWidth: 240,
      aiWidth: 256,
      typography: { ...DEFAULT_TYPOGRAPHY },

      setFocusMode: (focusMode) => set({ focusMode }),
      toggleFocusMode: () => set((state) => ({ focusMode: !state.focusMode })),
      toggleManuscript: () =>
        set((state) => ({ manuscriptCollapsed: !state.manuscriptCollapsed })),
      toggleAi: () => set((state) => ({ aiCollapsed: !state.aiCollapsed })),
      setManuscriptWidth: (width) =>
        set({ manuscriptWidth: clamp(width, PANEL_WIDTH_BOUNDS.min, PANEL_WIDTH_BOUNDS.max) }),
      setAiWidth: (width) =>
        set({ aiWidth: clamp(width, PANEL_WIDTH_BOUNDS.min, PANEL_WIDTH_BOUNDS.max) }),
      updateTypography: (patch) =>
        set((state) => {
          const next = { ...state.typography, ...patch };
          // Defensive clamps so a corrupt persisted value can never break layout.
          next.fontSize = clamp(Math.round(next.fontSize), 13, 24);
          next.maxWidth = clamp(Math.round(next.maxWidth), 0, 1200);
          return { typography: next };
        }),
      resetTypography: () => set({ typography: { ...DEFAULT_TYPOGRAPHY } }),
    }),
    {
      name: 'n87-story-editor',
      // Focus Mode must not survive a reload (see module doc).
      partialize: (state) => ({
        manuscriptCollapsed: state.manuscriptCollapsed,
        aiCollapsed: state.aiCollapsed,
        manuscriptWidth: state.manuscriptWidth,
        aiWidth: state.aiWidth,
        typography: state.typography,
      }),
    },
  ),
);
