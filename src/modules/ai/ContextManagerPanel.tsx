import { useMemo, useState } from 'react';
import { AlertTriangle, Info, Layers, Plus, Trash2 } from 'lucide-react';
import { Badge, Button, Card, EmptyState, IconButton, PageHeader } from '@/components/ui';
import type { AiTaskKind, ContextItem, ContextLayer, ContextSourceType } from '@/types';
import { AI_TASK_KINDS } from '@/types';
import { TASK_PROMPTS } from '@/services';
import { useContextManager, usePromptRequest, useProjects, useCharacters, useOutline } from '@/hooks';
import { cn } from '@/utils/cn';
import { Field, NumberInput, Select, TextArea, Toggle } from './components/fields';
import { ProjectPicker } from './components/ProjectPicker';

const LAYER_LABELS: Record<ContextLayer, string> = {
  base: 'Base (stable project facts)',
  dynamic: 'Dynamic (current chapter/scene)',
  retrieved: 'Retrieved (selected references)',
  instructions: 'Instructions (persistent + request)',
};

const SOURCE_TYPES: Array<{ value: ContextSourceType; label: string; needsId: boolean }> = [
  { value: 'character', label: 'Character', needsId: true },
  { value: 'chapter', label: 'Chapter', needsId: true },
  { value: 'scene', label: 'Scene', needsId: true },
  { value: 'note', label: 'Note', needsId: false },
  { value: 'instruction', label: 'Instruction', needsId: false },
];

/**
 * AI Context Manager (P6).
 *
 * Lets the user control what the model sees:
 *   - enable/disable the four context layers (R3),
 *   - set the input token budget and persistent instructions (R4),
 *   - add referenced records / notes to the retrieved layer,
 *   - PREVIEW the assembled request verbatim, with token accounting and
 *     duplication/conflict/overflow warnings.
 *
 * The preview uses the SAME `ContextAssemblyService.assemble` that execution
 * uses, so what is shown is exactly what would be sent (R5).
 */
