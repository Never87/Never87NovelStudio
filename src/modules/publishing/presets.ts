/**
 * Built-in publishing preset registry (P9 Batch A).
 *
 * A preset expresses ONLY the formatting options the current pipeline can
 * actually consume (headings, paragraph layout, metadata header, scene breaks,
 * file naming). It is declarative data — the pipeline reads it, nothing mutates
 * it, and no writer applies preset rules itself.
 *
 * CAVEAT: these presets are pragmatic, conservative defaults. They do NOT claim
 * to exactly satisfy any platform's current submission requirements — those are
 * not verified here and may change. They exist so a writer has stable, named
 * formatting profiles to apply. Platform-specific technical constraints are
 * intentionally NOT invented.
 *
 * Unknown preset ids throw a typed `UnknownPresetError` — we never silently
 * fall back to an unrelated preset.
 */

import type { PublishingPreset } from './types';

/** Raised when a preset id cannot be resolved. */
export class UnknownPresetError extends Error {
  readonly presetId: string;

  constructor(presetId: string) {
    super(`Unknown publishing preset "${presetId}".`);
    this.name = 'UnknownPresetError';
    this.presetId = presetId;
  }
}

/** The preset used whenever a caller does not pick one. */
export const DEFAULT_PRESET_ID = 'generic';

/**
 * The built-in presets. Ordered as they should appear in a future picker.
 *
 * Every preset is frozen semantics-wise: the pipeline treats these as
 * immutable, and `getPreset` returns the shared instance (never a copy that a
 * caller could mutate into the registry). Callers that need to tweak rules
 * should build a `CustomPublishingPreset` (future), not mutate a built-in.
 */
const BASE: Omit<PublishingPreset, 'id' | 'label' | 'builtin'> = {
  metadata: 'title-and-author',
  includeVolumeHeadings: true,
  volumeHeadingTemplate: 'Volume {index}: {title}',
  chapterHeadingStyle: 'number',
  chapterHeadingTemplate: 'Chapter {index}: {title}',
  paragraphStyle: 'indent',
  paragraphIndent: 2,
  paragraphSpacing: 1,
  sceneBreak: '* * *',
  fileNameTemplate: '{title}',
  fileExtension: 'txt',
};

/** A declarative, conservative default profile used by most platforms. */
const GENERIC: PublishingPreset = {
  ...BASE,
  id: 'generic',
  label: 'Generic',
  builtin: true,
};

/**
 * 起点中文网 (Qidian) — web-novel style: no volume labels, chapter title with a
 * full-width space and a numeric marker, indented paragraphs. This is a
 * stylistic approximation, NOT a claim of Qidian submission compliance.
 */
const QIDIAN: PublishingPreset = {
  ...BASE,
  id: 'qidian',
  label: '起点中文网',
  builtin: true,
  metadata: 'title',
  includeVolumeHeadings: false,
  chapterHeadingStyle: 'label',
  chapterHeadingTemplate: '第{index}章 {title}',
  paragraphStyle: 'indent-only',
  paragraphIndent: 2,
  paragraphSpacing: 0,
  sceneBreak: '＊　＊　＊',
};

/**
 * 晋江文学城 (Jinjiang) — indented paragraphs, no blank line between them,
 * simple chapter heading. Stylistic approximation only.
 */
const JINJIANG: PublishingPreset = {
  ...BASE,
  id: 'jinjiang',
  label: '晋江文学城',
  builtin: true,
  metadata: 'title-and-author',
  includeVolumeHeadings: true,
  volumeHeadingTemplate: '卷 {index}　{title}',
  chapterHeadingStyle: 'label',
  chapterHeadingTemplate: '第{index}章　{title}',
  paragraphStyle: 'indent-only',
  paragraphIndent: 2,
  paragraphSpacing: 0,
  sceneBreak: '　　　　　　＊＊＊',
};

/**
 * 番茄小说 (Fanqie) — minimal headings, indented paragraphs, no blank lines.
 * Stylistic approximation only.
 */
const FANQIE: PublishingPreset = {
  ...BASE,
  id: 'fanqie',
  label: '番茄小说',
  builtin: true,
  metadata: 'title',
  includeVolumeHeadings: false,
  chapterHeadingStyle: 'label',
  chapterHeadingTemplate: '第{index}章　{title}',
  paragraphStyle: 'indent-only',
  paragraphIndent: 2,
  paragraphSpacing: 0,
  sceneBreak: '＊　＊　＊',
};

