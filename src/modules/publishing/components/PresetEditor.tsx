/**
 * Custom preset editor dialog (P9 Batch B).
 *
 * Create or edit a custom preset. Only exposes the options the Batch A
 * `FormattingPipeline` actually consumes. Validation uses the SAME Zod schema
 * the store uses, so the form and persistence can never disagree; field errors
 * are shown inline and the dialog stays open on failure.
 *
 * Editing an existing BUILT-IN is impossible here: the page passes a built-in
 * only through "duplicate/create from", which clones it into a new custom draft.
 */

import { useEffect, useMemo, useState } from 'react';
import { ProjectDialog } from '@/modules/projects/components/ProjectDialog';
import { Button } from '@/components/ui';
import { Field, NumberInput, Select, TextInput } from '@/modules/ai/components/fields';
import {
  CHAPTER_HEADING_STYLES,
  CustomPresetDraftSchema,
  METADATA_POLICIES,
  PARAGRAPH_STYLES,
  type CustomPresetDraft,
} from '@/schemas/publishing-preset';
import {
  CHAPTER_HEADING_STYLE_LABELS,
  METADATA_POLICY_LABELS,
  PARAGRAPH_STYLE_LABELS,
} from './preset-describe';

export interface PresetEditorProps {
  open: boolean;
  /** "Create" or "Edit" — affects the title and confirm label. */
  mode: 'create' | 'edit';
  /** The initial draft (a clone; the editor owns its own state). */
  initial: CustomPresetDraft;
  /** Called with a validated draft. May throw a PresetValidationError-like. */
  onSubmit: (draft: CustomPresetDraft) => void;
  onClose: () => void;
}

/** Extracts `field -> first message` from a Zod parse failure. */
function fieldErrorsFrom(issues: readonly { path: (string | number)[]; message: string }[]) {
  const map: Record<string, string> = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? '');
    if (key && !map[key]) map[key] = issue.message;
  }
  return map;
}

