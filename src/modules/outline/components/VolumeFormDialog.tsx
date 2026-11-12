import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { RefreshCw, Save } from 'lucide-react';
import { Button } from '@/components/ui';
import type { Volume } from '@/types';
import { VolumeSchema } from '@/schemas/outline';
import type { CreateVolumeInput, UpdateVolumeInput } from '@/services';
import { ProjectDialog } from '@/modules/projects/components/ProjectDialog';
import { TextAreaField, TextField } from '@/modules/projects/components/FormFields';
import { describeError } from '@/modules/projects/components/ProjectFormDialog';

interface FormValues {
  title: string;
  summary: string;
}

type FieldErrors = Partial<Record<keyof FormValues | 'form', string>>;

export interface VolumeFormDialogProps {
  open: boolean;
  initialVolume?: Volume | null;
  onSubmit: (input: CreateVolumeInput | UpdateVolumeInput) => Promise<unknown>;
  onClose: () => void;
}

function toFormValues(volume?: Volume | null): FormValues {
  return { title: volume?.title ?? '', summary: volume?.summary ?? '' };
}

/** Create / edit volume dialog. Validates the payload with the real schema. */
export function VolumeFormDialog({ open, initialVolume, onSubmit, onClose }: VolumeFormDialogProps) {
  const isEdit = Boolean(initialVolume);
  const [values, setValues] = useState<FormValues>(() => toFormValues(initialVolume));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const submittingRef = useRef(false);

  useEffect(() => {
    if (open) {
      setValues(toFormValues(initialVolume));
      setErrors({});
      setSubmitError(null);
      setSaving(false);
      submittingRef.current = false;
    }
  }, [open, initialVolume]);

  const setField = <K extends keyof FormValues>(key: K, value: FormValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => (prev[key] || prev.form ? { ...prev, [key]: undefined, form: undefined } : prev));
  };

  const validate = (): boolean => {
    const next: FieldErrors = {};
    const result = VolumeSchema.safeParse({
      id: initialVolume?.id ?? 'draft',
      projectId: initialVolume?.projectId ?? 'draft',
      title: values.title.trim() || ' ',
      summary: values.summary,
      createdAt: initialVolume?.createdAt ?? 0,
      updatedAt: initialVolume?.updatedAt ?? 0,
    });
    if (!result.success) {
      for (const issue of result.error.issues) {
        const [head] = issue.path;
        if (head === 'title') next.title = issue.message;
        else if (head === 'summary') next.summary = issue.message;
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

    const payload = { title: values.title.trim(), summary: values.summary };
    try {
      await onSubmit(payload);
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
      title={isEdit ? 'Edit volume' : 'New volume'}
      description={isEdit ? 'Update this volume.' : 'Group chapters into a volume.'}
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
            form="volume-form"
            loading={saving}
            iconLeft={!saving ? <Save className="size-3.5" /> : undefined}
          >
            {isEdit ? 'Save changes' : 'Create volume'}
          </Button>
        </>
      }
    >
      <form id="volume-form" onSubmit={handleSubmit} className="space-y-3.5" noValidate>
        <TextField
          label="Title"
          required
          value={values.title}
          onChange={(event) => setField('title', event.target.value)}
          placeholder="e.g. Book One: The Drowned Coast"
          error={errors.title}
          maxLength={200}
          autoFocus
        />
        <TextAreaField
          label="Summary"
          value={values.summary}
          onChange={(event) => setField('summary', event.target.value)}
          placeholder="What this volume covers."
          error={errors.summary}
          rows={3}
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
