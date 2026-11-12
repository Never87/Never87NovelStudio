import { useState } from 'react';
import { Ban, Bot, Send, Sparkles } from 'lucide-react';
import { Badge, Button, Card, EmptyState, PageHeader } from '@/components/ui';
import type { AiTaskKind } from '@/types';
import { TASK_PROMPT_LIST } from '@/services';
import { useAiAssistance, useAiConfig } from '@/hooks';
import { cn } from '@/utils/cn';
import { Field, Select, TextArea } from './components/fields';

/**
 * AI Assistance (P5) — standalone workspace.
 *
 * A general-purpose surface for asking questions and getting writing
 * suggestions. It shares the same `useAiAssistance` engine as the editor, so
 * status, cancellation and error handling behave identically. It does NOT apply
 * anything to a manuscript — the editor is where edits are applied.
 */
export function AiAssistancePanel() {
  const { models, providers, globalDefaultModelId, status: configStatus } = useAiConfig();
  const assistance = useAiAssistance();

  const [task, setTask] = useState<AiTaskKind>('general-chat');
  const [instruction, setInstruction] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [modelId, setModelId] = useState('');

  const hasModels = models.length > 0;
  const selectedTask = TASK_PROMPT_LIST.find((entry) => entry.task === task);

  const submit = () => {
    void assistance.run({
      task,
      sourceText,
      instruction,
      modelId: modelId || undefined,
    });
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="AI Assistance"
        description="Ask questions and get writing suggestions. To apply changes to a manuscript, use the AI tools inside the Story Editor."
        actions={
          <Badge tone={configStatus === 'empty' ? 'warning' : 'success'} size="md" dot>
            {hasModels ? `${models.length} models available` : 'No models configured'}
          </Badge>
        }
      />

      {!hasModels ? (
        <EmptyState
          icon={<Bot className="size-5" aria-hidden />}
          title="AI is not configured"
          description="Add a provider and at least one model to start using AI features."
          hints={['Settings → Provider Management', 'Settings → Model Configuration']}
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
          <Card padding="md" className="h-fit space-y-3">
            <Field label="Task" htmlFor="assist-task">
              <Select id="assist-task" value={task} onChange={(event) => setTask(event.target.value as AiTaskKind)}>
                {TASK_PROMPT_LIST.filter((entry) => entry.mode === 'chat').map((entry) => (
                  <option key={entry.task} value={entry.task}>
                    {entry.label}
                  </option>
                ))}
              </Select>
              <p className="text-subtle text-2xs">{selectedTask?.description}</p>
            </Field>

            <Field label="Model (optional)" htmlFor="assist-model" hint={`Leave blank to use the default${globalDefaultModelId ? '' : ' (none set)'}.`}>
              <Select id="assist-model" value={modelId} onChange={(event) => setModelId(event.target.value)}>
                <option value="">Default model</option>
                {models.map((model) => (
                  <option key={model.id} value={model.id} disabled={!model.enabled}>
                    {model.displayName} · {providers.find((p) => p.id === model.providerId)?.name ?? 'Unknown'}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Your question" htmlFor="assist-instruction">
              <TextArea
                id="assist-instruction"
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
                placeholder="e.g. How can I make this opening more tense?"
              />
            </Field>

            <Field label="Optional passage" htmlFor="assist-source" hint="Paste text for the model to consider.">
              <TextArea
                id="assist-source"
                value={sourceText}
                onChange={(event) => setSourceText(event.target.value)}
                placeholder="Paste a paragraph for context…"
                className="min-h-[120px]"
              />
            </Field>

            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                iconLeft={<Sparkles className="size-3.5" />}
                onClick={submit}
                loading={assistance.generating}
              >
                Generate
              </Button>
              {assistance.generating ? (
                <Button variant="ghost" size="sm" iconLeft={<Ban className="size-3.5" />} onClick={assistance.cancel}>
                  Stop
                </Button>
              ) : null}
            </div>
          </Card>

          <Card padding="md" className="flex min-h-[360px] flex-col">
            <div className="border-line mb-3 flex items-center justify-between border-b pb-2">
              <h2 className="text-ink text-sm font-semibold">Response</h2>
              {assistance.proposal ? (
                <span className="text-subtle text-2xs">
                  {assistance.proposal.target.modelName} · {assistance.proposal.target.providerName}
                </span>
              ) : null}
            </div>

            <div className="min-h-0 flex-1">
              {renderResponse()}
            </div>

            {assistance.proposal ? (
              <div className="border-line mt-3 flex items-center justify-end gap-2 border-t pt-2">
                <Button variant="ghost" size="sm" onClick={submit} disabled={assistance.generating}>
                  <Send className="mr-1 size-3" aria-hidden />
                  Ask again
                </Button>
              </div>
            ) : null}
          </Card>
        </div>
      )}
    </div>
  );

  function renderResponse() {
    if (assistance.status === 'generating') {
      return (
        <p className="text-subtle flex items-center gap-2 text-xs" role="status">
          <span className="bg-accent size-1.5 animate-pulse rounded-full" aria-hidden />
          Generating…
        </p>
      );
    }
    if (assistance.status === 'cancelled') {
      return <p className="text-subtle text-xs italic">Generation cancelled.</p>;
    }
    if (assistance.status === 'error' && assistance.error) {
      const hint = 'hint' in assistance.error ? (assistance.error as { hint?: string }).hint : undefined;
      return (
        <div className="space-y-1">
          <p className="text-danger text-sm" role="alert">
            {assistance.error.message}
          </p>
          {hint ? <p className="text-subtle text-xs">{hint}</p> : null}
          <Button variant="secondary" size="sm" className="mt-2" onClick={submit}>
            Try again
          </Button>
        </div>
      );
    }
    if (assistance.proposal) {
      return (
        <div className={cn('text-ink text-sm leading-7 whitespace-pre-wrap')}>{assistance.proposal.generatedText}</div>
      );
    }
    return <p className="text-subtle text-xs italic">Ask a question or request suggestions to see a response here.</p>;
  }
}