export function PresetEditor({ open, mode, initial, onSubmit, onClose }: PresetEditorProps) {
  const [draft, setDraft] = useState<CustomPresetDraft>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Reset the draft whenever the dialog opens with a new initial value.
  useEffect(() => {
    if (open) {
      setDraft(initial);
      setErrors({});
      setSubmitError(null);
    }
    // `initial` is intentionally excluded: the dialog resets only on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const indentRelevant = draft.paragraphStyle === 'indent' || draft.paragraphStyle === 'indent-only';
  const headingTemplateRelevant = draft.chapterHeadingStyle !== 'none';

  const set = <K extends keyof CustomPresetDraft>(key: K, value: CustomPresetDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key as string];
      return next;
    });
  };

  const handleSubmit = () => {
    // Validate with the exact persisted schema before handing off.
    const result = CustomPresetDraftSchema.safeParse(draft);
    if (!result.success) {
      setErrors(fieldErrorsFrom(result.error.issues));
      setSubmitError('Please fix the highlighted fields.');
      return;
    }
    try {
      onSubmit(result.data);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'The preset could not be saved.');
    }
  };

  const titleText = useMemo(
    () => (mode === 'create' ? 'New custom preset' : 'Edit custom preset'),
    [mode],
  );

  return (
    <ProjectDialog
      open={open}
      title={titleText}
      description="These controls map directly to the formatting the export pipeline applies — nothing here is decorative."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleSubmit}
            data-testid="preset-editor-save"
          >
            {mode === 'create' ? 'Create preset' : 'Save changes'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Preset name" required htmlFor="preset-name" error={errors.label}>
          <TextInput
            id="preset-name"
            data-testid="preset-name-input"
            value={draft.label}
            onChange={(e) => set('label', e.target.value)}
            placeholder="e.g. My Kindle profile"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Title header" htmlFor="preset-metadata">
            <Select
              id="preset-metadata"
              data-testid="preset-metadata"
              value={draft.metadata}
              onChange={(e) => set('metadata', e.target.value as CustomPresetDraft['metadata'])}
            >
              {METADATA_POLICIES.map((policy) => (
                <option key={policy} value={policy}>
                  {METADATA_POLICY_LABELS[policy]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Chapter heading"
            htmlFor="preset-chapter-style"
            error={errors.chapterHeadingStyle}
          >
            <Select
              id="preset-chapter-style"
              data-testid="preset-chapter-style"
              value={draft.chapterHeadingStyle}
              onChange={(e) =>
                set('chapterHeadingStyle', e.target.value as CustomPresetDraft['chapterHeadingStyle'])
              }
            >
              {CHAPTER_HEADING_STYLES.map((style) => (
                <option key={style} value={style}>
                  {CHAPTER_HEADING_STYLE_LABELS[style]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {headingTemplateRelevant ? (
          <Field
            label="Chapter heading template"
            htmlFor="preset-chapter-template"
            error={errors.chapterHeadingTemplate}
            hint="Placeholders: {index} and {title}."
          >
            <TextInput
              id="preset-chapter-template"
              data-testid="preset-chapter-template"
              value={draft.chapterHeadingTemplate}
              onChange={(e) => set('chapterHeadingTemplate', e.target.value)}
            />
          </Field>
        ) : null}

        <div className="border-line space-y-3 border-t pt-3">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              data-testid="preset-include-volumes"
              checked={draft.includeVolumeHeadings}
              onChange={(e) => set('includeVolumeHeadings', e.target.checked)}
            />
            <span className="text-ink">Include volume headings</span>
          </label>
          {draft.includeVolumeHeadings ? (
            <Field
              label="Volume heading template"
              htmlFor="preset-volume-template"
              error={errors.volumeHeadingTemplate}
              hint="Placeholders: {index} and {title}."
            >
              <TextInput
                id="preset-volume-template"
                data-testid="preset-volume-template"
                value={draft.volumeHeadingTemplate}
                onChange={(e) => set('volumeHeadingTemplate', e.target.value)}
              />
            </Field>
          ) : null}
        </div>

        <div className="border-line space-y-3 border-t pt-3">
          <Field label="Paragraph layout" htmlFor="preset-paragraph-style" error={errors.paragraphStyle}>
            <Select
              id="preset-paragraph-style"
              data-testid="preset-paragraph-style"
              value={draft.paragraphStyle}
              onChange={(e) => set('paragraphStyle', e.target.value as CustomPresetDraft['paragraphStyle'])}
            >
              {PARAGRAPH_STYLES.map((style) => (
                <option key={style} value={style}>
                  {PARAGRAPH_STYLE_LABELS[style]}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            {indentRelevant ? (
              <Field label="First-line indent" htmlFor="preset-indent" error={errors.paragraphIndent}>
                <NumberInput
                  id="preset-indent"
                  data-testid="preset-indent"
                  min={0}
                  max={8}
                  value={draft.paragraphIndent}
                  onChange={(e) => set('paragraphIndent', Number(e.target.value))}
                />
              </Field>
            ) : null}
            <Field
              label="Blank lines between paragraphs"
              htmlFor="preset-spacing"
              error={errors.paragraphSpacing}
            >
              <NumberInput
                id="preset-spacing"
                data-testid="preset-spacing"
                min={0}
                max={4}
                value={draft.paragraphSpacing}
                onChange={(e) => set('paragraphSpacing', Number(e.target.value))}
              />
            </Field>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Scene break" htmlFor="preset-scene-break" error={errors.sceneBreak}>
            <TextInput
              id="preset-scene-break"
              data-testid="preset-scene-break"
              value={draft.sceneBreak}
              onChange={(e) => set('sceneBreak', e.target.value)}
            />
          </Field>
          <Field
            label="File extension"
            htmlFor="preset-extension"
            error={errors.fileExtension}
            hint="e.g. txt, md"
          >
            <TextInput
              id="preset-extension"
              data-testid="preset-extension"
              value={draft.fileExtension}
              onChange={(e) => set('fileExtension', e.target.value)}
            />
          </Field>
        </div>

        <Field
          label="File-name template"
          htmlFor="preset-file-template"
          error={errors.fileNameTemplate}
          hint="Placeholders: {title} and {author}. Extension is added automatically."
        >
          <TextInput
            id="preset-file-template"
            data-testid="preset-file-template"
            value={draft.fileNameTemplate}
            onChange={(e) => set('fileNameTemplate', e.target.value)}
          />
        </Field>

        {submitError ? (
          <p className="text-danger text-xs" role="alert" data-testid="preset-editor-error">
            {submitError}
          </p>
        ) : null}
      </div>
    </ProjectDialog>
  );
}