/** Wattpad — blank-line separated paragraphs, no indentation, plain headings. */
const WATTPAD: PublishingPreset = {
  ...BASE,
  id: 'wattpad',
  label: 'Wattpad',
  builtin: true,
  metadata: 'title',
  includeVolumeHeadings: false,
  chapterHeadingStyle: 'label',
  chapterHeadingTemplate: '{title}',
  paragraphStyle: 'blank-line',
  paragraphIndent: 0,
  paragraphSpacing: 1,
  sceneBreak: '* * *',
};

/** Royal Road — Markdown-friendly headings, blank-line paragraphs. */
const ROYAL_ROAD: PublishingPreset = {
  ...BASE,
  id: 'royal-road',
  label: 'Royal Road',
  builtin: true,
  metadata: 'title-and-author',
  includeVolumeHeadings: true,
  volumeHeadingTemplate: 'Volume {index}: {title}',
  chapterHeadingStyle: 'number',
  chapterHeadingTemplate: 'Chapter {index}: {title}',
  paragraphStyle: 'blank-line',
  paragraphIndent: 0,
  paragraphSpacing: 1,
  sceneBreak: '* * *',
};

/**
 * Amazon KDP — print-ish manuscript style: generous indentation, blank line
 * between paragraphs, titled chapters. This is a common manuscript convention,
 * NOT a claim of KDP conversion compliance.
 */
const AMAZON_KDP: PublishingPreset = {
  ...BASE,
  id: 'amazon-kdp',
  label: 'Amazon KDP',
  builtin: true,
  metadata: 'title-and-author',
  includeVolumeHeadings: true,
  volumeHeadingTemplate: 'Volume {index}: {title}',
  chapterHeadingStyle: 'number',
  chapterHeadingTemplate: 'Chapter {index}: {title}',
  paragraphStyle: 'indent',
  paragraphIndent: 4,
  paragraphSpacing: 1,
  sceneBreak: '# # #',
};

/** Generic EPUB — semantic headings, blank-line paragraphs, clean file name. */
const GENERIC_EPUB: PublishingPreset = {
  ...BASE,
  id: 'generic-epub',
  label: 'Generic EPUB',
  builtin: true,
  metadata: 'title-and-author',
  includeVolumeHeadings: true,
  volumeHeadingTemplate: 'Volume {index}: {title}',
  chapterHeadingStyle: 'number',
  chapterHeadingTemplate: 'Chapter {index}: {title}',
  paragraphStyle: 'blank-line',
  paragraphIndent: 0,
  paragraphSpacing: 1,
  sceneBreak: '* * *',
};

/** Ordered list of every built-in preset. */
const BUILTIN_PRESETS: readonly PublishingPreset[] = Object.freeze([
  GENERIC,
  QIDIAN,
  JINJIANG,
  FANQIE,
  WATTPAD,
  ROYAL_ROAD,
  AMAZON_KDP,
  GENERIC_EPUB,
]);

const PRESET_BY_ID: ReadonlyMap<string, PublishingPreset> = new Map(
  BUILTIN_PRESETS.map((preset) => [preset.id, preset]),
);

/** Stable ids of every built-in preset, in registry order. */
export const BUILTIN_PRESET_IDS: readonly string[] = Object.freeze(
  BUILTIN_PRESETS.map((preset) => preset.id),
);

/** Every built-in preset (frozen array; the preset objects are shared). */
export function listPresets(): readonly PublishingPreset[] {
  return BUILTIN_PRESETS;
}

/**
 * Looks a preset up by id.
 *
 * @throws {UnknownPresetError} when no preset has that id (never a silent
 *   fallback to a different preset).
 */
export function getPreset(id: string): PublishingPreset {
  const preset = PRESET_BY_ID.get(id);
  if (!preset) throw new UnknownPresetError(id);
  return preset;
}

/** Whether `id` names a known built-in preset. */
export function hasPreset(id: string): boolean {
  return PRESET_BY_ID.has(id);
}

/** The default preset (`generic`). Throws only if the registry is corrupt. */
export function getDefaultPreset(): PublishingPreset {
  return getPreset(DEFAULT_PRESET_ID);
}
