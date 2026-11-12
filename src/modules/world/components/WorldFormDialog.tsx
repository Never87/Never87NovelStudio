import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { Button, IconButton } from '@/components/ui';
import type { World } from '@/types';
import { WorldSchema } from '@/schemas/world';
import { createWorldSectionId } from '@/utils/id';
import type { CreateWorldInput, UpdateWorldInput } from '@/services';
import { ProjectDialog } from '@/modules/projects/components/ProjectDialog';
import { TextAreaField, TextField } from '@/modules/projects/components/FormFields';
import { describeError } from '@/modules/projects/components/ProjectFormDialog';
import { WORLD_SECTION_PRESETS } from '../world-meta';

/** A section being edited, with a stable key for React and the stored id. */
interface SectionDraft {
  key: string;
  id: string;
  title: string;
  content: string;
}

interface FormValues {
  title: string;
  overview: string;
  themes: string;
  era: string;
  technology: string;
  sections: SectionDraft[];
}

type FieldErrors = Partial<Record<'title' | 'overview' | 'themes' | 'era' | 'technology' | 'sections' | 'form', string>>;

export interface WorldFormDialogProps {
  open: boolean;
  /** When provided the dialog edits this world; otherwise it creates one. */
  initialWorld?: World | null;
  onSubmit: (input: CreateWorldInput | UpdateWorldInput) => Promise<unknown>;
  onClose: () => void;
}

function newSection(title = ''): SectionDraft {
  const id = createWorldSectionId();
  return { key: id, id, title, content: '' };
}

function toFormValues(world?: World | null): FormValues {
  return {
    title: world?.title ?? '',
    overview: world?.overview ?? '',
    themes: world?.themes.join(', ') ?? '',
    era: world?.settings.era ?? '',
    technology: world?.settings.technology ?? '',
    sections:
      world && world.sections.length > 0
        ? world.sections.map((section) => ({
            key: section.id,
            id: section.id,
            title: section.title,
            content: section.content,
          }))
        : [],
  };
}

/** Splits a comma-separated string into a trimmed, de-duplicated list. */
function parseList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const value = part.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/**
 * Create / edit world dialog.
 *
 * Validation mirrors the UI approach used by `ProjectFormDialog`: the assembled
 * payload is validated with the real `WorldSchema`, so UI rules can never drift
 * from the data model. Empty section rows are dropped on submit rather than
 * rejected, so a user can add a row and abandon it.
 */
