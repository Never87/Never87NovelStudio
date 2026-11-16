import { useMemo, useState } from 'react';
import { Ban, Palette, Sparkles, Wand2 } from 'lucide-react';
import { Badge, Button, Card, CardHeader, PageHeader } from '@/components/ui';
import { useAiAssistance, useAiConfig } from '@/hooks';
import { Field, Select } from '@/modules/ai/components/fields';
import { analyzeStyle, topWords } from './style-analysis';

/**
 * Style Analyzer (Round 1 — AI Toolbox, was PLACEHOLDER).
 *
 * Two complementary halves:
 *   1. INSTANT local metrics (always available, no AI): readability, sentence
 *      rhythm, lexical diversity, adverb & passive usage, most-used words — all
 *      computed from the actual pasted text.
 *   2. OPTIONAL AI critique: if models are configured, the author can request a
 *      qualitative style review via the shared `useAiAssistance` engine.
 *
 * The local analysis never depends on AI being configured, so this page is
 * useful even with no provider set up.
 */
export function StyleAnalyzerPage() {
  const { models, providers } = useAiConfig();
  const assistance = useAiAssistance();

  const [text, setText] = useState('');
  const [modelId, setModelId] = useState('');

  const hasModels = models.length > 0;
  const metrics = useMemo(() => analyzeStyle(text), [text]);
  const top = useMemo(() => topWords(text, 10), [text]);
  const hasText = metrics.wordCount > 0;

  const runAiReview = () => {
    if (!hasText) return;
    void assistance.run({
      task: 'suggestions',
      sourceText: text.slice(0, 12_000),
      instruction:
        'Act as a line editor. Analyse the following prose for style: voice, sentence rhythm, clarity, overused words, and 3 concrete, actionable revision suggestions. Be specific and concise.',
      modelId: modelId || undefined,
    });
  };

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Palette className="size-4" />}
        eyebrow="AI Toolbox"
        title="Style Analyzer"
        description="Objective readability & rhythm metrics on your prose, plus an optional AI line-edit review."
        actions={
          <Badge tone={hasModels ? 'success' : 'neutral'} size="md" dot>
            {hasModels ? 'AI review available' : 'Local analysis only'}
          </Badge>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <Card padding="md" className="space-y-3">
          <CardHeader title="Your text" description="Paste prose to analyse. Metrics update as you type." icon={<Wand2 className="size-4" />} />
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste a chapter, a scene or a paragraph here…"
            className="border-line bg-surface text-ink focus:border-accent min-h-[280px] w-full rounded-md border px-3 py-2 text-sm leading-7"
          />
          <div className="text-subtle text-2xs">
            {metrics.wordCount.toLocaleString()} words · {metrics.sentenceCount.toLocaleString()} sentences ·{' '}
            {metrics.characters.toLocaleString()} characters
          </div>
        </Card>

        <Card padding="md">
          <CardHeader title="Readability & rhythm" description="Computed locally from your text" icon={<Palette className="size-4" />} />
          {!hasText ? (
            <p className="text-subtle mt-4 text-xs italic">Paste some text to see metrics.</p>
          ) : (
            <div className="mt-4 space-y-3">
              <Metric
                label="Flesch Reading Ease"
                value={metrics.fleschReadingEase === null ? '—' : metrics.fleschReadingEase.toFixed(1)}
                hint={metrics.readabilityBand}
              />
              <Metric
                label="Reading grade (F-K)"
                value={metrics.fleschKincaidGrade === null ? '—' : `Grade ${metrics.fleschKincaidGrade.toFixed(1)}`}
              />
              <Metric label="Avg words / sentence" value={metrics.avgSentenceLength.toFixed(1)} hint={`longest ${metrics.longestSentenceWords}`} />
              <Metric label="Sentence-length variation" value={metrics.sentenceLengthStdDev.toFixed(1)} hint="higher = more varied rhythm" />
              <Metric label="Lexical diversity" value={`${Math.round(metrics.lexicalDiversity * 100)}%`} hint="distinct / total words" />
              <Metric label="Long words (3+ syllables)" value={`${Math.round(metrics.longWordRatio * 100)}%`} />
              <Metric label="Adverbs (-ly)" value={`${Math.round(metrics.adverbRatio * 100)}%`} hint="lower often reads stronger" />
              <Metric label="Passive-voice hints" value={String(metrics.passiveHints)} />
            </div>
          )}
        </Card>
      </div>

      {hasText ? (
        <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
          <Card padding="md">
            <CardHeader title="Most-used words" description="Excludes common stop words" icon={<Wand2 className="size-4" />} />
            {top.length === 0 ? (
              <p className="text-subtle mt-3 text-xs italic">No repeated content words yet.</p>
            ) : (
              <ul className="mt-3 space-y-1.5">
                {top.map((entry) => (
                  <li key={entry.word} className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-ink">{entry.word}</span>
                    <span className="text-subtle tabular-nums">{entry.count}×</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card padding="md" className="flex min-h-[240px] flex-col">
            <CardHeader
              title="AI line-edit review"
              description={hasModels ? 'A qualitative critique from your chosen model' : 'Configure a model to enable AI review'}
              icon={<Sparkles className="size-4" />}
            />
            {hasModels ? (
              <>
                <div className="mt-3">
                  <Field label="Model (optional)" htmlFor="style-model">
                    <Select id="style-model" value={modelId} onChange={(e) => setModelId(e.target.value)}>
                      <option value="">Default model</option>
                      {models.map((model) => (
                        <option key={model.id} value={model.id} disabled={!model.enabled}>
                          {model.displayName} · {providers.find((p) => p.id === model.providerId)?.name ?? 'Unknown'}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    iconLeft={<Sparkles className="size-3.5" />}
                    onClick={runAiReview}
                    loading={assistance.generating}
                  >
                    Get AI review
                  </Button>
                  {assistance.generating ? (
                    <Button variant="ghost" size="sm" iconLeft={<Ban className="size-3.5" />} onClick={assistance.cancel}>
                      Stop
                    </Button>
                  ) : null}
                </div>
                <div className="border-line mt-3 min-h-0 flex-1 border-t pt-3">{renderAiBody()}</div>
              </>
            ) : (
              <p className="text-subtle mt-3 text-xs">
                The local metrics above work without AI. To get a qualitative critique, add a provider and model in
                Settings.
              </p>
            )}
          </Card>
        </div>
      ) : null}
    </div>
  );

  function renderAiBody() {
    if (assistance.status === 'generating') {
      return (
        <p className="text-subtle flex items-center gap-2 text-xs" role="status">
          <span className="bg-accent size-1.5 animate-pulse rounded-full" aria-hidden />
          Reviewing…
        </p>
      );
    }
    if (assistance.status === 'cancelled') {
      return <p className="text-subtle text-xs italic">Review cancelled.</p>;
    }
    if (assistance.status === 'error' && assistance.error) {
      const hint = 'hint' in assistance.error ? (assistance.error as { hint?: string }).hint : undefined;
      return (
        <div className="space-y-1">
          <p className="text-danger text-sm" role="alert">
            {assistance.error.message}
          </p>
          {hint ? <p className="text-subtle text-xs">{hint}</p> : null}
        </div>
      );
    }
    if (assistance.proposal) {
      return <div className="text-ink text-sm leading-7 whitespace-pre-wrap">{assistance.proposal.generatedText}</div>;
    }
    return <p className="text-subtle text-xs italic">Request an AI review for qualitative feedback on voice and clarity.</p>;
  }
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted text-xs">{label}</span>
      <span className="text-right">
        <span className="text-ink text-sm font-semibold tabular-nums">{value}</span>
        {hint ? <span className="text-subtle ml-1.5 text-2xs">{hint}</span> : null}
      </span>
    </div>
  );
}
