import { useState } from 'react';
import { Ban, Bot, FlaskConical, Send } from 'lucide-react';
import { Badge, Button, Card, EmptyState, PageHeader } from '@/components/ui';
import { useAiAssistance, useAiConfig } from '@/hooks';
import { Field, Select, TextArea } from '@/modules/ai/components/fields';

/**
 * AI Model Playground (Round 1 — AI Toolbox, was PLACEHOLDER).
 *
 * A direct way to send a free-form prompt to a chosen model and read the raw
 * response — useful for comparing models and tuning prompts before wiring them
 * into the editor. It runs through the shared `useAiAssistance` engine, so it
 * obeys the same provider config, timeouts and error handling as every other AI
 * surface. It never touches a manuscript.
 */
export function ModelPlaygroundPage() {
  const { models, providers, status: configStatus } = useAiConfig();
  const assistance = useAiAssistance();

  const [modelId, setModelId] = useState('');
  const [prompt, setPrompt] = useState('');

  const hasModels = models.length > 0;
  const usableModels = models.filter((m) => m.enabled);

  const send = () => {
    if (!prompt.trim()) return;
    void assistance.run({
      task: 'general-chat',
      sourceText: '',
      instruction: prompt,
      modelId: modelId || undefined,
    });
  };

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<FlaskConical className="size-4" />}
        eyebrow="AI Toolbox"
        title="AI Model Playground"
        description="Send a prompt straight to a model and compare raw responses. Non-destructive — nothing is saved."
        actions={
          <Badge tone={configStatus === 'empty' ? 'warning' : 'success'} size="md" dot>
            {usableModels.length > 0 ? `${usableModels.length} models ready` : 'No models configured'}
          </Badge>
        }
      />

      {!hasModels ? (
        <EmptyState
          icon={<Bot className="size-5" aria-hidden />}
          title="AI is not configured"
          description="Add a provider and at least one model to use the playground."
          hints={['Settings → Provider Management', 'Settings → Model Configuration']}
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card padding="md" className="space-y-3">
            <Field label="Model" htmlFor="playground-model" hint="Pick a specific model, or use the default.">
              <Select id="playground-model" value={modelId} onChange={(e) => setModelId(e.target.value)}>
                <option value="">Default model</option>
                {models.map((model) => (
                  <option key={model.id} value={model.id} disabled={!model.enabled}>
                    {model.displayName} · {providers.find((p) => p.id === model.providerId)?.name ?? 'Unknown'}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Prompt" htmlFor="playground-prompt" hint="Whatever you type is sent as the instruction.">
              <TextArea
                id="playground-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="e.g. Explain the difference between showing and telling, with an example."
                className="min-h-[220px]"
              />
            </Field>
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                iconLeft={<Send className="size-3.5" />}
                onClick={send}
                loading={assistance.generating}
                disabled={!prompt.trim()}
              >
                Send
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
            <div className="min-h-0 flex-1">{renderBody()}</div>
          </Card>
        </div>
      )}
    </div>
  );

  function renderBody() {
    if (assistance.status === 'generating') {
      return (
        <p className="text-subtle flex items-center gap-2 text-xs" role="status">
          <span className="bg-accent size-1.5 animate-pulse rounded-full" aria-hidden />
          Waiting for response…
        </p>
      );
    }
    if (assistance.status === 'cancelled') {
      return <p className="text-subtle text-xs italic">Request cancelled.</p>;
    }
    if (assistance.status === 'error' && assistance.error) {
      const hint = 'hint' in assistance.error ? (assistance.error as { hint?: string }).hint : undefined;
      return (
        <div className="space-y-1">
          <p className="text-danger text-sm" role="alert">
            {assistance.error.message}
          </p>
          {hint ? <p className="text-subtle text-xs">{hint}</p> : null}
          <Button variant="secondary" size="sm" className="mt-2" onClick={send}>
            Try again
          </Button>
        </div>
      );
    }
    if (assistance.proposal) {
      return <div className="text-ink text-sm leading-7 whitespace-pre-wrap">{assistance.proposal.generatedText}</div>;
    }
    return <p className="text-subtle text-xs italic">Responses appear here. Try different prompts or models to compare.</p>;
  }
}
