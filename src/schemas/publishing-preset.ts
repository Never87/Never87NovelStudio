import { z } from 'zod';

/**
 * Custom publishing preset schema (P9 Batch B).
 *
 * Mirrors the SAME formatting options the Batch A `PublishingPreset` type and
 * `FormattingPipeline` actually consume — no more, no less. The form derives its
 * controls from these fields, so the UI can never expose a setting that the
 * pipeline would ignore.
 *
 * Same tsconfig constraints as the other schemas:
 *   - `erasableSyntaxOnly`: no `enum`; literal unions.
 *   - `verbatimModuleSyntax`: type-only imports use `import type`.
 */

/** How a chapter heading is rendered (must match `ChapterHeadingStyle`). */
export const CHAPTER_HEADING_STYLES = ['none', 'number', 'number-padded', 'label'] as const;
export const ChapterHeadingStyleSchema = z.enum(CHAPTER_HEADING_STYLES);

/** Paragraph layout policy (must match `ParagraphStyle`). */
export const PARAGRAPH_STYLES = ['indent', 'indent-only', 'blank-line', 'flush'] as const;
export const ParagraphStyleSchema = z.enum(PARAGRAPH_STYLES);

/** Document metadata header policy (must match `MetadataPolicy`). */
export const METADATA_POLICIES = ['none', 'title', 'title-and-author'] as const;
export const MetadataPolicySchema = z.enum(METADATA_POLICIES);

/** Max lengths keep stored presets bounded and the UI honest. */
const LABEL_MAX = 80;
const TEMPLATE_MAX = 200;
const SCENE_BREAK_MAX = 40;
const FILE_TEMPLATE_MAX = 200;

/** The raw, shared field shape (no strictness), reused by draft & stored schemas. */
const customPresetFields = {
  label: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(LABEL_MAX, `Name must be at most ${LABEL_MAX} characters`),

    metadata: MetadataPolicySchema,

  includeVolumeHeadings: z.boolean(),
  volumeHeadingTemplate: z
    .string()
    .trim()
    .min(1, 'Volume heading template is required')
    .max(TEMPLATE_MAX, `Must be at most ${TEMPLATE_MAX} characters`),

  chapterHeadingStyle: ChapterHeadingStyleSchema,
  chapterHeadingTemplate: z
    .string()
    .trim()
    .min(1, 'Chapter heading template is required')
    .max(TEMPLATE_MAX, `Must be at most ${TEMPLATE_MAX} characters`),

  paragraphStyle: ParagraphStyleSchema,
  /** First-line indent characters. Whole number, 0–8 (sane upper bound). */
  paragraphIndent: z
    .number()
    .int('Indent must be a whole number')
    .min(0, 'Indent cannot be negative')
    .max(8, 'Indent must be at most 8'),
  /** Blank lines between paragraphs. Whole number, 0–4. */
  paragraphSpacing: z
    .number()
    .int('Spacing must be a whole number')
    .min(0, 'Spacing cannot be negative')
    .max(4, 'Spacing must be at most 4'),

  sceneBreak: z.string().max(SCENE_BREAK_MAX, `Must be at most ${SCENE_BREAK_MAX} characters`),

  fileNameTemplate: z
    .string()
    .trim()
    .min(1, 'File-name template is required')
    .max(FILE_TEMPLATE_MAX, `Must be at most ${FILE_TEMPLATE_MAX} characters`),
  fileExtension: z
    .string()
    .trim()
    .min(1, 'File extension is required')
    .max(12, 'Extension must be at most 12 characters')
    // Store bare, lowercase ext without a dot; tolerate a leading dot on input.
    .transform((ext) => ext.replace(/^\.+/, '').toLowerCase())
    .refine((ext) => /^[a-z0-9]+$/.test(ext), {
      message: 'Extension may only contain letters and numbers',
    }),
} as const;

/**
 * A user-defined preset as persisted. `builtin` is NOT stored (the store always
 * creates custom presets); the unique `id` and audit timestamps are store-owned.
 * `.strict()` rejects unknown keys so a malformed record is caught explicitly.
 */
export const CustomPresetDraftSchema = z.object(customPresetFields).strict();

/** The validated custom-preset draft (post-transform). */
export type CustomPresetDraft = z.infer<typeof CustomPresetDraftSchema>;

/**
 * A persisted custom preset record: the draft fields plus store-owned identity
 * and timestamps, in ONE strict object (so `id`/`createdAt`/`updatedAt` are
 * recognised rather than rejected as unknown keys).
 */
export const StoredCustomPresetSchema = z
  .object({
    ...customPresetFields,
    id: z.string().min(1),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type StoredCustomPreset = z.infer<typeof StoredCustomPresetSchema>;

/**
 * The whole persisted envelope. `version` lets a future batch migrate the shape
 * without guessing; `activePresetId` records the shared selection.
 *
 * `customPresets` is validated per-record by the store (so one corrupted record
 * drops only itself, not the whole set) — hence `z.unknown()` elements here.
 */
export const PresetStorageEnvelopeSchema = z.object({
  version: z.literal(1),
  activePresetId: z.string().min(1),
  customPresets: z.array(z.unknown()),
});
export type PresetStorageEnvelope = z.infer<typeof PresetStorageEnvelopeSchema>;

