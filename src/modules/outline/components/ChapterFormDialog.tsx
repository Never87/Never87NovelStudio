import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link2, RefreshCw, Save } from 'lucide-react';
import { Badge, Button } from '@/components/ui';
import type { Chapter, ChapterStatus, Character, PlotBeat } from '@/types';
import { ChapterSchema } from '@/schemas/outline';
import type { CreateChapterInput, UpdateChapterInput } from '@/services';
import { ProjectDialog } from '@/modules/projects/components/ProjectDialog';
import { SelectField, TextAreaField, TextField } from '@/modules/projects/components/FormFields';
import { describeError } from '@/modules/projects/components/ProjectFormDialog';
import { CHAPTER_STATUSES, CHAPTER_STATUS_META } from '../outline-meta';

interface FormValues {
  title: string;
  summary: string;
  goal: string;
  keyEvents: string;
  endingHook: string;
  status: ChapterStatus;
  plotBeatId: string;
  characterIds: string[];
  tags: string;
}

type FieldErrors = Partial<Record<keyof FormValues | 'form', string>>;

export interface ChapterFormDialogProps {
  open: boolean;
  initialChapter?: Chapter | null;
  /** Beats from the project's narrative plan (the ONLY valid link targets). */
  beats: PlotBeat[];
  /** The project's cast, for the character multi-select. */
  characters: Character[];
  onSubmit: (input: CreateChapterInput | UpdateChapterInput) => Promise<unknown>;
  onClose: () => void;
}

