/**
 * Publishing & Export module (P9 Batch A — shared foundation).
 *
 * Pure, UI-free building blocks for the shared publishing pipeline:
 *
 *   BookAssemblyModel → (FormattingPipeline + Preset) → RenderedDocument → writer
 *
 * This barrel is importable from the service layer (it has NO React imports and
 * no dependency on `@/services`), which keeps the boundary clean: the read-only
 * `BookAssemblyService` (in `@/services`) builds the model; everything below turns
 * it into bytes.
 *
 * NOT included in this batch: custom-preset editing/persistence, preview UI,
 * download UI, DOCX/EPUB/PDF writers.
 */

export type {
  // Assembly model.
  AssemblyProjectMetadata,
  AssemblyVolume,
  AssemblyChapter,
  AssemblyChapterStats,
  AssemblyChapterSource,
  BookAssemblyModel,
  // Presets.
  PublishingPreset,
  CustomPublishingPreset,
  ChapterHeadingStyle,
  ParagraphStyle,
  MetadataPolicy,
  // RenderedDocument IR.
  RenderedDocument,
  RenderedDocumentMetadata,
  RenderedVolume,
  RenderedChapter,
  RenderedBlock,
} from './types';

export {
  UnknownPresetError,
  DEFAULT_PRESET_ID,
  BUILTIN_PRESET_IDS,
  listPresets,
  getPreset,
  hasPreset,
  getDefaultPreset,
} from './presets';

export { FormattingPipeline, renderDocument } from './formatting-pipeline';

export { renderTxt, renderMarkdown, renderHtml, escapeHtml } from './writers';

/* ---------------------- Batch C export writers --------------------------- */

export {
  renderDocx,
  renderEpub,
  renderPdf,
  escapeXml,
  parseInlineRuns,
  isPlainText,
  type InlineRun,
  EXPORT_FORMATS,
  DEFAULT_EXPORT_FORMAT,
  FONT_FREE_FORMATS,
  isExportFormat,
  getExportFormat,
  type ExportFormat,
  type ExportFormatDescriptor,
  ExportError,
  EXPORT_ERROR_CODES,
  type ExportErrorCode,
  type ExportPhase,
  type ExportWriterOptions,
  type EpubCoverInput,
  type WriterResult,
} from './writers';
export {
  PublishingPresetStore,
  PresetMutationError,
  PresetValidationError,
  publishingPresetStore,
  defaultDraft,
  draftFromPreset,
  assertKnownPreset,
  PRESET_STORAGE_KEY,
  PRESET_STORAGE_VERSION,
  type CustomPresetEntry,
  type PresetState,
  type PresetStorage,
} from './preset-store';
export {
  MAX_FILE_NAME_LENGTH,
  FALLBACK_FILE_NAME,
  truncateUnicode,
  sanitizeFileName,
  buildFileName,
  buildFileNameFromTemplate,
} from './filename';

export {
  toSelectableChapters,
  chaptersInVolume,
  normalizeSelection,
  pruneToAllowed,
  toggleSelection,
  selectAllInVolume,
  clearSelection,
  summarizeSelection,
  type SelectableChapter,
  type SelectionSummary,
} from './chapter-selection';

