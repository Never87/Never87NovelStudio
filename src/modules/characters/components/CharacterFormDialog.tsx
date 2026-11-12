import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { RefreshCw, Save } from 'lucide-react';
import { Button } from '@/components/ui';
import type { Character, CharacterRole, CharacterStatus } from '@/types';
import { CharacterSchema } from '@/schemas/character';
import type { CreateCharacterInput, UpdateCharacterInput } from '@/services';
import { ProjectDialog } from '@/modules/projects/components/ProjectDialog';
import { SelectField, TextAreaField, TextField } from '@/modules/projects/components/FormFields';
import { describeError } from '@/modules/projects/components/ProjectFormDialog';
import {
  CHARACTER_ROLE_META,
  CHARACTER_ROLES,
  CHARACTER_STATUS_META,
  CHARACTER_STATUSES,
} from '../character-meta';

interface FormValues {
  name: string;
  summary: string;
  role: CharacterRole;
  status: CharacterStatus;
  personality: string;
  background: string;
  motivation: string;
  appearance: string;
  tags: string;
}

type FieldErrors = Partial<Record<keyof FormValues | 'form', string>>;

export interface CharacterFormDialogProps {
  open: boolean;
  /** When provided the dialog edits this character; otherwise it creates one. */
  initialCharacter?: Character | null;
  onSubmit: (input: CreateCharacterInput | UpdateCharacterInput) => Promise<unknown>;
  onClose: () => void;
}

function toFormValues(character?: Character | null): FormValues {
  return {
    name: character?.name ?? '',
    summary: character?.summary ?? '',
    role: character?.role ?? 'supporting',
    status: character?.status ?? 'active',
    personality: character?.personality ?? '',
    background: character?.background ?? '',
    motivation: character?.motivation ?? '',
    appearance: character?.appearance ?? '',
    tags: character?.tags.join(', ') ?? '',
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
 * Create / edit character dialog.
 *
 * Same validation philosophy as the project and world dialogs: the assembled
 * payload is validated with the real `CharacterSchema`, so UI rules cannot
 * drift from the data model.
 */
export function CharacterFormDialog({
  open,
  initialCharacter,
  onSubmit,
  onClose,
}: CharacterFormDialogProps) {
  const isEdit = Boolean(initialCharacter);
  const [values, setValues] = useState<FormValues>(() => toFormValues(initialCharacter));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const submittingRef = useRef(false);

  useEffect(() => {
    if (open) {
      setValues(toFormValues(initialCharacter));
      setErrors({});
      setSubmitError(null);
      setSaving(false);
      submittingRef.current = false;
    }
  }, [open, initialCharacter]);

  const setField = <K extends keyof FormValues>(key: K, value: FormValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => (prev[key] || prev.form ? { ...prev, [key]: undefined, form: undefined } : prev));
  };

  const validate = (): boolean => {
    const next: FieldErrors = {};

    const name = values.name.trim();
    if (!name) next.name = 'Name is required.';
    else if (name.length > 120) next.name = 'Name must be at most 120 characters.';
    if (values.summary.length > 500) next.summary = 'Summary must be at most 500 characters.';

    const candidate = {
      id: initialCharacter?.id ?? 'draft',
      projectId: initialCharacter?.projectId ?? 'draft',
      name: name || ' ',
      summary: values.summary,
      background: values.background,
      personality: values.personality,
      motivation: values.motivation,
      appearance: values.appearance,
      role: values.role,
      status: values.status,
      tags: parseList(values.tags),
      createdAt: initialCharacter?.createdAt ?? 0,
      updatedAt: initialCharacter?.updatedAt ?? 0,
    };
    const result = CharacterSchema.safeParse(candidate);
    if (!result.success) {
      for (const issue of result.error.issues) {
        const [head] = issue.path;
        if (head === 'tags') next.tags = 'Each tag must be 1–80 characters.';
        else if (head === 'name') next.name = issue.message;
        else if (head === 'summary') next.summary = issue.message;
        else if (head === 'background') next.background = issue.message;
        else if (head === 'personality') next.personality = issue.message;
        else if (head === 'motivation') next.motivation = issue.message;
        else if (head === 'appearance') next.appearance = issue.message;
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

    const payload = {
      name: values.name.trim(),
      summary: values.summary,
      personality: values.personality,
      background: values.background,
      motivation: values.motivation,
      appearance: values.appearance,
      role: values.role,
      status: values.status,
      tags: parseList(values.tags),
    };

    try {
      if (isEdit && initialCharacter) {
        const input: UpdateCharacterInput = payload;
        await onSubmit(input);
      } else {
        const input: CreateCharacterInput = payload;
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
      title={isEdit ? 'Edit character' : 'New character'}
      description={
        isEdit ? 'Update this character’s profile.' : 'Add a character to this project’s cast.'
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
            form="character-form"
            loading={saving}
            iconLeft={!saving ? <Save className="size-3.5" /> : undefined}
          >
            {isEdit ? 'Save changes' : 'Create character'}
          </Button>
        </>
      }
    >
      <form id="character-form" onSubmit={handleSubmit} className="space-y-3.5" noValidate>
        <TextField
          label="Name"
          required
          value={values.name}
          onChange={(event) => setField('name', event.target.value)}
          placeholder="e.g. Maren Valk"
          error={errors.name}
          maxLength={120}
          autoFocus
        />

        <TextField
          label="Summary"
          value={values.summary}
          onChange={(event) => setField('summary', event.target.value)}
          placeholder="One-line description shown in lists."
          error={errors.summary}
          maxLength={500}
        />

        <div className="grid gap-3.5 sm:grid-cols-2">
          <SelectField
            label="Role"
            value={values.role}
            onChange={(event) => setField('role', event.target.value as CharacterRole)}
          >
            {CHARACTER_ROLES.map((role) => (
              <option key={role} value={role}>
                {CHARACTER_ROLE_META[role].label}
              </option>
            ))}
          </SelectField>

          <SelectField
            label="Status"
            value={values.status}
            onChange={(event) => setField('status', event.target.value as CharacterStatus)}
          >
            {CHARACTER_STATUSES.map((status) => (
              <option key={status} value={status}>
                {CHARACTER_STATUS_META[status].label}
              </option>
            ))}
          </SelectField>
        </div>

        <TextAreaField
          label="Personality"
          value={values.personality}
          onChange={(event) => setField('personality', event.target.value)}
          placeholder="Temperament, habits, quirks."
          error={errors.personality}
          rows={3}
        />

        <TextAreaField
          label="Background"
          value={values.background}
          onChange={(event) => setField('background', event.target.value)}
          placeholder="History and formative events."
          error={errors.background}
          rows={3}
        />

        <TextAreaField
          label="Motivation"
          value={values.motivation}
          onChange={(event) => setField('motivation', event.target.value)}
          placeholder="What they want, and why."
          error={errors.motivation}
          rows={2}
        />

        <TextAreaField
          label="Appearance"
          value={values.appearance}
          onChange={(event) => setField('appearance', event.target.value)}
          placeholder="Physical description."
          error={errors.appearance}
          rows={2}
        />

        <TextField
          label="Tags"
          value={values.tags}
          onChange={(event) => setField('tags', event.target.value)}
          placeholder="mentor, sea-folk"
          error={errors.tags}
          hint="Comma-separated."
        />

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
