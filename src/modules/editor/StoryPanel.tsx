import { useState } from 'react';
import { Bot, Link2, ListChecks, Lightbulb, Sparkles, Plus, ScanSearch } from 'lucide-react';
import type { Editor } from '@tiptap/react';
import type { Chapter } from '@/types';
import { knowledgeService, continuityService, type CreateContinuityFactInput } from '@/services';
import { useChapterLinks } from '@/hooks';
import { EditorAiAssistant } from '@/modules/ai/EditorAiAssistant';
import { ChapterAnalysisTab } from './ChapterAnalysisTab';
import { Button } from '@/components/ui';
import { cn } from '@/utils/cn';

type StoryTab = 'ai' | 'links' | 'analyze' | 'continuity' | 'ideas';

const TABS: Array<{ id: StoryTab; label: string; icon: typeof Bot }> = [
  { id: 'ai', label: 'AI', icon: Bot },
  { id: 'links', label: 'Links', icon: Link2 },
  { id: 'analyze', label: 'Analyze', icon: ScanSearch },
  { id: 'continuity', label: 'Continuity', icon: ListChecks },
  { id: 'ideas', label: 'Ideas', icon: Lightbulb },
];

export interface StoryPanelProps {
  projectId: string;
  chapter: Chapter;
  prose: string;
  editor: Editor | null;
  chapterTitle: string;
  locked: boolean;
  /** Collapsed rail mode. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /**
   * Save-first gate for the Analyze tab: flushes the editor's pending autosave
   * and resolves ONLY when the latest prose is persisted (rejects with an
   * actionable error otherwise). Provided by the editing surface that owns the
   * live editor. When omitted (e.g. the read-only mobile rail that has no editor
   * instance), analysis cannot guarantee fresh prose and is disabled, so the
   * author is never shown results computed from stale text.
   */
  beforeAnalyze?: () => Promise<void>;
}

/**
 * Right-hand Story panel: AI assistant + story intelligence for the open
 * chapter. Everything here REUSES existing systems:
 *
 *   - AI     → the existing `EditorAiAssistant` (same safe apply path).
 *   - Links  → `useChapterLinks`, a read-only composition of outline/knowledge
 *              data giving a BIDIRECTIONAL view (chapter→entities and
 *              entity→chapters).
 *   - Continuity → `continuityService.stateAsOf` (the same event-sourced fold
 *              the Continuity manager uses), filtered to this chapter.
 *   - Ideas  → quick capture into the EXISTING Knowledge Base / Continuity log
 *              (no new store), tied to the current chapter as evidence/anchors.
 */
export function StoryPanel({
  projectId,
  chapter,
  prose,
  editor,
  chapterTitle,
  locked,
  collapsed,
  onToggleCollapsed,
  beforeAnalyze,
}: StoryPanelProps) {
  const [tab, setTab] = useState<StoryTab>('ai');

  if (collapsed) {
    return (
      <div className="flex h-full flex-col items-center gap-1 py-2">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            aria-label={`Open ${label}`}
            title={label}
            onClick={() => {
              onToggleCollapsed?.();
              setTab(id);
            }}
            className="text-muted hover:bg-surface-muted hover:text-ink grid size-8 place-items-center rounded-md"
          >
            <Icon className="size-4" aria-hidden />
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div role="tablist" aria-label="Story panel" className="border-line flex shrink-0 items-center gap-0.5 border-b px-1.5 py-1.5">
        {TABS.map(({ id, label, icon: Icon }) => {
          const selected = tab === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setTab(id)}
              className={cn(
                'inline-flex flex-1 items-center justify-center gap-1 rounded-md px-1.5 py-1 text-2xs font-medium transition-colors',
                selected ? 'bg-accent-soft text-accent-soft-text' : 'text-muted hover:bg-surface-muted hover:text-ink',
              )}
            >
              <Icon className="size-3.5" aria-hidden />
              {label}
            </button>
          );
        })}
      </div>

      <div className="n87-scroll-fade min-h-0 flex-1 overflow-y-auto p-2.5">
        {tab === 'ai' ? (
          <EditorAiAssistant editor={editor} chapterTitle={chapterTitle} locked={locked} />
        ) : tab === 'links' ? (
          <LinksTab projectId={projectId} chapter={chapter} prose={prose} />
        ) : tab === 'analyze' ? (
          <ChapterAnalysisTab projectId={projectId} chapter={chapter} prose={prose} beforeAnalyze={beforeAnalyze} />
        ) : tab === 'continuity' ? (
          <ContinuityTab projectId={projectId} chapter={chapter} prose={prose} />
        ) : (
          <IdeasTab projectId={projectId} chapter={chapter} />
        )}
      </div>
    </div>
  );
}

