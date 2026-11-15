/**
 * Blurb Generator page (P9 Batch D) — `/publishing/blurb-generator`.
 *
 * Drafts public back-cover copy from a project's premise, narrative spine, world
 * and characters. All generation runs through the shared P5 AI pipeline (task
 * `blurb`), and the result is a DRAFT the user edits freely. Saving writes ONLY
 * `NovelProject.blurb` — never the internal `description`.
 *
 * The panel makes explicit what the model is allowed to see: project title,
 * genre, tags, narrative summary and character one-liners. It never sends the
 * manuscript, internal notes or credentials.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Info,
  Loader2,
  Quote,
  RefreshCw,
  Save,
  Sparkles,
  Undo2,
} from 'lucide-react';
import { Badge, Button, Card, EmptyState, PageHeader } from '@/components/ui';
import { useAiConfig, useBlurb, useProjects } from '@/hooks';
import {
  BLURB_LENGTHS,
  BLURB_LENGTH_TARGETS,
  BLURB_STYLES,
  BLURB_STYLE_GUIDE,
  type BlurbLength,
  type BlurbStyle,
} from '@/modules/publishing/blurb/blurb-prompt';
import { AiError } from '@/services';

function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  // Approximate: runs of non-space. Good enough for a live counter.
  return trimmed.split(/\s+/).length;
}

function describeError(error: unknown): string {
  if (error instanceof AiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'The blurb could not be generated.';
}

export function BlurbGeneratorPage() {
  const { projects, initialLoading: projectsLoading, error: projectsError } = useProjects();
  const aiConfig = useAiConfig();

  const [projectId, setProjectId] = useState('');
  const effectiveProjectId = projectId || projects[0]?.id || '';
  const activeProject = useMemo(
    () => projects.find((p) => p.id === effectiveProjectId) ?? null,
    [projects, effectiveProjectId],
  );

  const blurb = useBlurb(effectiveProjectId || null);

  const [length, setLength] = useState<BlurbLength>('standard');
  const [style, setStyle] = useState<BlurbStyle>('balanced');
  const [extra, setExtra] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  // Clear transient success messages when the project changes.
  useEffect(() => {
    setMessage(null);
  }, [effectiveProjectId]);

  const handleGenerate = useCallback(async () => {
    setMessage(null);
    try {
      await blurb.generate({ length, style, ...(extra.trim() ? { extraInstruction: extra.trim() } : {}) });
    } catch {
      /* error surfaced through blurb.error */
    }
  }, [blurb, length, style, extra]);

  const handleCopy = useCallback(async () => {
    const ok = await blurb.copy();
    setMessage(ok ? 'Copied to clipboard.' : 'Copy failed — select and copy the text manually.');
  }, [blurb]);

  const handleSave = useCallback(async () => {
    try {
      await blurb.save();
      setMessage('Blurb saved to the project.');
    } catch {
      /* error surfaced through blurb.saveError */
    }
  }, [blurb]);

  const aiReady =
    aiConfig.status === 'success' &&
    (aiConfig.models.length > 0 || aiConfig.globalDefaultModelId !== null);
  const aiConfiguredUnknown = aiConfig.status === 'idle' || aiConfig.status === 'loading';

  const wordCount = countWords(blurb.draft);
  const target = BLURB_LENGTH_TARGETS[length];

  /* --------------------------- loading / empty -------------------------- */

  if (projectsLoading) {
    return (
      <div className="space-y-5">
        <PageHeader
          title="Blurb Generator"
          description="Draft and refine a back-cover blurb for a project."
          icon={<Quote className="size-4" aria-hidden />}
        />
        <Card padding="lg">
          <p className="text-subtle flex items-center gap-2 text-xs" role="status">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            Loading projects…
          </p>
        </Card>
      </div>
    );
  }

  if (projectsError) {
    return (
      <div className="space-y-5">
        <PageHeader title="Blurb Generator" description="Draft a back-cover blurb." icon={<Quote className="size-4" aria-hidden />} />
        <Card padding="md">
          <p className="text-danger flex items-center gap-1.5 text-xs" role="alert">
            <AlertTriangle className="size-3.5" aria-hidden />
            The project list could not be loaded.{' '}
            {projectsError instanceof Error ? projectsError.message : ''}
          </p>
        </Card>
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="space-y-5">
        <PageHeader title="Blurb Generator" description="Draft a back-cover blurb." icon={<Quote className="size-4" aria-hidden />} />
        <EmptyState
          icon={<Quote className="size-5" aria-hidden />}
          title="No projects to blurb"
          description="Create a project with a title and description first, then return here to generate a blurb."
        />
      </div>
    );
  }

  /* ------------------------------- render ------------------------------ */

  return (
    <div className="space-y-5">
      <PageHeader
        title="Blurb Generator"
        description="Draft a public back-cover blurb from your premise, world and characters. The draft is editable; saving writes only the project's public blurb, never its internal description."
        icon={<Quote className="size-4" aria-hidden />}
        actions={
          <div className="flex flex-col gap-1">
            <label htmlFor="blurb-project" className="text-subtle text-2xs font-medium uppercase tracking-wide">
              Project
            </label>
            <select
              id="blurb-project"
              data-testid="blurb-project"
              value={effectiveProjectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="border-line bg-surface text-ink rounded-md border px-2 py-1.5 text-xs"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </div>
        }
      />

      {!aiReady && !aiConfiguredUnknown ? (
        <Card padding="md">
          <p className="text-warning flex items-start gap-1.5 text-xs" role="status" data-testid="blurb-ai-warning">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            No AI model is configured. Add a provider and model in Settings, then assign one to the
            “Blurb generator” task (or set a global default) to enable generation.
          </p>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        {/* ---------------------- Controls column ---------------------- */}
        <Card padding="md" className="space-y-4" data-testid="blurb-controls">
          <div className="space-y-2">
            <p className="text-ink text-sm font-medium">Length</p>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Blurb length">
              {BLURB_LENGTHS.map((option) => {
                const meta = BLURB_LENGTH_TARGETS[option];
                const selected = length === option;
                return (
                  <button
                    key={option}
                    type="button"
                    data-testid={`blurb-length-${option}`}
                    onClick={() => setLength(option)}
                    aria-pressed={selected}
                    className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                      selected
                        ? 'border-accent bg-accent-soft text-ink'
                        : 'border-line text-muted hover:border-line-strong'
                    }`}
                    title={meta.description}
                  >
                    {meta.label}
                  </button>
                );
              })}
            </div>
            <p className="text-subtle text-2xs leading-relaxed">{target.description}</p>
          </div>

          <div className="space-y-2">
            <p className="text-ink text-sm font-medium">Angle</p>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Blurb style">
              {BLURB_STYLES.map((option) => {
                const meta = BLURB_STYLE_GUIDE[option];
                const selected = style === option;
                return (
                  <button
                    key={option}
                    type="button"
                    data-testid={`blurb-style-${option}`}
                    onClick={() => setStyle(option)}
                    aria-pressed={selected}
                    className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                      selected
                        ? 'border-accent bg-accent-soft text-ink'
                        : 'border-line text-muted hover:border-line-strong'
                    }`}
                  >
                    {meta.label}
                  </button>
                );
              })}
            </div>
            <p className="text-subtle text-2xs leading-relaxed">{BLURB_STYLE_GUIDE[style].emphasis}</p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="blurb-extra" className="text-ink text-sm font-medium">
              Extra instructions <span className="text-subtle text-2xs">(optional)</span>
            </label>
            <textarea
              id="blurb-extra"
              data-testid="blurb-extra"
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              rows={2}
              placeholder="e.g. Make it darker; target young-adult readers; keep it under 60 words."
              className="border-line bg-surface text-ink w-full resize-y rounded-md border px-2 py-1.5 text-xs leading-relaxed"
            />
          </div>

          <Button
            variant="primary"
            size="sm"
            className="w-full"
            iconLeft={
              blurb.generating ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : blurb.hasDraft ? (
                <RefreshCw className="size-3.5" />
              ) : (
                <Sparkles className="size-3.5" />
              )
            }
            onClick={() => void handleGenerate()}
            loading={blurb.generating}
            disabled={blurb.generating || !aiReady}
            data-testid="blurb-generate"
          >
            {blurb.generating ? 'Generating…' : blurb.hasDraft ? 'Regenerate' : 'Generate blurb'}
          </Button>
          {blurb.generating ? (
            <Button variant="ghost" size="sm" className="w-full" onClick={blurb.cancel} data-testid="blurb-cancel">
              Stop
            </Button>
          ) : null}

          <p className="text-subtle text-2xs leading-relaxed" data-testid="blurb-context-note">
            <Info className="mr-1 inline size-3 align-text-bottom" aria-hidden />
            Sends only the project title, genre, tags, narrative summary, world overview and
            character one-liners. Never the manuscript, notes or credentials.
          </p>
        </Card>

        {/* ------------------------ Draft column ----------------------- */}
        <Card padding="md" className="flex flex-col space-y-3" data-testid="blurb-draft-panel">
          <div className="flex items-center justify-between gap-2">
            <p className="text-ink text-sm font-medium">Draft</p>
            <div className="flex items-center gap-2">
              <span data-testid="blurb-wordcount">
                <Badge tone={wordCount === 0 ? 'neutral' : 'accent'} size="sm">
                  {wordCount} words
                </Badge>
              </span>
              {blurb.lastProposal ? (
                <span className="text-subtle text-2xs" data-testid="blurb-target-model">
                  {blurb.lastProposal.target.providerName} · {blurb.lastProposal.target.modelName}
                </span>
              ) : null}
            </div>
          </div>

          <textarea
            data-testid="blurb-textarea"
            value={blurb.draft}
            onChange={(e) => blurb.setDraft(e.target.value)}
            rows={12}
            placeholder="Your blurb draft will appear here. Generate one above, or write and edit it yourself."
            className="border-line bg-surface text-ink min-h-[220px] w-full flex-1 resize-y rounded-md border px-3 py-2 text-sm leading-relaxed"
          />

          {blurb.error ? (
            <p className="text-danger flex items-start gap-1.5 text-2xs" role="alert" data-testid="blurb-error">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {describeError(blurb.error)}
            </p>
          ) : null}

          {blurb.saveError ? (
            <p className="text-danger flex items-start gap-1.5 text-2xs" role="alert" data-testid="blurb-save-error">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              The blurb could not be saved. {blurb.saveError instanceof Error ? blurb.saveError.message : ''}
            </p>
          ) : null}

          {message ? (
            <p className="text-success flex items-center gap-1.5 text-2xs" role="status" data-testid="blurb-message">
              <Check className="size-3.5 shrink-0" aria-hidden />
              {message}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <Button
              variant="secondary"
              size="sm"
              iconLeft={<Copy className="size-3.5" />}
              onClick={() => void handleCopy()}
              disabled={!blurb.hasDraft}
              data-testid="blurb-copy"
            >
              Copy
            </Button>
            <Button
              variant="primary"
              size="sm"
              iconLeft={<Save className="size-3.5" />}
              onClick={() => void handleSave()}
              loading={blurb.saving}
              disabled={!blurb.hasDraft || !blurb.dirty || blurb.saving}
              data-testid="blurb-save"
            >
              Save to project
            </Button>
            {blurb.dirty ? (
              <Button
                variant="ghost"
                size="sm"
                iconLeft={<Undo2 className="size-3.5" />}
                onClick={blurb.discard}
                disabled={blurb.saving}
                data-testid="blurb-discard"
              >
                Discard changes
              </Button>
            ) : null}
          </div>

          {blurb.savedBlurb ? (
            <div className="border-line border-t pt-3" data-testid="blurb-saved">
              <div className="mb-1 flex items-center gap-2">
                <p className="text-subtle text-2xs font-medium uppercase tracking-wide">Saved blurb</p>
                {blurb.dirty ? <Badge tone="warning" size="sm">Unsaved changes</Badge> : null}
              </div>
              <p className="text-muted text-2xs leading-relaxed whitespace-pre-wrap">{blurb.savedBlurb}</p>
            </div>
          ) : null}
        </Card>
      </div>

      {activeProject ? (
        <p className="text-subtle text-2xs" data-testid="blurb-hint">
          Saving updates only <span className="text-muted">“{activeProject.title}”</span>'s public blurb for use in
          EPUB exports, the Portfolio and store listings. The internal description is never changed.
        </p>
      ) : null}
    </div>
  );
}
