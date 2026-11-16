import { useState } from 'react';
import { Ban, Bot, Lightbulb, Sparkles } from 'lucide-react';
import { Badge, Button, Card, EmptyState, PageHeader } from '@/components/ui';
import { useAiAssistance, useAiConfig } from '@/hooks';
import { Field, Select, TextInput, TextArea } from '@/modules/ai/components/fields';

/**
 * Story Idea Generator (Round 1 — AI Toolbox, was PLACEHOLDER).
 *
 * Turns a short brief (genre / theme / a spark of a premise) into concrete
 * story ideas using the SAME `useAiAssistance` engine as the rest of the app —
 * no separate prompt/model pipeline. It generates SUGGESTIONS only; nothing is
 * written into a project unless the author copies it, so it is safe and
 * non-destructive.
 */
export function IdeaGeneratorPage() {
  const { models, providers, status: configStatus } = useAiConfig();
  const assistance = useAiAssistance();

  const [genre, setGenre] = useState('');
  const [theme, setTheme] = useState('');
  const [details, setDetails] = useState('');
  const [modelId, setModelId] = useState('');

  const hasModels = models.length > 0;

  const generate = () => {
    const brief = [
      genre.trim() ? `Genre: ${genre.trim()}` : '',
      theme.trim() ? `Theme: ${theme.trim()}` : '',
      details.trim() ? `Extra details: ${details.trim()}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    if (!brief) return;
    void assistance.run({
      task: 'suggestions',
      sourceText: '',
      instruction: `Brainstorm 5 distinct, original story ideas based on this brief. For each idea give a punchy title, a one-sentence logline, the central conflict, and a suggested twist.\n\n${brief}`,
      modelId: modelId || undefined,
    });
  };

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Lightbulb className="size-4" />}
        eyebrow="AI Toolbox"
        title="Story Idea Generator"
        description="Turn a genre, theme or half-formed premise into concrete story ideas. Nothing is saved — copy what you like."
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
          description="Add a provider and at least one model to start generating ideas."
          hints={['Settings → Provider Management', 'Settings → Model Configuration']}
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
          <Card padding="md" className="h-fit space-y-3">
            <Field label="Genre" htmlFor="idea-genre" hint="e.g. dark fantasy, cozy mystery, sci-fi thriller">
              <TextInput id="idea-genre" value={genre} onChange={(e) => setGenre(e.target.value)} placeholder="Genre" />
            </Field>
            <Field label="Theme" htmlFor="idea-theme" hint="e.g. redemption, found family, ambition">
              <TextInput id="idea-theme" value={theme} onChange={(e) => setTheme(e.target.value)} placeholder="Theme" />
            </Field>
            <Field label="Extra details" htmlFor="idea-details" hint="Setting, protagonist, a twist you want, tone…">
              <TextArea
                id="idea-details"
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                placeholder="Anything you already know about the story…"
                className="min-h-[90px]"
              />
            </Field>
            <Field label="Model (optional)" htmlFor="idea-model" hint="Leave blank to use the default model.">
              <Select id="idea-model" value={modelId} onChange={(e) => setModelId(e.target.value)}>
                <option value="">Default model</option>
                {models.map((model) => (
                  <option key={model.id} value={model.id} disabled={!model.enabled}>
                    {model.displayName} · {providers.find((p) => p.id === model.providerId)?.name ?? 'Unknown'}
                  </option>
                ))}
              </Select>
            </Field>

            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                iconLeft={<Sparkles className="size-3.5" />}
                onClick={generate}
                loading={assistance.generating}
                disabled={!genre.trim() && !theme.trim() && !details.trim()}
              >
                Generate ideas
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
              <h2 className="text-ink text-sm font-semibold">Ideas</h2>
              {assistance.proposal ? (
                <span className="text-subtle text-2xs">
                  {assistance.proposal.target.modelName} · {assistance.proposal.target.providerName}
                </span>
              ) : null}
            </div>
            <div className="min-h-0 flex-1">{renderBody()}</div>
            {assistance.proposal ? (
              <div className="border-line mt-3 flex items-center justify-end gap-2 border-t pt-2">
                <Button variant="secondary" size="sm" onClick={generate} disabled={assistance.generating}>
                  Regenerate
                </Button>
              </div>
            ) : null}
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
          Brainstorming ideas…
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
          <Button variant="secondary" size="sm" className="mt-2" onClick={generate}>
            Try again
          </Button>
        </div>
      );
    }
    if (assistance.proposal) {
      return <div className="text-ink text-sm leading-7 whitespace-pre-wrap">{assistance.proposal.generatedText}</div>;
    }
    return (
      <p className="text-subtle text-xs italic">
        Fill in a genre, theme or any detail you already have, then generate a set of story ideas.
      </p>
    );
  }
}
