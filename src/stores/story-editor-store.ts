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

/** Editor font-family presets — mapped to concrete CSS by `EditorSurface`. */
export const EDITOR_FONT_FAMILIES = ['serif', 'sans', 'mono'] as const;
export type EditorFontFamily = (typeof EDITOR_FONT_FAMILIES)[number];

/**
 * Line spacing bounds for the writing surface, as a CSS line-height MULTIPLIER.
 *
 * A continuous 1.0–2.5 range in 0.1 steps replaced the former
 * compact/normal/relaxed presets: the author gets fine control while the bounds
 * keep prose legible (below 1.0 lines collide, above 2.5 the measure becomes
 * unreadable). `DEFAULT_LINE_SPACING` equals the old "normal" preset, so an
 * existing user sees no visual jump.
 */
export const LINE_SPACING_MIN = 1;
export const LINE_SPACING_MAX = 2.5;
export const LINE_SPACING_STEP = 0.1;
export const DEFAULT_LINE_SPACING = 1.7;

/** Rounds (to the 0.1 grid) and clamps an arbitrary line spacing. */
export function clampLineSpacing(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LINE_SPACING;
  // Snap to the step grid so float noise (`1.7000000000000002`) never reaches
  // the DOM or the persisted store.
  const stepped = Math.round(value * 10) / 10;
  return Math.min(Math.max(stepped, LINE_SPACING_MIN), LINE_SPACING_MAX);
}

/**
 * Maps the LEGACY named line-height presets (`'compact' | 'normal' | 'relaxed'`)
 * onto the numeric scale, so a user who persisted one keeps the look they chose
 * instead of silently resetting. Mirrors the old EditorSurface mapping.
 */
const LEGACY_LINE_HEIGHTS: Record<string, number> = {
  compact: 1.5,
  normal: DEFAULT_LINE_SPACING,
  relaxed: 1.95,
};

/**
 * Story Editor writing-surface appearance.
 *
 *   - `default`    → inherits the current app surface (light or dark). This is
 *                    the DEFAULT so every existing user keeps today's look; the
 *                    stored value is absent for them and resolves to this.
 *   - `warm-paper` → a soft, low-saturation warm beige/cream paper surface that
 *                    is scoped to the manuscript editing/reading area ONLY. It
 *                    never touches the Sidebar, Topbar, Dashboard or other pages.
 *
 * Independent of the application-wide Light/Dark theme (`core/theme/theme.ts`),
 * so switching Light/Dark keeps the editor appearance, and vice versa.
 */
export const EDITOR_APPEARANCES = ['default', 'warm-paper'] as const;
export type EditorAppearance = (typeof EDITOR_APPEARANCES)[number];
export const DEFAULT_EDITOR_APPEARANCE: EditorAppearance = 'default';

/**
 * Typography of the writing surface.
 *
 * `fontFamily` and `fontSize` live here (so they persist with the rest of the
 * workspace), but their UI moved to the in-header toolbar; the Typography
 * popover now edits only Appearance, Line spacing and Text width.
 *
 * `indent` was removed entirely — a first-line indent is no longer offered and
 * any old persisted value is simply dropped during the store merge.
 */
export interface EditorTypography {
  fontFamily: EditorFontFamily;
  /** Base font size in px (13–24). */
  fontSize: number;
  /** CSS line-height multiplier, 1.0–2.5 in 0.1 steps. */
  lineHeight: number;
  /** Max content width in px; 0 = full width. */
  maxWidth: number;
}

export const DEFAULT_TYPOGRAPHY: EditorTypography = {
  fontFamily: 'serif',
  fontSize: 16,
  lineHeight: DEFAULT_LINE_SPACING,
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

  /** Writing-surface appearance (independent of the global Light/Dark theme). */
  editorAppearance: EditorAppearance;
  setEditorAppearance: (value: EditorAppearance) => void;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

/**
 * Normalises one (possibly persisted / legacy / corrupt) typography object into
 * the current shape. Centralised so BOTH `updateTypography` and the persist
 * `merge` apply identical rules — a bad persisted blob can never reach layout,
 * and a legacy named line-height is migrated to its numeric equivalent.
 */
function normaliseTypography(input: Partial<EditorTypography> | undefined): EditorTypography {
  const source = (input ?? {}) as Partial<EditorTypography> & { lineHeight?: unknown };

  const family = EDITOR_FONT_FAMILIES.includes(source.fontFamily as EditorFontFamily)
    ? (source.fontFamily as EditorFontFamily)
    : DEFAULT_TYPOGRAPHY.fontFamily;

  // Legacy builds stored a named preset; new builds store a number.
  const rawLineHeight = source.lineHeight;
  const lineHeight =
    typeof rawLineHeight === 'number'
      ? clampLineSpacing(rawLineHeight)
      : typeof rawLineHeight === 'string' && rawLineHeight in LEGACY_LINE_HEIGHTS
        ? LEGACY_LINE_HEIGHTS[rawLineHeight]
        : DEFAULT_LINE_SPACING;

  const rawSize = typeof source.fontSize === 'number' ? source.fontSize : NaN;
  const rawWidth = typeof source.maxWidth === 'number' ? source.maxWidth : NaN;

  return {
    fontFamily: family,
    fontSize: clamp(Math.round(Number.isFinite(rawSize) ? rawSize : DEFAULT_TYPOGRAPHY.fontSize), 13, 24),
    lineHeight,
    maxWidth: clamp(Math.round(Number.isFinite(rawWidth) ? rawWidth : DEFAULT_TYPOGRAPHY.maxWidth), 0, 1200),
  };
}

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
        set((state) => ({ typography: normaliseTypography({ ...state.typography, ...patch }) })),
      resetTypography: () => set({ typography: { ...DEFAULT_TYPOGRAPHY } }),

      editorAppearance: DEFAULT_EDITOR_APPEARANCE,
      setEditorAppearance: (editorAppearance) => set({ editorAppearance }),
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
        editorAppearance: state.editorAppearance,
      }),
      // Persisted state from BEFORE `editorAppearance` existed has no such key;
      // typography from BEFORE the numeric line spacing stored a preset name
      // (and an `indent` field that no longer exists). Merge normalises BOTH so
      // old users keep their other preferences AND their chosen look.
      merge: (persisted, current) => {
        const merged = { ...current, ...(persisted as Partial<StoryEditorState>) };
        if (!EDITOR_APPEARANCES.includes(merged.editorAppearance)) {
          merged.editorAppearance = DEFAULT_EDITOR_APPEARANCE;
        }
        merged.typography = normaliseTypography(merged.typography);
        return merged;
      },
    },
  ),
);
