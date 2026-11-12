import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowDown, ArrowUp, Plus, RefreshCw, Save, Trash2, Wand2 } from 'lucide-react';
import { Button, IconButton } from '@/components/ui';
import type { NarrativePlan, NarrativeStatus, NarrativeStructure } from '@/types';
import type { CreateNarrativeInput, PlotBeatInput, UpdateNarrativeInput } from '@/services';
import { createPlotBeatId } from '@/utils/id';
import { ProjectDialog } from '@/modules/projects/components/ProjectDialog';
import { SelectField, TextAreaField, TextField } from '@/modules/projects/components/FormFields';
import { describeError } from '@/modules/projects/components/ProjectFormDialog';
import {
  NARRATIVE_STATUS_META,
  NARRATIVE_STATUSES,
  NARRATIVE_STRUCTURE_META,
  NARRATIVE_STRUCTURES,
  STRUCTURE_BEAT_PRESETS,
  presetBeatPositions,
} from '../narrative-meta';

/** A beat being edited, with a stable key for React. */
interface BeatDraft {
  key: string;
  id: string;
  title: string;
  description: string;
  position: string;
}

interface FormValues {
  logline: string;
  theme: string;
  premise: string;
  centralConflict: string;
  stakes: string;
  ending: string;
  structure: NarrativeStructure;
  status: NarrativeStatus;
  motifs: string;
  beats: BeatDraft[];
}

type FieldKey = keyof FormValues;
type FieldErrors = Partial<Record<FieldKey | 'form', string>>;

export interface NarrativeFormDialogProps {
  open: boolean;
  /** When provided the dialog edits this plan; otherwise it creates one. */
  initialPlan?: NarrativePlan | null;
  onSubmit: (input: CreateNarrativeInput | UpdateNarrativeInput) => Promise<unknown>;
  onClose: () => void;
}

function newBeat(title = '', position = 50): BeatDraft {
  const id = createPlotBeatId();
  return { key: id, id, title, description: '', position: String(position) };
}

