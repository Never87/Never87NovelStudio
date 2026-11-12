import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { RefreshCw, Save } from 'lucide-react';
import { Button } from '@/components/ui';
import type { Character, Scene, ScenePurpose, SceneStatus } from '@/types';
import { SceneSchema } from '@/schemas/scene';
import type { CreateSceneInput, UpdateSceneInput } from '@/services';
import { ProjectDialog } from '@/modules/projects/components/ProjectDialog';
import { SelectField, TextAreaField, TextField } from '@/modules/projects/components/FormFields';
import { describeError } from '@/modules/projects/components/ProjectFormDialog';
import { SCENE_PURPOSES, SCENE_PURPOSE_META, SCENE_STATUSES, SCENE_STATUS_META } from '../outline-meta';

interface FormValues {
  title: string;
  summary: string;
  location: string;
  timeOfDay: string;
  povCharacterId: string;
  characterIds: string[];
  goal: string;
  conflict: string;
  turningPoint: string;
  outcome: string;
  purpose: ScenePurpose;
  status: SceneStatus;
  targetWords: string;
  tags: string;
}

type FieldErrors = Partial<Record<keyof FormValues | 'form', string>>;

export interface SceneFormDialogProps {
  open: boolean;
  initialScene?: Scene | null;
  characters: Character[];
  onSubmit: (input: CreateSceneInput | UpdateSceneInput) => Promise<unknown>;
  onClose: () => void;
}

function toFormValues(scene?: Scene | null): FormValues {
  return {
    title: scene?.title ?? '',
    summary: scene?.summary ?? '',
    location: scene?.location ?? '',
    timeOfDay: scene?.timeOfDay ?? '',
    povCharacterId: scene?.povCharacterId ?? '',
    characterIds: scene?.characterIds ?? [],
    goal: scene?.goal ?? '',
    conflict: scene?.conflict ?? '',
    turningPoint: scene?.turningPoint ?? '',
    outcome: scene?.outcome ?? '',
    purpose: scene?.purpose ?? 'setup',
    status: scene?.status ?? 'planned',
    targetWords: typeof scene?.targetWords === 'number' ? String(scene.targetWords) : '',
    tags: scene?.tags.join(', ') ?? '',
  };
}

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
 * Create / edit scene dialog.
 *
 * Scene design follows goal → conflict → turning point → outcome, which keeps
 * every scene purposeful instead of a summary of events.
 */