function toFormValues(chapter?: Chapter | null): FormValues {
  return {
    title: chapter?.title ?? '',
    summary: chapter?.summary ?? '',
    goal: chapter?.goal ?? '',
    keyEvents: chapter?.keyEvents ?? '',
    endingHook: chapter?.endingHook ?? '',
    status: chapter?.status ?? 'planned',
    plotBeatId: chapter?.plotBeatId ?? '',
    characterIds: chapter?.characterIds ?? [],
    tags: chapter?.tags.join(', ') ?? '',
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
 * Create / edit chapter dialog.
 *
 * The plot-beat picker lists ONLY this project's narrative beats, and its
 * options are labelled with the beat's OWN title — the beat text is never
 * copied into the chapter, so narrative info is maintained in one place.
 */
export function ChapterFormDialog({
  open,
  initialChapter,
  beats,
  characters,
  onSubmit,
  onClose,
}: ChapterFormDialogProps) {
  const isEdit = Boolean(initialChapter);
  const [values, setValues] = useState<FormValues>(() => toFormValues(initialChapter));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const submittingRef = useRef(false);

  useEffect(() => {
    if (open) {
      setValues(toFormValues(initialChapter));
      setErrors({});
      setSubmitError(null);
      setSaving(false);
      submittingRef.current = false;
    }
  }, [open, initialChapter]);

  const selectedBeat = useMemo(
    () => beats.find((beat) => beat.id === values.plotBeatId) ?? null,
    [beats, values.plotBeatId],
  );

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
    const result = ChapterSchema.safeParse({
      id: initialChapter?.id ?? 'draft',
      volumeId: initialChapter?.volumeId ?? 'draft',
      projectId: initialChapter?.projectId ?? 'draft',
      title: values.title.trim() || ' ',
      order: initialChapter?.order ?? 0,
      summary: values.summary,
      goal: values.goal,
      keyEvents: values.keyEvents,
      endingHook: values.endingHook,
      status: values.status,
      characterIds: values.characterIds,
      tags: parseList(values.tags),
      createdAt: initialChapter?.createdAt ?? 0,
      updatedAt: initialChapter?.updatedAt ?? 0,
      ...(values.plotBeatId ? { plotBeatId: values.plotBeatId } : {}),
    });
    if (!result.success) {
      for (const issue of result.error.issues) {
        const [head] = issue.path;
        if (head === 'title') next.title = issue.message;
        else if (head === 'summary') next.summary = issue.message;
        else if (head === 'goal') next.goal = issue.message;
        else if (head === 'keyEvents') next.keyEvents = issue.message;
        else if (head === 'endingHook') next.endingHook = issue.message;
        else if (head === 'tags') next.tags = 'Each tag must be 1–80 characters.';
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
      title: values.title.trim(),
      summary: values.summary,
      goal: values.goal,
      keyEvents: values.keyEvents,
      endingHook: values.endingHook,
      status: values.status,
      characterIds: values.characterIds,
      tags: parseList(values.tags),
    };

    try {
      if (isEdit) {
        // `null` clears the link; a value sets it.
        const input: UpdateChapterInput = {
          ...payload,
          plotBeatId: values.plotBeatId === '' ? null : values.plotBeatId,
        };
        await onSubmit(input);
      } else {
        const input: CreateChapterInput = {
          ...payload,
          ...(values.plotBeatId ? { plotBeatId: values.plotBeatId } : {}),
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
      title={isEdit ? 'Edit chapter' : 'New chapter'}
      description={
        isEdit ? 'Update this chapter’s plan.' : 'Plan what this chapter must accomplish.'
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
            form="chapter-form"
            loading={saving}
            iconLeft={!saving ? <Save className="size-3.5" /> : undefined}
          >
            {isEdit ? 'Save changes' : 'Create chapter'}
          </Button>
        </>
      }
    >
      <form id="chapter-form" onSubmit={handleSubmit} className="space-y-3.5" noValidate>
        <TextField
          label="Title"
          required
          value={values.title}
          onChange={(event) => setField('title', event.target.value)}
          placeholder="e.g. The Lighthouse"
          error={errors.title}
          maxLength={200}
          autoFocus
        />

        <TextField
          label="Summary"
          value={values.summary}
          onChange={(event) => setField('summary', event.target.value)}
          placeholder="One line shown in the outline."
          error={errors.summary}
          maxLength={1000}
        />

        <div className="border-line space-y-2 rounded-md border p-2.5">
          <label className="text-ink flex items-center gap-1.5 text-xs font-medium">
            <Link2 className="size-3.5" aria-hidden />
            Plot beat
          </label>
          {beats.length === 0 ? (
            <p className="text-subtle text-2xs">
              This project has no narrative beats yet. Create a narrative plan and add beats to link
              chapters to story structure.
            </p>
          ) : (
            <>
              <SelectField
                label="Linked beat"
                value={values.plotBeatId}
                onChange={(event) => setField('plotBeatId', event.target.value)}
              >
                <option value="">Not linked</option>
                {beats.map((beat) => (
                  <option key={beat.id} value={beat.id}>
                    {beat.position}% · {beat.title}
                  </option>
                ))}
              </SelectField>
              {selectedBeat ? (
                <div className="bg-surface-muted/60 rounded p-2">
                  <div className="flex items-center gap-1.5">
                    <Badge tone="accent" size="sm">
                      {selectedBeat.position}%
                    </Badge>
                    <span className="text-ink truncate text-xs font-medium">{selectedBeat.title}</span>
                  </div>
                  {selectedBeat.description.trim() ? (
                    <p className="text-muted mt-1 line-clamp-3 text-2xs whitespace-pre-line">
                      {selectedBeat.description}
                    </p>
                  ) : null}
                  <p className="text-subtle mt-1 text-2xs italic">
                    Beat details live in the Narrative tab — edit them there.
                  </p>
                </div>
              ) : null}
            </>
          )}
        </div>

        <TextAreaField
          label="Goal"
          value={values.goal}
          onChange={(event) => setField('goal', event.target.value)}
          placeholder="What must this chapter accomplish?"
          error={errors.goal}
          rows={2}
        />

        <TextAreaField
          label="Key events"
          value={values.keyEvents}
          onChange={(event) => setField('keyEvents', event.target.value)}
          placeholder="What happens, beat by beat."
          error={errors.keyEvents}
          rows={3}
        />

        <TextAreaField
          label="Ending hook"
          value={values.endingHook}
          onChange={(event) => setField('endingHook', event.target.value)}
          placeholder="What pulls the reader onward."
          error={errors.endingHook}
          rows={2}
        />

        <div className="grid gap-3.5 sm:grid-cols-2">
          <SelectField
            label="Status"
            value={values.status}
            onChange={(event) => setField('status', event.target.value as ChapterStatus)}
          >
            {CHAPTER_STATUSES.map((status) => (
              <option key={status} value={status}>
                {CHAPTER_STATUS_META[status].label}
              </option>
            ))}
          </SelectField>
          <TextField
            label="Tags"
            value={values.tags}
            onChange={(event) => setField('tags', event.target.value)}
            placeholder="pov-maren, quiet"
            error={errors.tags}
            hint="Comma-separated."
          />
        </div>

        {characters.length > 0 ? (
          <fieldset className="border-line rounded-md border p-2.5">
            <legend className="text-ink px-1 text-xs font-medium">Characters</legend>
            <div className="mt-1 flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
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
