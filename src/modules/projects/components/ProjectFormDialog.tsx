import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { RefreshCw, Save } from 'lucide-react';
import { Button } from '@/components/ui';
import { NovelProjectSchema, PROJECT_STATUSES } from '@/schemas/project';
import type { NovelProject, ProjectSettings, ProjectStatus } from '@/types';
import type { CreateProjectInput, UpdateProjectInput } from '@/services';
import { PROJECT_STATUS_META } from '../project-meta';
import { ProjectDialog } from './ProjectDialog';
import { SelectField, TextAreaField, TextField } from './FormFields';

/** Form values as raw strings — parsing/validation happens on submit. */
interface FormValues {
  title: string;
  description: string;
  status: ProjectStatus;
  genre: string;
  tags: string;
  targetWordCount: string;
  author: string;
  language: string;
}

type FieldErrors = Partial<Record<keyof FormValues | 'form', string>>;

export interface ProjectFormDialogProps {
  open: boolean;
  /** When provided, the dialog is in edit mode and pre-filled from this project. */
  initialProject?: NovelProject | null;
  /**
   * Create mode: `onSubmit(input)`. Edit mode: `onSubmit(input)` where the
   * payload is a partial update (only changed settings keys are sent).
   */
  onSubmit: (input: CreateProjectInput | UpdateProjectInput) => Promise<unknown>;
  onClose: () => void;
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

function toFormValues(project?: NovelProject | null): FormValues {
  return {
    title: project?.title ?? '',
    description: project?.description ?? '',
    status: project?.status ?? 'planning',
    genre: project?.genre.join(', ') ?? '',
    tags: project?.tags.join(', ') ?? '',
    targetWordCount: project?.targetWordCount !== undefined ? String(project.targetWordCount) : '',
    author: project?.settings.author ?? '',
    language: project?.settings.language ?? '',
  };
}

/**
 * Create / edit project dialog.
 *
 * Validation deliberately reuses `NovelProjectSchema` for the field rules that
 * matter in the UI (title length, list item length, settings shape) and adds
 * only the two checks the schema cannot express as a string control:
 * an empty title and a positive-integer target word count. The Service/Repository
 * still validate the final project — the UI never writes anything the schema
 * would reject.
 *
 * Edit mode only sends CHANGED settings keys, so editing `author` cannot wipe
 * `language` and vice versa.
 */
export function ProjectFormDialog({ open, initialProject, onSubmit, onClose }: ProjectFormDialogProps) {
  const isEdit = Boolean(initialProject);
  const [values, setValues] = useState<FormValues>(() => toFormValues(initialProject));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Guards against a double-click creating two records before React disables
  // the button (state updates are async).
  const submittingRef = useRef(false);

  // Re-seed the form each time the dialog opens, so a previous cancelled edit
  // never leaks into the next one.
  useEffect(() => {
    if (open) {
      setValues(toFormValues(initialProject));
      setErrors({});
      setSubmitError(null);
      setSaving(false);
      submittingRef.current = false;
    }
  }, [open, initialProject]);

  const setField = <K extends keyof FormValues>(key: K, value: FormValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => (prev[key] || prev.form ? { ...prev, [key]: undefined, form: undefined } : prev));
  };

  const validate = (): { ok: boolean; errors: FieldErrors; target?: number; settings: Partial<Record<keyof ProjectSettings, string | undefined>> } => {
    const next: FieldErrors = {};

    const title = values.title.trim();
    if (!title) {
      next.title = 'Title is required.';
    } else if (title.length > 200) {
      next.title = 'Title must be at most 200 characters.';
    }
    if (values.description.length > 5_000) {
      next.description = 'Description must be at most 5000 characters.';
    }

    let target: number | undefined;
    const rawTarget = values.targetWordCount.trim();
    if (rawTarget !== '') {
      const parsed = Number(rawTarget);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        next.targetWordCount = 'Target word count must be a positive whole number.';
      } else {
        target = parsed;
      }
    }

    const settings = buildSettingsPatch(toFormValues(initialProject), values, isEdit);

    // Validate the assembled payload with the real schema so UI rules can
    // never drift from the data model (e.g. genre/tag item length limits).
    const candidate = {
      id: initialProject?.id ?? 'draft',
      title: title || ' ',
      description: values.description,
      status: values.status,
      genre: parseList(values.genre),
      tags: parseList(values.tags),
      settings: stripUndefined(settings),
      createdAt: initialProject?.createdAt ?? 0,
      updatedAt: initialProject?.updatedAt ?? 0,
      ...(target !== undefined ? { targetWordCount: target } : {}),
    };
    const result = NovelProjectSchema.safeParse(candidate);
    if (!result.success) {
      for (const issue of result.error.issues) {
        const path = issue.path[0];
        if (path === 'genre' || path === 'tags') {
          next[path] = 'Each entry must be 1–60 characters.';
        } else if (issue.path.includes('author')) {
          next.author = 'Author must be at most 120 characters.';
        } else if (issue.path.includes('language')) {
          next.language = 'Language must be at most 35 characters.';
        }
      }
    }