export function SceneFormDialog({
  open,
  initialScene,
  characters,
  onSubmit,
  onClose,
}: SceneFormDialogProps) {
  const isEdit = Boolean(initialScene);
  const [values, setValues] = useState<FormValues>(() => toFormValues(initialScene));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const submittingRef = useRef(false);

  useEffect(() => {
    if (open) {
      setValues(toFormValues(initialScene));
      setErrors({});
      setSubmitError(null);
      setSaving(false);
      submittingRef.current = false;
    }
  }, [open, initialScene]);

  const setField = <K extends keyof FormValues>(key: K, value: FormValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => (prev[key] || prev.form ? { ...prev, [key]: undefined, form: undefined } : prev));
  };

  const toggleCharacter = (id: string) => {
    setValues((prev) => ({
      ...prev,
      characterIds: prev.characterIds.includes(id)
        ? prev.characterIds.filter((existing) => existing !== id)
        : [...prev.characterIds, id],
    }));
  };

  const validate = (): boolean => {
    const next: FieldErrors = {};
    const target = values.targetWords.trim() === '' ? undefined : Number(values.targetWords);
    if (target !== undefined && (!Number.isInteger(target) || target < 0)) {
      next.targetWords = 'Target words must be a whole number, 0 or more.';
    }

    const result = SceneSchema.safeParse({
      id: initialScene?.id ?? 'draft',
      chapterId: initialScene?.chapterId ?? 'draft',
      projectId: initialScene?.projectId ?? 'draft',
      title: values.title.trim() || ' ',
      order: initialScene?.order ?? 0,
      summary: values.summary,
      location: values.location,
      timeOfDay: values.timeOfDay,
      characterIds: values.characterIds,
      goal: values.goal,
      conflict: values.conflict,
      turningPoint: values.turningPoint,
      outcome: values.outcome,
      purpose: values.purpose,
      status: values.status,
      tags: parseList(values.tags),
      createdAt: initialScene?.createdAt ?? 0,
      updatedAt: initialScene?.updatedAt ?? 0,
      ...(values.povCharacterId ? { povCharacterId: values.povCharacterId } : {}),
      ...(target !== undefined ? { targetWords: target } : {}),
    });
    if (!result.success) {
      for (const issue of result.error.issues) {
        const [head] = issue.path;
        if (head === 'title') next.title = issue.message;
        else if (head === 'summary') next.summary = issue.message;
        else if (head === 'location') next.location = issue.message;
        else if (head === 'timeOfDay') next.timeOfDay = issue.message;
        else if (head === 'goal') next.goal = issue.message;
        else if (head === 'conflict') next.conflict = issue.message;
        else if (head === 'turningPoint') next.turningPoint = issue.message;
        else if (head === 'outcome') next.outcome = issue.message;
        else if (head === 'tags') next.tags = 'Each tag must be 1–80 characters.';
        else if (head === 'targetWords') next.targetWords = issue.message;
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

    const targetWords =
      values.targetWords.trim() === '' ? null : Number(values.targetWords);

    const payload = {
      title: values.title.trim(),
      summary: values.summary,
      location: values.location,
      timeOfDay: values.timeOfDay,
      characterIds: values.characterIds,
      goal: values.goal,
      conflict: values.conflict,
      turningPoint: values.turningPoint,
      outcome: values.outcome,
      purpose: values.purpose,
      status: values.status,
      tags: parseList(values.tags),
    };

    try {
      if (isEdit) {
        await onSubmit({
          ...payload,
          povCharacterId: values.povCharacterId === '' ? null : values.povCharacterId,
          targetWords,
        } satisfies UpdateSceneInput);
      } else {
        await onSubmit({
          ...payload,
          ...(values.povCharacterId ? { povCharacterId: values.povCharacterId } : {}),
          targetWords,
        } satisfies CreateSceneInput);
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
      title={isEdit ? 'Edit scene' : 'New scene'}
      description={
        isEdit ? 'Update this scene’s design.' : 'Design a scene: goal, conflict, turn, outcome.'
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
            form="scene-form"
            loading={saving}
            iconLeft={!saving ? <Save className="size-3.5" /> : undefined}
          >
            {isEdit ? 'Save changes' : 'Create scene'}
          </Button>
        </>
      }
    >
      <form id="scene-form" onSubmit={handleSubmit} className="space-y-3.5" noValidate>
        <TextField
          label="Title"
          required
          value={values.title}
          onChange={(event) => setField('title', event.target.value)}
          placeholder="e.g. The letter arrives"
          error={errors.title}
          maxLength={200}
          autoFocus
        />

        <TextField
          label="Summary"
          value={values.summary}
          onChange={(event) => setField('summary', event.target.value)}
          placeholder="One line shown in the scene list."
          error={errors.summary}
          maxLength={1000}
        />

        <div className="grid gap-3.5 sm:grid-cols-2">
          <TextField
            label="Location"
            value={values.location}
            onChange={(event) => setField('location', event.target.value)}
            placeholder="The lighthouse"
            error={errors.location}
            maxLength={200}
          />
          <TextField
            label="Time"
            value={values.timeOfDay}
            onChange={(event) => setField('timeOfDay', event.target.value)}
            placeholder="Night, day 3"
            error={errors.timeOfDay}
            maxLength={120}
          />
        </div>

        <TextAreaField
          label="Goal"
          value={values.goal}
          onChange={(event) => setField('goal', event.target.value)}
          placeholder="What the POV wants here."
          error={errors.goal}
          rows={2}
        />
        <TextAreaField
          label="Conflict"
          value={values.conflict}
          onChange={(event) => setField('conflict', event.target.value)}
          placeholder="What opposes it."
          error={errors.conflict}
          rows={2}
        />
        <TextAreaField
          label="Turning point"
          value={values.turningPoint}
          onChange={(event) => setField('turningPoint', event.target.value)}
          placeholder="The shift that happens."
          error={errors.turningPoint}
          rows={2}
        />
        <TextAreaField
          label="Outcome"
          value={values.outcome}
          onChange={(event) => setField('outcome', event.target.value)}
          placeholder="Where it leaves things."
          error={errors.outcome}
          rows={2}
        />

        <div className="grid gap-3.5 sm:grid-cols-2">
          <SelectField
            label="Purpose"
            value={values.purpose}
            onChange={(event) => setField('purpose', event.target.value as ScenePurpose)}
          >
            {SCENE_PURPOSES.map((purpose) => (
              <option key={purpose} value={purpose}>
                {SCENE_PURPOSE_META[purpose].label}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Status"
            value={values.status}
            onChange={(event) => setField('status', event.target.value as SceneStatus)}
          >
            {SCENE_STATUSES.map((status) => (
              <option key={status} value={status}>
                {SCENE_STATUS_META[status].label}
              </option>
            ))}
          </SelectField>
        </div>

        <div className="grid gap-3.5 sm:grid-cols-2">
          <TextField
            label="Target words"
            type="number"
            min={0}
            value={values.targetWords}
            onChange={(event) => setField('targetWords', event.target.value)}
            placeholder="1200"
            error={errors.targetWords}
          />
          <TextField
            label="Tags"
            value={values.tags}
            onChange={(event) => setField('tags', event.target.value)}
            placeholder="quiet, foreshadow"
            error={errors.tags}
            hint="Comma-separated."
          />
        </div>

        {characters.length > 0 ? (
          <div className="grid gap-3.5 sm:grid-cols-2">
            <SelectField
              label="POV character"
              value={values.povCharacterId}
              onChange={(event) => setField('povCharacterId', event.target.value)}
            >
              <option value="">None</option>
              {characters.map((character) => (
                <option key={character.id} value={character.id}>
                  {character.name}
                </option>
              ))}
            </SelectField>
            <fieldset className="border-line rounded-md border p-2.5">
              <legend className="text-ink px-1 text-xs font-medium">Present characters</legend>
              <div className="mt-1 flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
                {characters.map((character) => {
                  const checked = values.characterIds.includes(character.id);
                  return (
                    <label
                      key={character.id}
                      className={
                        checked
                          ? 'bg-accent-soft text-accent-soft-text border-accent-ring flex cursor-pointer items-center gap-1 rounded border px-1.5 py-0.5 text-2xs'
                          : 'bg-surface text-muted border-line flex cursor-pointer items-center gap-1 rounded border px-1.5 py-0.5 text-2xs'
                      }
                    >
                      <input
                        type="checkbox"
                        className="size-3"
                        checked={checked}
                        onChange={() => toggleCharacter(character.id)}
                      />
                      {character.name}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          </div>
        ) : null}

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