function toFormValues(plan?: NarrativePlan | null): FormValues {
  return {
    logline: plan?.logline ?? '',
    theme: plan?.theme ?? '',
    premise: plan?.premise ?? '',
    centralConflict: plan?.centralConflict ?? '',
    stakes: plan?.stakes ?? '',
    ending: plan?.ending ?? '',
    structure: plan?.structure ?? 'three-act',
    status: plan?.status ?? 'draft',
    motifs: plan?.motifs.join(', ') ?? '',
    beats:
      plan && plan.beats.length > 0
        ? plan.beats.map((beat) => ({
            key: beat.id,
            id: beat.id,
            title: beat.title,
            description: beat.description,
            position: String(beat.position),
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
 * Create / edit narrative-plan dialog.
 *
 * Beats are editable as an ordered list with move up/down actions. Blank beat
 * rows are dropped on submit. A structure preset can fill in starter beats.
 */
export function NarrativeFormDialog({
  open,
  initialPlan,
  onSubmit,
  onClose,
}: NarrativeFormDialogProps) {
  const isEdit = Boolean(initialPlan);
  const [values, setValues] = useState<FormValues>(() => toFormValues(initialPlan));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const submittingRef = useRef(false);

  useEffect(() => {
    if (open) {
      setValues(toFormValues(initialPlan));
      setErrors({});
      setSubmitError(null);
      setSaving(false);
      submittingRef.current = false;
    }
  }, [open, initialPlan]);

  const setField = <K extends FieldKey>(key: K, value: FormValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => (prev[key] || prev.form ? { ...prev, [key]: undefined, form: undefined } : prev));
  };

  const updateBeat = (key: string, patch: Partial<Pick<BeatDraft, 'title' | 'description' | 'position'>>) => {
    setValues((prev) => ({
      ...prev,
      beats: prev.beats.map((beat) => (beat.key === key ? { ...beat, ...patch } : beat)),
    }));
    setErrors((prev) => (prev.beats ? { ...prev, beats: undefined } : prev));
  };

  const addBeat = () => {
    setValues((prev) => ({
      ...prev,
      beats: [...prev.beats, newBeat('', prev.beats.length > 0 ? 100 : 50)],
    }));
  };

  const removeBeat = (key: string) => {
    setValues((prev) => ({ ...prev, beats: prev.beats.filter((beat) => beat.key !== key) }));
  };

  const moveBeat = (key: string, direction: -1 | 1) => {
    setValues((prev) => {
      const index = prev.beats.findIndex((beat) => beat.key === key);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= prev.beats.length) return prev;
      const beats = [...prev.beats];
      const [moved] = beats.splice(index, 1);
      beats.splice(target, 0, moved);
      return { ...prev, beats };
    });
  };

  /** Applies the structure's starter beats (only when no beats exist yet). */
  const applyStructurePreset = () => {
    const titles = STRUCTURE_BEAT_PRESETS[values.structure] ?? [];
    if (titles.length === 0) return;
    const positions = presetBeatPositions(titles.length);
    setValues((prev) => ({
      ...prev,
      beats: titles.map((title, index) => {
        const id = createPlotBeatId();
        return { key: id, id, title, description: '', position: String(positions[index]) };
      }),
    }));
  };

  const keptBeats = (): BeatDraft[] => values.beats.filter((beat) => beat.title.trim() !== '');

  /** Builds the beat payload from the current (non-blank) rows. */
  const buildBeats = (): PlotBeatInput[] =>
    keptBeats().map((beat) => {
      const parsed = Number(beat.position);
      return {
        id: beat.id,
        title: beat.title.trim(),
        description: beat.description,
        position: Number.isFinite(parsed) ? parsed : 0,
      };
    });

  const validate = (): boolean => {
    const next: FieldErrors = {};
    if (values.logline.length > 200) next.logline = 'Logline must be at most 200 characters.';
    for (const beat of keptBeats()) {
      if (beat.title.trim().length > 120) {
        next.beats = 'Beat titles must be at most 120 characters.';
        break;
      }
      const position = Number(beat.position);
      if (!Number.isFinite(position) || position < 0 || position > 100) {
        next.beats = 'Beat positions must be between 0 and 100.';
        break;
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

    const common = {
      logline: values.logline,
      theme: values.theme,
      premise: values.premise,
      centralConflict: values.centralConflict,
      stakes: values.stakes,
      ending: values.ending,
      structure: values.structure,
      status: values.status,
      beats: buildBeats(),
      motifs: parseList(values.motifs),
    };

    try {
      if (isEdit) {
        await onSubmit(common satisfies UpdateNarrativeInput);
      } else {
        await onSubmit(common satisfies CreateNarrativeInput);
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
      title={isEdit ? 'Edit narrative plan' : 'New narrative plan'}
      description={
        isEdit ? 'Refine the story you intend to tell.' : 'Capture premise, structure and beats before drafting.'
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
            form="narrative-form"
            loading={saving}
            iconLeft={!saving ? <Save className="size-3.5" /> : undefined}
          >
            {isEdit ? 'Save changes' : 'Create plan'}
          </Button>
        </>
      }
    >
      <form id="narrative-form" onSubmit={handleSubmit} className="space-y-3.5" noValidate>
        <TextField
          label="Logline"
          value={values.logline}
          onChange={(event) => setField('logline', event.target.value)}
          placeholder="One sentence: who wants what, and what stands in the way."
          error={errors.logline}
          maxLength={200}
          autoFocus
        />

        <div className="grid gap-3.5 sm:grid-cols-2">
          <SelectField
            label="Structure"
            value={values.structure}
            onChange={(event) => setField('structure', event.target.value as NarrativeStructure)}
          >
            {NARRATIVE_STRUCTURES.map((structure) => (
              <option key={structure} value={structure}>
                {NARRATIVE_STRUCTURE_META[structure].label}
              </option>
            ))}
          </SelectField>

          <SelectField
            label="Status"
            value={values.status}
            onChange={(event) => setField('status', event.target.value as NarrativeStatus)}
          >
            {NARRATIVE_STATUSES.map((status) => (
              <option key={status} value={status}>
                {NARRATIVE_STATUS_META[status].label}
              </option>
            ))}
          </SelectField>
        </div>

        <TextAreaField
          label="Premise"
          value={values.premise}
          onChange={(event) => setField('premise', event.target.value)}
          placeholder="The core situation, before conflict."
          error={errors.premise}
          rows={2}
        />

        <TextAreaField
          label="Theme"
          value={values.theme}
          onChange={(event) => setField('theme', event.target.value)}
          placeholder="The central question the story asks."
          error={errors.theme}
          rows={2}
        />

        <TextAreaField
          label="Central conflict"
          value={values.centralConflict}
          onChange={(event) => setField('centralConflict', event.target.value)}
          placeholder="What stands in the protagonist's way."
          error={errors.centralConflict}
          rows={2}
        />

        <div className="grid gap-3.5 sm:grid-cols-2">
          <TextAreaField
            label="Stakes"
            value={values.stakes}
            onChange={(event) => setField('stakes', event.target.value)}
            placeholder="What happens if they fail."
            error={errors.stakes}
            rows={2}
          />
          <TextAreaField
            label="Ending"
            value={values.ending}
            onChange={(event) => setField('ending', event.target.value)}
            placeholder="The intended resolution."
            error={errors.ending}
            rows={2}
          />
        </div>

        <TextField
          label="Motifs"
          value={values.motifs}
          onChange={(event) => setField('motifs', event.target.value)}
          placeholder="tides, lighthouses, letters never sent"
          error={errors.motifs}
          hint="Comma-separated."
        />

        <div className="border-line space-y-2 border-t pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-ink text-xs font-medium">Plot beats</p>
              <p className="text-subtle text-2xs">Ordered moments from opening to resolution.</p>
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                type="button"
                iconLeft={<Wand2 className="size-3.5" />}
                onClick={applyStructurePreset}
                title="Replace beats with this structure's preset"
              >
                Use preset
              </Button>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                iconLeft={<Plus className="size-3.5" />}
                onClick={addBeat}
              >
                Add beat
              </Button>
            </div>
          </div>

          {errors.beats ? (
            <p className="text-danger text-2xs" role="alert">
              {errors.beats}
            </p>
          ) : null}

          {values.beats.length === 0 ? (
            <p className="text-subtle text-2xs italic">No beats yet. Add one, or use a structure preset.</p>
          ) : (
            <ul className="space-y-2">
              {values.beats.map((beat, index) => (
                <li key={beat.key} className="bg-surface-muted/40 border-line rounded-md border p-2.5">
                  <div className="flex items-end gap-2">
                    <TextField
                      label={`Beat ${index + 1}`}
                      value={beat.title}
                      onChange={(event) => updateBeat(beat.key, { title: event.target.value })}
                      placeholder="Beat title"
                      maxLength={120}
                      className="min-w-0 flex-1"
                      aria-label={`Beat ${index + 1} title`}
                    />
                    <TextField
                      label="Pos %"
                      type="number"
                      min={0}
                      max={100}
                      value={beat.position}
                      onChange={(event) => updateBeat(beat.key, { position: event.target.value })}
                      className="w-20 shrink-0"
                      aria-label={`Beat ${index + 1} position`}
                    />
                    <div className="flex shrink-0 items-center">
                      <IconButton
                        variant="ghost"
                        size="sm"
                        label={`Move beat ${index + 1} up`}
                        icon={<ArrowUp className="size-3.5" aria-hidden />}
                        onClick={() => moveBeat(beat.key, -1)}
                        disabled={index === 0}
                      />
                      <IconButton
                        variant="ghost"
                        size="sm"
                        label={`Move beat ${index + 1} down`}
                        icon={<ArrowDown className="size-3.5" aria-hidden />}
                        onClick={() => moveBeat(beat.key, 1)}
                        disabled={index === values.beats.length - 1}
                      />
                      <IconButton
                        variant="ghost"
                        size="sm"
                        label={`Remove beat ${index + 1}`}
                        icon={<Trash2 className="size-3.5" aria-hidden />}
                        onClick={() => removeBeat(beat.key)}
                      />
                    </div>
                  </div>
                  <TextAreaField
                    label="What happens"
                    value={beat.description}
                    onChange={(event) => updateBeat(beat.key, { description: event.target.value })}
                    rows={2}
                    className="mt-2"
                  />
                </li>
              ))}
            </ul>
          )}
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