    setErrors(next);
    return { ok: Object.keys(next).length === 0, errors: next, target, settings };
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submittingRef.current || saving) return;

    const { ok, target, settings } = validate();
    if (!ok) return;

    submittingRef.current = true;
    setSaving(true);
    setSubmitError(null);

    const title = values.title.trim();
    const genre = parseList(values.genre);
    const tags = parseList(values.tags);

    try {
      if (isEdit && initialProject) {
        const input: UpdateProjectInput = {
          title,
          description: values.description,
          status: values.status,
          genre,
          tags,
          // null clears the field; a value sets it.
          targetWordCount: target !== undefined ? target : null,
          settings,
        };
        await onSubmit(input);
      } else {
        const input: CreateProjectInput = {
          title,
          description: values.description,
          status: values.status,
          genre,
          tags,
          ...(target !== undefined ? { targetWordCount: target } : {}),
          settings: stripUndefined(settings),
        };
        await onSubmit(input);
      }
      onClose();
    } catch (error) {
      // Keep the dialog open and the user's input intact on failure.
      setSubmitError(describeError(error));
    } finally {
      submittingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <ProjectDialog
      open={open}
      title={isEdit ? 'Edit project' : 'New project'}
      description={
        isEdit ? 'Update the project’s details. Changes are saved immediately.' : 'Create a new novel project.'
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
            form="project-form"
            loading={saving}
            iconLeft={!saving ? <Save className="size-3.5" /> : undefined}
          >
            {isEdit ? 'Save changes' : 'Create project'}
          </Button>
        </>
      }
    >
      <form id="project-form" onSubmit={handleSubmit} className="space-y-3.5" noValidate>
        <TextField
          label="Title"
          required
          value={values.title}
          onChange={(event) => setField('title', event.target.value)}
          placeholder="e.g. The Drowned Bell"
          error={errors.title}
          maxLength={200}
          autoFocus
        />

        <TextAreaField
          label="Description"
          value={values.description}
          onChange={(event) => setField('description', event.target.value)}
          placeholder="A short summary of the project."
          error={errors.description}
          rows={3}
        />

        <div className="grid gap-3.5 sm:grid-cols-2">
          <SelectField
            label="Status"
            value={values.status}
            onChange={(event) => setField('status', event.target.value as ProjectStatus)}
          >
            {PROJECT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {PROJECT_STATUS_META[status].label}
              </option>
            ))}
          </SelectField>

          <TextField
            label="Target word count"
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={values.targetWordCount}
            onChange={(event) => setField('targetWordCount', event.target.value)}
            placeholder="e.g. 90000"
            error={errors.targetWordCount}
            hint="Optional. Positive whole numbers only."
          />
        </div>

        <TextField
          label="Genre"
          value={values.genre}
          onChange={(event) => setField('genre', event.target.value)}
          placeholder="Fantasy, Mystery"
          error={errors.genre}
          hint="Comma-separated."
        />

        <TextField
          label="Tags"
          value={values.tags}
          onChange={(event) => setField('tags', event.target.value)}
          placeholder="ocean, gothic, slow-burn"
          error={errors.tags}
          hint="Comma-separated."
        />

        <div className="grid gap-3.5 sm:grid-cols-2">
          <TextField
            label="Author"
            value={values.author}
            onChange={(event) => setField('author', event.target.value)}
            placeholder="Optional"
            error={errors.author}
          />
          <TextField
            label="Language"
            value={values.language}
            onChange={(event) => setField('language', event.target.value)}
            placeholder="e.g. en"
            error={errors.language}
          />
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

/**
 * Builds the settings payload for the Service.
 *
 * Edit mode: sends ONLY the keys that changed against the original project, so
 * an untouched `language` (or `author`) is never overwritten. A cleared value
 * is sent as `undefined`, which the Service interprets as "remove this key".
 *
 * Create mode: sends `{ author?, language? }` with empty values omitted.
 */
function buildSettingsPatch(
  original: FormValues,
  current: FormValues,
  isEdit: boolean,
): Partial<Record<keyof ProjectSettings, string | undefined>> {
  const toValue = (raw: string): string | undefined => {
    const trimmed = raw.trim();
    return trimmed === '' ? undefined : trimmed;
  };

  if (!isEdit) {
    const patch: Partial<Record<keyof ProjectSettings, string | undefined>> = {};
    const author = toValue(current.author);
    const language = toValue(current.language);
    if (author !== undefined) patch.author = author;
    if (language !== undefined) patch.language = language;
    return patch;
  }

  const patch: Partial<Record<keyof ProjectSettings, string | undefined>> = {};
  if (current.author.trim() !== original.author.trim()) {
    patch.author = toValue(current.author);
  }
  if (current.language.trim() !== original.language.trim()) {
    patch.language = toValue(current.language);
  }
  return patch;
}

/** Turns any thrown value into a readable one-line (plus detail) message. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) {
      return `${error.message}: ${cause.message}`;
    }
    return error.message;
  }
  return String(error);
}

/** Drops `undefined` settings keys so create mode never stores empty values. */
function stripUndefined(
  patch: Partial<Record<keyof ProjectSettings, string | undefined>>,
): ProjectSettings {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) out[key] = value;
  }
  return out as ProjectSettings;
}
