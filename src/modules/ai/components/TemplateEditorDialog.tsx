import { useEffect, useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui';
import type { AiTaskKind, PromptTemplate, PromptVariable } from '@/types';
import { AI_TASK_KINDS } from '@/types';
import { TASK_PROMPTS, validateTemplate } from '@/services';
import { ProjectDialog } from '@/modules/projects/components/ProjectDialog';
import { cn } from '@/utils/cn';
import { Field, Select, TextArea, TextInput } from './fields';

export interface TemplateEditorValues {
  name: string;
  description: string;
  category: string;
  content: string;
  variables: PromptVariable[];
  taskKind: AiTaskKind | null;
  providerId: string | null;
  modelId: string | null;
  enabled: boolean;
  versionLabel: string;
}

export interface TemplateEditorDialogProps {
  open: boolean;
  /** Existing template to edit, or null to create. */
  template: PromptTemplate | null;
  /** Known task kinds to bind the template to. */
  availableTasks?: readonly AiTaskKind[];
  onClose: () => void;
  onSubmit: (values: TemplateEditorValues) => Promise<void>;
}

const EMPTY_VARIABLE: PromptVariable = { name: '', description: '', required: false };

/**
 * Editor for a prompt template (P6).
 *
 * - Live variable management (add / rename / describe / required / default).
 * - Live validation against the declared variables, shown inline so an undeclared
 *   `{{variable}}` is caught before saving (rendering is strict).
 * - Optional task binding, so the template can serve as a task's default.
 *
 * Provider/model are treated as PREFERENCES only and are configured in Settings;
 * this dialog deliberately does NOT try to pick a model here beyond the task
 * binding, to avoid implying the template forces a model (R2).
 */
export function TemplateEditorDialog({
  open,
  template,
  availableTasks = AI_TASK_KINDS,
  onClose,
  onSubmit,
}: TemplateEditorDialogProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [content, setContent] = useState('');
  const [variables, setVariables] = useState<PromptVariable[]>([]);
  const [taskKind, setTaskKind] = useState<AiTaskKind | ''>('');
  const [enabled, setEnabled] = useState(true);
  const [versionLabel, setVersionLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(template?.name ?? '');
    setDescription(template?.description ?? '');
    setCategory(template?.category ?? 'Custom');
    setContent(template?.content ?? '');
    setVariables(template ? template.variables.map((variable) => ({ ...variable })) : []);
    setTaskKind((template?.taskKind as AiTaskKind | null) ?? '');
    setEnabled(template?.enabled ?? true);
    setVersionLabel('');
    setError(null);
  }, [open, template]);

  const issues = useMemo(() => validateTemplate(content, variables), [content, variables]);

  const updateVariable = (index: number, patch: Partial<PromptVariable>) => {
    setVariables((current) => current.map((variable, i) => (i === index ? { ...variable, ...patch } : variable)));
  };
  const addVariable = () => setVariables((current) => [...current, { ...EMPTY_VARIABLE }]);
  const removeVariable = (index: number) =>
    setVariables((current) => current.filter((_, i) => i !== index));

  const handleSubmit = async () => {
    setBusy(true);
    setError(null);
    try {
      const trimmedName = name.trim();
      if (!trimmedName) throw new Error('Give the template a name.');
      if (!content.trim()) throw new Error('The template body cannot be empty.');
      // Drop fully-blank variable rows.
      const cleanedVariables = variables
        .map((variable) => ({
          name: variable.name.trim(),
          description: variable.description.trim(),
          required: Boolean(variable.required),
          ...(variable.defaultValue !== undefined && variable.defaultValue !== ''
            ? { defaultValue: variable.defaultValue }
            : {}),
        }))
        .filter((variable) => variable.name.length > 0);

      const remainingIssues = validateTemplate(content, cleanedVariables);
      if (remainingIssues.length > 0) {
        throw new Error(remainingIssues.map((issue) => issue.message).join(' '));
      }

      await onSubmit({
        name: trimmedName,
        description: description.trim(),
        category: category.trim() || 'Custom',
        content,
        variables: cleanedVariables,
        taskKind: (taskKind || null) as AiTaskKind | null,
        providerId: template?.providerId ?? null,
        modelId: template?.modelId ?? null,
        enabled,
        versionLabel: versionLabel.trim(),
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The template could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ProjectDialog
      open={open}
      title={template ? 'Edit template' : 'New template'}
      description="Use {{variable}} placeholders. Every placeholder must be declared as a variable below."
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={() => void handleSubmit()} loading={busy} disabled={!name.trim() || !content.trim()}>
            {template ? 'Save changes' : 'Create template'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor="tpl-name" required>
            <TextInput id="tpl-name" value={name} onChange={(event) => setName(event.target.value)} disabled={busy} />
          </Field>
          <Field label="Category" htmlFor="tpl-category">
            <TextInput
              id="tpl-category"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              placeholder="e.g. Continuation"
              disabled={busy}
            />
          </Field>
        </div>

        <Field label="Description" htmlFor="tpl-desc">
          <TextInput
            id="tpl-desc"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What is this template for?"
            disabled={busy}
          />
        </Field>

        <Field label="Task" htmlFor="tpl-task" hint="Bind to a task to let it serve as that task's default.">
          <Select
            id="tpl-task"
            value={taskKind}
            onChange={(event) => setTaskKind(event.target.value as AiTaskKind | '')}
            disabled={busy}
          >
            <option value="">Not bound to a task</option>
            {availableTasks.map((task) => (
              <option key={task} value={task}>
                {TASK_PROMPTS[task]?.label ?? task}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Template body" htmlFor="tpl-content" required hint="The text sent to the model. {{name}} inserts a variable.">
          <TextArea
            id="tpl-content"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            disabled={busy}
            className="min-h-[160px] font-mono text-xs leading-relaxed"
            placeholder="Continue the story after: {{sourceText}}"
          />
        </Field>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-subtle text-2xs font-medium uppercase tracking-wide">Variables</p>
            <Button variant="ghost" size="sm" iconLeft={<Plus className="size-3" />} onClick={addVariable} disabled={busy}>
              Add variable
            </Button>
          </div>
          {variables.length === 0 ? (
            <p className="text-subtle text-2xs italic">No variables. Add one if the body uses {"{{placeholders}}"}.</p>
          ) : (
            <ul className="space-y-2">
              {variables.map((variable, index) => (
                <li key={index} className="border-line rounded-md border p-2">
                  <div className="grid grid-cols-[1fr_1.4fr_auto] items-end gap-2">
                    <Field label="Name" htmlFor={`var-name-${index}`}>
                      <TextInput
                        id={`var-name-${index}`}
                        value={variable.name}
                        onChange={(event) => updateVariable(index, { name: event.target.value })}
                        placeholder="sourceText"
                        className="font-mono"
                        disabled={busy}
                      />
                    </Field>
                    <Field label="Description" htmlFor={`var-desc-${index}`}>
                      <TextInput
                        id={`var-desc-${index}`}
                        value={variable.description}
                        onChange={(event) => updateVariable(index, { description: event.target.value })}
                        disabled={busy}
                      />
                    </Field>
                    <button
                      type="button"
                      onClick={() => removeVariable(index)}
                      disabled={busy}
                      aria-label={`Remove variable ${variable.name || index + 1}`}
                      className="text-subtle hover:text-danger mb-1.5 grid size-7 place-items-center rounded-md disabled:opacity-40"
                    >
                      <X className="size-3.5" aria-hidden />
                    </button>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-3">
                    <label className="text-muted flex items-center gap-1.5 text-2xs">
                      <input
                        type="checkbox"
                        checked={Boolean(variable.required)}
                        onChange={(event) => updateVariable(index, { required: event.target.checked })}
                        disabled={busy}
                        className="accent-accent size-3.5"
                      />
                      Required
                    </label>
                    <div className="flex items-center gap-1.5">
                      <span className="text-subtle text-2xs">Default</span>
                      <TextInput
                        value={variable.defaultValue ?? ''}
                        onChange={(event) =>
                          updateVariable(index, { defaultValue: event.target.value === '' ? undefined : event.target.value })
                        }
                        placeholder="(none)"
                        className="h-7 w-40 text-2xs"
                        disabled={busy}
                      />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <label className="text-muted flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            disabled={busy}
            className="accent-accent size-3.5"
          />
          Enabled
        </label>

        {template ? (
          <Field label="Version note" htmlFor="tpl-version-label" hint="Optional note stored on the new version.">
            <TextInput
              id="tpl-version-label"
              value={versionLabel}
              onChange={(event) => setVersionLabel(event.target.value)}
              placeholder="e.g. Tightened instructions"
              disabled={busy}
            />
          </Field>
        ) : null}

        {issues.length > 0 ? (
          <div className="bg-warning-soft text-warning rounded-md p-2 text-2xs" role="status">
            <p className="font-medium">Template warnings</p>
            <ul className="mt-1 list-inside list-disc space-y-0.5">
              {issues.map((issue, index) => (
                <li key={index}>{issue.message}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p className={cn('text-success text-2xs')}>Template is valid.</p>
        )}

        {error ? (
          <p className="text-danger text-xs" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </ProjectDialog>
  );
}