export function ContextManagerPanel() {
  const { projects, initialLoading: projectsLoading } = useProjects();
  const [projectId, setProjectId] = useState('');
  const effectiveProjectId = projectId || projects[0]?.id || '';

  const manager = useContextManager(effectiveProjectId);
  const request = usePromptRequest();
  const characters = useCharacters(effectiveProjectId);
  const outline = useOutline(effectiveProjectId);

  const [task, setTask] = useState<AiTaskKind>('continue');
  const [instruction, setInstruction] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [chapterId, setChapterId] = useState('');
  const [previewError, setPreviewError] = useState<string | null>(null);

  const chapters = useMemo(() => outline.outline.flatMap((volume) => volume.chapters), [outline.outline]);

  const config = manager.config;

  const updateConfig = async (patch: Parameters<typeof manager.updateConfig>[0]) => {
    try {
      await manager.updateConfig(patch);
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : String(error));
    }
  };

  const buildPreview = async () => {
    setPreviewError(null);
    try {
      await request.assemble({
        projectId: effectiveProjectId,
        task,
        instruction: instruction || undefined,
        chapterId: chapterId || undefined,
        values: { sourceText, instruction, chapterTitle: chapters.find((c) => c.id === chapterId)?.title },
      });
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="AI Context Manager"
        description="Control exactly what the model sees. The preview is the literal request that would be sent — execution uses the same assembly."
        actions={<ProjectPicker projects={projects} value={effectiveProjectId} onChange={setProjectId} />}
      />

      {projectsLoading ? (
        <Card padding="lg">
          <p className="text-subtle text-xs" role="status">
            Loading projects…
          </p>
        </Card>
      ) : projects.length === 0 ? (
        <EmptyState
          icon={<Layers className="size-5" aria-hidden />}
          title="No projects yet"
          description="Context is assembled per project. Create a project first."
        />
      ) : !config ? (
        <Card padding="lg">
          <p className="text-subtle text-xs" role="status">
            Loading context configuration…
          </p>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
          {/* Left: configuration + items */}
          <div className="space-y-4">
            <Card padding="md" className="space-y-3">
              <h2 className="text-ink text-sm font-semibold">Budget & layers</h2>

              <label className="text-muted flex items-center justify-between gap-2 text-xs">
                <span>Enforce token budget</span>
                <Toggle
                  checked={config.budgetEnabled}
                  onChange={(next) => void updateConfig({ budgetEnabled: next })}
                  label="Enforce token budget"
                />
              </label>

              <Field label="Input budget (tokens)" htmlFor="ctx-budget" hint="Clamped to the model's window when known. Never derived from max-output tokens.">
                <NumberInput
                  id="ctx-budget"
                  value={config.inputBudgetTokens}
                  min={256}
                  step={256}
                  disabled={!config.budgetEnabled}
                  onChange={(event) => void updateConfig({ inputBudgetTokens: Number(event.target.value) || 256 })}
                />
              </Field>

              <Field
                label="Model context window override"
                htmlFor="ctx-window"
                hint="Only set this if your model's window is not recorded in Model Configuration. Leave blank for unknown."
              >
                <NumberInput
                  id="ctx-window"
                  value={config.contextWindowOverrideTokens ?? ''}
                  min={1}
                  step={1024}
                  placeholder="(use model setting)"
                  onChange={(event) =>
                    void updateConfig({ contextWindowOverrideTokens: event.target.value === '' ? null : Number(event.target.value) })
                  }
                />
              </Field>

              <div className="space-y-1.5">
                {(Object.keys(LAYER_LABELS) as ContextLayer[]).map((layer) => (
                  <label key={layer} className="text-muted flex items-center justify-between gap-2 text-xs">
                    <span>{LAYER_LABELS[layer]}</span>
                    <Toggle
                      checked={config.enabledLayers[layer]}
                      onChange={(next) => void updateConfig({ enabledLayers: { [layer]: next } })}
                      label={`Enable ${layer} layer`}
                    />
                  </label>
                ))}
              </div>

              <Field label="Persistent instructions" htmlFor="ctx-persistent" hint="Always sent with every request for this project.">
                <TextArea
                  id="ctx-persistent"
                  value={config.persistentInstructions}
                  onChange={(event) => void updateConfig({ persistentInstructions: event.target.value })}
                  placeholder="e.g. Maintain a close third-person POV."
                  className="min-h-[80px]"
                />
              </Field>
            </Card>

            <ContextItemsCard
              items={manager.items}
              characters={characters.characters}
              chapters={chapters}
              onAdd={async (input) => {
                try {
                  await manager.createItem(input);
                } catch (error) {
                  setPreviewError(error instanceof Error ? error.message : String(error));
                }
              }}
              onToggle={(item, enabled) => void manager.updateItem(item.id, { enabled })}
              onDelete={(item) => void manager.deleteItem(item.id)}
            />
          </div>

          {/* Right: preview */}
          <Card padding="md" className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-ink text-sm font-semibold">Request preview</h2>
              <Button variant="primary" size="sm" onClick={() => void buildPreview()} loading={request.assembling} disabled={!effectiveProjectId}>
                Assemble preview
              </Button>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <Field label="Task" htmlFor="ctx-task">
                <Select id="ctx-task" value={task} onChange={(event) => setTask(event.target.value as AiTaskKind)}>
                  {AI_TASK_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {TASK_PROMPTS[kind]?.label ?? kind}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Current chapter" htmlFor="ctx-chapter">
                <Select id="ctx-chapter" value={chapterId} onChange={(event) => setChapterId(event.target.value)}>
                  <option value="">None</option>
                  {chapters.map((chapter) => (
                    <option key={chapter.id} value={chapter.id}>
                      {chapter.title}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <Field label="Selection / source text" htmlFor="ctx-source">
              <TextArea
                id="ctx-source"
                value={sourceText}
                onChange={(event) => setSourceText(event.target.value)}
                placeholder="The passage the task operates on…"
                className="min-h-[80px]"
              />
            </Field>
            <Field label="Request instruction" htmlFor="ctx-instruction">
              <TextArea
                id="ctx-instruction"
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
                placeholder="e.g. Keep it tense."
                className="min-h-[60px]"
              />
            </Field>

            {previewError ? (
              <p className="text-danger text-xs" role="alert">
                {previewError}
              </p>
            ) : null}

            {request.request ? <RequestPreview request={request.request} /> : (
              <p className="text-subtle text-xs italic">Assemble a preview to see the exact request and token usage.</p>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function ContextItemsCard({
  items,
  characters,
  chapters,
  onAdd,
  onToggle,
  onDelete,
}: {
  items: ContextItem[];
  characters: Array<{ id: string; name: string }>;
  chapters: Array<{ id: string; title: string }>;
  onAdd: (input: {
    layer: ContextLayer;
    sourceType: ContextSourceType;
    sourceId?: string | null;
    sourceLabel?: string;
    content?: string;
    priority?: 'low' | 'normal' | 'required';
  }) => Promise<void>;
  onToggle: (item: ContextItem, enabled: boolean) => void;
  onDelete: (item: ContextItem) => void;
}) {
  const [sourceType, setSourceType] = useState<ContextSourceType>('character');
  const [referenceId, setReferenceId] = useState('');
  const [noteText, setNoteText] = useState('');
  const [priority, setPriority] = useState<'low' | 'normal' | 'required'>('normal');

  const needsId = SOURCE_TYPES.find((entry) => entry.value === sourceType)?.needsId ?? false;

  const submit = async () => {
    const options =
      sourceType === 'character'
        ? characters.map((c) => ({ id: c.id, label: c.name }))
        : sourceType === 'chapter'
          ? chapters.map((c) => ({ id: c.id, label: c.title }))
          : [];
    const label = options.find((option) => option.id === referenceId)?.label;

    if (needsId) {
      if (!referenceId) return;
      await onAdd({ layer: 'retrieved', sourceType, sourceId: referenceId, sourceLabel: label, priority });
      setReferenceId('');
    } else {
      if (!noteText.trim()) return;
      await onAdd({
        layer: sourceType === 'instruction' ? 'instructions' : 'retrieved',
        sourceType,
        sourceId: null,
        sourceLabel: sourceType === 'instruction' ? 'Instruction' : 'Note',
        content: noteText,
        priority,
      });
      setNoteText('');
    }
  };

  return (
    <Card padding="md" className="space-y-3">
      <h2 className="text-ink text-sm font-semibold">Context items</h2>
      <p className="text-subtle text-2xs">
        References are resolved live at request time — editing the character or chapter updates the context automatically.
      </p>

      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Source" htmlFor="item-source">
          <Select id="item-source" value={sourceType} onChange={(event) => setSourceType(event.target.value as ContextSourceType)}>
            {SOURCE_TYPES.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Priority" htmlFor="item-priority">
          <Select id="item-priority" value={priority} onChange={(event) => setPriority(event.target.value as 'low' | 'normal' | 'required')}>
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="required">Required (never trimmed)</option>
          </Select>
        </Field>
      </div>

      {needsId ? (
        <Field label={sourceType === 'character' ? 'Character' : 'Chapter'} htmlFor="item-ref">
          <Select id="item-ref" value={referenceId} onChange={(event) => setReferenceId(event.target.value)}>
            <option value="">Select…</option>
            {(sourceType === 'character' ? characters : chapters).map((option) => (
              <option key={option.id} value={option.id}>
                {'name' in option ? option.name : option.title}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <Field label={sourceType === 'instruction' ? 'Instruction text' : 'Note text'} htmlFor="item-note">
          <TextArea id="item-note" value={noteText} onChange={(event) => setNoteText(event.target.value)} className="min-h-[60px]" />
        </Field>
      )}

      <Button variant="secondary" size="sm" iconLeft={<Plus className="size-3.5" />} onClick={() => void submit()} disabled={needsId ? !referenceId : !noteText.trim()}>
        Add item
      </Button>

      {items.length === 0 ? (
        <p className="text-subtle text-2xs italic">No context items yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((item) => (
            <li key={item.id} className="border-line flex items-center justify-between gap-2 rounded-md border px-2 py-1.5">
              <div className="min-w-0">
                <p className="text-ink truncate text-xs font-medium">{item.sourceLabel || item.sourceType}</p>
                <p className="text-subtle text-2xs">
                  {item.layer} · {item.sourceType} · {item.priority}
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                <Toggle checked={item.enabled} onChange={(next) => onToggle(item, next)} label={`Enable ${item.sourceLabel || item.sourceType}`} />
                <IconButton variant="ghost" size="sm" label={`Delete ${item.sourceLabel || item.sourceType}`} icon={<Trash2 className="size-3.5" aria-hidden />} onClick={() => onDelete(item)} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* -------------------------------------------------------------------------- */

function RequestPreview({ request }: { request: import('@/services').AssembledRequest }) {
  const { budget, notices } = request;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Est. input" value={`${budget.estimatedInputTokens.toLocaleString()}`} />
        <Stat label="Budget" value={budget.effectiveInputBudget != null ? budget.effectiveInputBudget.toLocaleString() : '—'} />
        <Stat label="Model window" value={budget.modelContextWindow != null ? budget.modelContextWindow.toLocaleString() : 'unknown'} />
        <Stat label="Fits" value={budget.fits ? 'Yes' : 'No'} />
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Badge tone={budget.fits ? 'success' : 'danger'} size="sm" dot>
          {budget.fits ? 'Within budget' : 'Over budget'}
        </Badge>
        <Badge tone="neutral" size="sm">
          basis: {budget.basis}
        </Badge>
        {request.templateName ? (
          <Badge tone="accent" size="sm">
            template: {request.templateName}
          </Badge>
        ) : (
          <Badge tone="warning" size="sm">
            no template — using built-in
          </Badge>
        )}
        {request.target ? (
          <Badge tone="info" size="sm">
            {request.target.model.displayName}
          </Badge>
        ) : null}
      </div>

      {notices.length > 0 ? (
        <ul className="space-y-1">
          {notices.map((notice, index) => (
            <li key={index} className={cn('flex items-start gap-1.5 text-2xs', notice.kind === 'overflow' || notice.kind === 'missing' ? 'text-warning' : 'text-subtle')}>
              {notice.kind === 'overflow' || notice.kind === 'missing' ? (
                <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
              ) : (
                <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
              )}
              <span>{notice.message}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div>
        <p className="text-subtle mb-1 text-2xs font-medium uppercase tracking-wide">Included sections</p>
        <ul className="space-y-1">
          {request.sections.map((section) => (
            <li key={section.key} className={cn('flex items-center justify-between gap-2 text-2xs', !section.included && 'opacity-50')}>
              <span className="text-ink truncate">
                [{section.layer}] {section.label}
              </span>
              <span className="text-subtle shrink-0">
                {section.included ? `${section.tokens} tok` : section.trimmedReason ?? 'omitted'}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <p className="text-subtle mb-1 text-2xs font-medium uppercase tracking-wide">Exact request</p>
        <pre className="bg-surface-muted border-line max-h-80 overflow-auto rounded-md border p-2 font-mono text-2xs whitespace-pre-wrap">
          {request.messages.map((message) => `### ${message.role}\n${message.content}`).join('\n\n')}
        </pre>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-subtle text-2xs font-medium uppercase tracking-wide">{label}</p>
      <p className="text-ink mt-0.5 truncate text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}