export function WorldFormDialog({ open, initialWorld, onSubmit, onClose }: WorldFormDialogProps) {
  const isEdit = Boolean(initialWorld);
  const [values, setValues] = useState<FormValues>(() => toFormValues(initialWorld));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const submittingRef = useRef(false);

  useEffect(() => {
    if (open) {
      setValues(toFormValues(initialWorld));
      setErrors({});
      setSubmitError(null);
      setSaving(false);
      submittingRef.current = false;
    }
  }, [open, initialWorld]);

  const setField = <K extends keyof FormValues>(key: K, value: FormValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => (prev[key] || prev.form ? { ...prev, [key]: undefined, form: undefined } : prev));
  };

  const updateSection = (key: string, patch: Partial<Pick<SectionDraft, 'title' | 'content'>>) => {
    setValues((prev) => ({
      ...prev,
      sections: prev.sections.map((section) =>
        section.key === key ? { ...section, ...patch } : section,
      ),
    }));
    setErrors((prev) => (prev.sections ? { ...prev, sections: undefined } : prev));
  };

  const addSection = (title = '') => {
    setValues((prev) => ({ ...prev, sections: [...prev.sections, newSection(title)] }));
  };

  const removeSection = (key: string) => {
    setValues((prev) => ({ ...prev, sections: prev.sections.filter((section) => section.key !== key) }));
  };

  /** Sections with a non-empty title are kept; blank rows are dropped. */
  const keptSections = () => values.sections.filter((section) => section.title.trim() !== '');

  const validate = (): boolean => {
    const next: FieldErrors = {};

    if (!values.title.trim()) next.title = 'Title is required.';
    else if (values.title.trim().length > 200) next.title = 'Title must be at most 200 characters.';

    if (values.overview.length > 20_000) {
      next.overview = 'Overview must be at most 20000 characters.';
    }

    // Validate the assembled payload with the real schema.
    const candidate = {
      id: initialWorld?.id ?? 'draft',
      projectId: initialWorld?.projectId ?? 'draft',
      title: values.title.trim() || ' ',
      overview: values.overview,
      sections: keptSections().map((section) => ({
        id: section.id,
        title: section.title,
        content: section.content,
      })),
      themes: parseList(values.themes),
      settings: {
        ...(values.era.trim() !== '' ? { era: values.era.trim() } : {}),
        ...(values.technology.trim() !== '' ? { technology: values.technology.trim() } : {}),
      },
      createdAt: initialWorld?.createdAt ?? 0,
      updatedAt: initialWorld?.updatedAt ?? 0,
    };
    const result = WorldSchema.safeParse(candidate);
    if (!result.success) {
      for (const issue of result.error.issues) {
        const [head] = issue.path;
        if (head === 'sections') next.sections = issue.message;
        else if (head === 'themes') next.themes = 'Each theme must be 1–80 characters.';
        else if (head === 'title') next.title = issue.message;
        else if (head === 'overview') next.overview = issue.message;
      }
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submittingRef.current || saving) return;
    if (!validate()) return;

    submittingRef.current = true;
    setSaving(true);
    setSubmitError(null);

    const title = values.title.trim();
    const themes = parseList(values.themes);
    const sections = keptSections().map((section) => ({
      id: section.id,
      title: section.title,
      content: section.content,
    }));
    const era = values.era.trim();
    const technology = values.technology.trim();

    try {
      if (isEdit && initialWorld) {
        const input: UpdateWorldInput = {
          title,
          overview: values.overview,
          sections,
          themes,
          // null clears the field; a value sets it.
          settings: {
            era: era === '' ? null : era,
            technology: technology === '' ? null : technology,
          },
        };
        await onSubmit(input);
      } else {
        const input: CreateWorldInput = {
          title,
          overview: values.overview,
          sections,
          themes,
          settings: {
            ...(era !== '' ? { era } : {}),
            ...(technology !== '' ? { technology } : {}),
          },
        };
        await onSubmit(input);
      }
      onClose();
    } catch (error) {
      setSubmitError(describeError(error));
    } finally {
      submittingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <ProjectDialog
      open={open}
      title={isEdit ? 'Edit world' : 'New world'}
      description={
        isEdit
          ? 'Update your setting. Changes are saved immediately.'
          : 'Define the setting, history and rules of your novel.'
      }
      onClose={onClose}
      dismissible={!saving}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="submit"
            form="world-form"
            loading={saving}
            iconLeft={!saving ? <Save className="size-3.5" /> : undefined}
          >
            {isEdit ? 'Save changes' : 'Create world'}
          </Button>
        </>
      }
    >
      <form id="world-form" onSubmit={handleSubmit} className="space-y-3.5" noValidate>
        <TextField
          label="Title"
          required
          value={values.title}
          onChange={(event) => setField('title', event.target.value)}
          placeholder="e.g. The Drowned Archipelago"
          error={errors.title}
          maxLength={200}
          autoFocus
        />

        <TextAreaField
          label="Overview"
          value={values.overview}
          onChange={(event) => setField('overview', event.target.value)}
          placeholder="A high-level summary of the world."
          error={errors.overview}
          rows={3}
        />

        <div className="grid gap-3.5 sm:grid-cols-2">
          <TextField
            label="Era"
            value={values.era}
            onChange={(event) => setField('era', event.target.value)}
            placeholder="e.g. Age of Sail"
            error={errors.era}
            maxLength={120}
          />
          <TextField
            label="Technology / magic"
            value={values.technology}
            onChange={(event) => setField('technology', event.target.value)}
            placeholder="e.g. Early steam, forbidden sea-magic"
            error={errors.technology}
            maxLength={200}
          />
        </div>

        <TextField
          label="Themes"
          value={values.themes}
          onChange={(event) => setField('themes', event.target.value)}
          placeholder="isolation, memory, the sea"
          error={errors.themes}
          hint="Comma-separated."
        />

        <div className="border-line space-y-2 border-t pt-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-ink text-xs font-medium">Sections</p>
              <p className="text-subtle text-2xs">Break the world into ordered, named parts.</p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              iconLeft={<Plus className="size-3.5" />}
              onClick={() => addSection()}
              type="button"
            >
              Add section
            </Button>
          </div>

          {errors.sections ? (
            <p className="text-danger text-2xs" role="alert">
              {errors.sections}
            </p>
          ) : null}

          {values.sections.length === 0 ? (
            <p className="text-subtle text-2xs italic">
              No sections yet. Add one to get started.
            </p>
          ) : (
            <ul className="space-y-2">
              {values.sections.map((section, index) => (
                <li key={section.key} className="bg-surface-muted/40 border-line rounded-md border p-2.5">
                  <div className="flex items-end gap-2">
                    <TextField
                      label={`Section ${index + 1}`}
                      value={section.title}
                      onChange={(event) => updateSection(section.key, { title: event.target.value })}
                      placeholder="Section title"
                      maxLength={80}
                      className="flex-1"
                      list="world-section-presets"
                    />
                    <IconButton
                      variant="ghost"
                      size="sm"
                      label={`Remove section ${index + 1}`}
                      icon={<Trash2 className="size-3.5" aria-hidden />}
                      onClick={() => removeSection(section.key)}
                    />
                  </div>
                  <TextAreaField
                    label="Body"
                    value={section.content}
                    onChange={(event) => updateSection(section.key, { content: event.target.value })}
                    placeholder="Details for this section."
                    rows={3}
                    className="mt-2"
                  />
                </li>
              ))}
            </ul>
          )}

          <datalist id="world-section-presets">
            {WORLD_SECTION_PRESETS.map((preset) => (
              <option key={preset} value={preset} />
            ))}
          </datalist>
        </div>

        {submitError ? (
          <div
            role="alert"
            className="border-danger/30 bg-danger-soft text-danger flex items-start gap-2 rounded-md border px-3 py-2 text-xs"
          >
            <RefreshCw className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span className="whitespace-pre-wrap break-words">{submitError}</span>
          </div>
        ) : null}
      </form>
    </ProjectDialog>
  );
}