/* --------------------------------- Links --------------------------------- */

function LinksTab({ projectId, chapter, prose }: { projectId: string; chapter: Chapter; prose: string }) {
  const { links, loading } = useChapterLinks(projectId, chapter, prose);

  if (loading && !links) {
    return <p className="text-subtle text-2xs" role="status">Finding links…</p>;
  }
  if (!links) return <p className="text-subtle text-2xs">No links yet.</p>;

  const total = links.linkedCharacters.length + links.evidenceEntries.length + links.mentionedEntries.length;

  return (
    <div className="space-y-3 text-xs">
      <p className="text-subtle text-2xs leading-relaxed">
        Two-way connections between this chapter and your story entities. Click a character to see
        every chapter it appears in.
      </p>

      <Section title="Characters in this chapter" count={links.linkedCharacters.length}>
        {links.linkedCharacters.length === 0 ? (
          <Empty text="No characters linked via the outline." />
        ) : (
          <div className="flex flex-wrap gap-1">
            {links.linkedCharacters.map((character) => {
              const appearances = links.characterAppearances.find((row) => row.character.id === character.id);
              return (
                <span
                  key={character.id}
                  title={appearances ? `Appears in: ${appearances.chapterTitles.join(', ')}` : character.name}
                  className="bg-surface-muted text-ink border-line inline-flex items-center rounded border px-1.5 py-0.5 text-2xs"
                >
                  {character.name}
                  {appearances && appearances.chapterTitles.length > 1 ? (
                    <span className="text-subtle ml-1 tabular-nums">·{appearances.chapterTitles.length}</span>
                  ) : null}
                </span>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="Mentioned in the prose" count={links.mentionedEntries.length}>
        {links.mentionedEntries.length === 0 ? (
          <Empty text="No known entities mentioned in the text." />
        ) : (
          <ul className="space-y-1">
            {links.mentionedEntries.slice(0, 12).map(({ entry, mentions }) => (
              <li key={entry.id} className="flex items-center justify-between gap-2">
                <span className="text-ink truncate">{entry.title}</span>
                <span className="text-subtle shrink-0 text-2xs tabular-nums">{mentions}×</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Cited by evidence" count={links.evidenceEntries.length}>
        {links.evidenceEntries.length === 0 ? (
          <Empty text="No knowledge evidence points at this chapter." />
        ) : (
          <ul className="space-y-1">
            {links.evidenceEntries.map((entry) => (
              <li key={entry.id} className="text-ink truncate">{entry.title}</li>
            ))}
          </ul>
        )}
      </Section>

      {total === 0 ? (
        <p className="text-subtle text-2xs italic">
          Attach characters in the Outline, or mention them in your prose, to populate links.
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------- Continuity ------------------------------ */

function ContinuityTab({ projectId, chapter, prose }: { projectId: string; chapter: Chapter; prose: string }) {
  const { links, loading, refresh } = useChapterLinks(projectId, chapter, prose);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const state = links?.continuityState ?? [];

  // A light consistency hint: a subject mentioned in prose that has NO recorded
  // continuity state up to this chapter. This is advisory only — it opens no
  // modal and never blocks writing.
  const stateLabels = new Set(state.map((s) => s.subjectLabel.toLowerCase()).filter(Boolean));
  const unstatedMentions = (links?.mentionedEntries ?? [])
    .filter((m) => m.entry.kind === 'character')
    .filter((m) => !stateLabels.has(m.entry.title.toLowerCase()))
    .slice(0, 6);

  const addFact = async () => {
    const label = target.trim();
    if (!label) return;
    setBusy(true);
    setError(null);
    try {
      const input: CreateContinuityFactInput = {
        subjectType: 'character',
        subjectLabel: label,
        predicate: 'status',
        value: 'introduced',
        anchorChapterId: chapter.id,
        evidence: [{ chapterId: chapter.id, sceneId: null, quote: '', offset: null, note: 'Captured from editor' }],
      };
      await continuityService.createFact(projectId, input);
      setTarget('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record fact.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 text-xs">
      <p className="text-subtle text-2xs leading-relaxed">
        Continuity state as of this chapter (reconstructed from all facts up to and including it).
      </p>

      {loading && !links ? (
        <p className="text-subtle text-2xs" role="status">Reconstructing state…</p>
      ) : state.length === 0 ? (
        <Empty text="No continuity facts recorded up to this chapter." />
      ) : (
        <ul className="space-y-1.5">
          {state.map((subject) => (
            <li key={`${subject.subjectType}:${subject.subjectId ?? subject.subjectLabel}`} className="rounded-md border border-line p-1.5">
              <p className="text-ink text-2xs font-semibold">
                {subject.subjectLabel || subject.subjectId || subject.subjectType}
                <span className="text-subtle ml-1 font-normal">{subject.subjectType}</span>
              </p>
              <ul className="mt-0.5 space-y-0.5">
                {subject.values.map((value) => (
                  <li key={value.predicate} className="text-muted text-2xs">
                    <span className="text-subtle">{value.predicate}:</span> {value.value}
                    {value.relatedLabel ? <span className="text-subtle"> ({value.relatedLabel})</span> : null}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {unstatedMentions.length > 0 ? (
        <div className="rounded-md border border-warning/40 bg-warning-soft/50 p-1.5">
          <p className="text-2xs font-medium text-warning">Not yet in continuity</p>
          <p className="text-subtle mt-0.5 text-2xs">
            Mentioned in prose but with no recorded state: {unstatedMentions.map((m) => m.entry.title).join(', ')}.
          </p>
        </div>
      ) : null}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void addFact();
        }}
        className="border-line space-y-1 border-t pt-2"
      >
        <label className="text-subtle text-2xs font-medium">Record a fact at this chapter</label>
        <div className="flex gap-1">
          <input
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            placeholder="Subject (e.g. Elara)"
            className="border-line bg-surface text-ink focus:border-accent min-w-0 flex-1 rounded border px-2 py-1 text-xs outline-none"
          />
          <Button type="submit" size="sm" variant="secondary" loading={busy} disabled={!target.trim()}>
            Add
          </Button>
        </div>
        {error ? <p className="text-danger text-2xs">{error}</p> : null}
      </form>
    </div>
  );
}

/* --------------------------------- Ideas --------------------------------- */

function IdeasTab({ projectId, chapter }: { projectId: string; chapter: Chapter }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const title = text.trim();
    if (!title) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      await knowledgeService.createEntry(projectId, {
        kind: 'concept',
        title: title.length > 200 ? title.slice(0, 200) : title,
        summary: '',
        body: '',
        tags: ['idea', 'inbox'],
        evidence: [{ chapterId: chapter.id, sceneId: null, quote: '', offset: null, note: 'Captured while writing' }],
      });
      setText('');
      setSaved('Saved to your Knowledge Base.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save idea.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 text-xs">
      <p className="text-subtle text-2xs leading-relaxed">
        Park an idea without leaving the page. It is saved to your Knowledge Base (tagged{' '}
        <code className="bg-surface-muted rounded px-1">idea</code>) and linked to this chapter.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        className="space-y-1.5"
      >
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={4}
          placeholder="A twist, a line, a scene that just came to you…"
          className="border-line bg-surface text-ink focus:border-accent w-full resize-y rounded border px-2 py-1.5 text-xs outline-none"
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-subtle text-2xs">{text.trim().length} chars</span>
          <Button type="submit" size="sm" iconLeft={<Plus className="size-3.5" />} loading={busy} disabled={!text.trim()}>
            Capture idea
          </Button>
        </div>
      </form>
      {saved ? <p className="text-success inline-flex items-center gap-1 text-2xs"><Sparkles className="size-3" aria-hidden />{saved}</p> : null}
      {error ? <p className="text-danger text-2xs">{error}</p> : null}
    </div>
  );
}

/* ------------------------------- helpers --------------------------------- */

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <h4 className="text-subtle text-2xs font-medium uppercase tracking-wide">{title}</h4>
        <span className="text-subtle text-2xs tabular-nums">{count}</span>
      </div>
      {children}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="text-subtle text-2xs italic">{text}</p>;
}
