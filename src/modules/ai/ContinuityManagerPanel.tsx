import { useMemo, useState } from 'react';
import { Activity, Plus, Trash2, X } from 'lucide-react';
import { Badge, Button, Card, EmptyState, IconButton, PageHeader } from '@/components/ui';
import type { ContinuityFact, ContinuityPredicate, ContinuitySubjectType } from '@/types';
import { CONTINUITY_PREDICATES, CONTINUITY_SUBJECT_TYPES } from '@/types';
import { useCharacters, useContinuity, useOutline, useProjects } from '@/hooks';
import { Field, Select, TextInput } from './components/fields';
import { ProjectPicker } from './components/ProjectPicker';

const SUBJECT_LABELS: Record<ContinuitySubjectType, string> = {
  character: 'Character',
  item: 'Item',
  location: 'Location',
  faction: 'Faction',
  other: 'Other',
};

const PREDICATE_LABELS: Record<ContinuityPredicate, string> = {
  position: 'Position (where)',
  possession: 'Possession (holds)',
  knowledge: 'Knowledge (knows)',
  relationship: 'Relationship (relates to)',
  status: 'Status (alive/dead/…)',
  attribute: 'Attribute (other)',
};

/**
 * Continuity Manager (P7).
 *
 * Records event-sourced continuity facts anchored to a chapter/scene, and shows
 * the reconstructed state "as of" a chosen point in the story. State is always
 * recomputed against the LIVE outline order, so reordering chapters/scenes can
 * never silently make the reconstruction wrong. There is no mutable per-character
 * snapshot — the fact log is the single source of truth.
 */
export function ContinuityManagerPanel() {
  const { projects, initialLoading: projectsLoading } = useProjects();
  const [projectId, setProjectId] = useState('');
  const effectiveProjectId = projectId || projects[0]?.id || '';

  const continuity = useContinuity(effectiveProjectId);
  const outline = useOutline(effectiveProjectId);
  const characters = useCharacters(effectiveProjectId);

  const chapters = useMemo(() => outline.outline.flatMap((volume) => volume.chapters), [outline.outline]);

  const [showForm, setShowForm] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // "As of" reconstruction state.
  const [asOfChapterId, setAsOfChapterId] = useState('');
  const [asOfState, setAsOfState] = useState<Awaited<ReturnType<typeof continuity.stateAsOf>> | null>(null);
  const [asOfError, setAsOfError] = useState<string | null>(null);

  const reconstruct = async (chapterId: string) => {
    setAsOfChapterId(chapterId);
    setAsOfError(null);
    if (!chapterId) {
      setAsOfState(null);
      return;
    }
    try {
      setAsOfState(await continuity.stateAsOf(chapterId));
    } catch (error) {
      setAsOfState(null);
      setAsOfError(error instanceof Error ? error.message : String(error));
    }
  };

  const remove = async (fact: ContinuityFact) => {
    setActionError(null);
    try {
      await continuity.deleteFact(fact.id);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const chapterTitle = (id: string | null) => (id ? chapters.find((c) => c.id === id)?.title ?? id : '—');

  return (
    <div className="space-y-5">
      <PageHeader
        title="AI Continuity Manager"
        description="Track positions, possessions, knowledge and relationships across the story. State is reconstructed deterministically from the fact log — never a mutable snapshot."
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
          icon={<Activity className="size-5" aria-hidden />}
          title="No projects yet"
          description="Continuity is tracked per project. Create a project first."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
          <div className="space-y-4">
            <Card padding="md" className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-ink text-sm font-semibold">Continuity facts</h2>
                <Button variant="primary" size="sm" iconLeft={<Plus className="size-3.5" />} onClick={() => setShowForm(true)}>
                  Add fact
                </Button>
              </div>
              {actionError ? (
                <p className="text-danger text-2xs" role="alert">
                  {actionError}
                </p>
              ) : null}

              {showForm ? (
                <FactForm
                  characters={characters.characters.map((c) => ({ id: c.id, name: c.name }))}
                  chapters={chapters.map((c) => ({ id: c.id, title: c.title }))}
                  onCancel={() => setShowForm(false)}
                  onSubmit={async (input) => {
                    await continuity.createFact(input);
                    setShowForm(false);
                  }}
                />
              ) : null}

              {continuity.loading && continuity.facts.length === 0 ? (
                <p className="text-subtle text-xs" role="status">
                  Loading continuity facts…
                </p>
              ) : continuity.facts.length === 0 ? (
                <p className="text-subtle text-2xs italic">No continuity facts recorded yet.</p>
              ) : (
                <ul className="divide-line divide-y">
                  {continuity.facts.map((fact) => (
                    <li key={fact.id} className="flex items-center justify-between gap-2 py-1.5">
                      <div className="min-w-0">
                        <p className="text-ink truncate text-xs font-medium">
                          <span className="text-subtle">{PREDICATE_LABELS[fact.predicate]}:</span> {fact.subjectLabel || fact.subjectId} → “{fact.value}”
                        </p>
                        <p className="text-subtle text-2xs">
                          {SUBJECT_LABELS[fact.subjectType]} · @ {chapterTitle(fact.anchorChapterId)}
                          {fact.anchorSceneId ? ' (scene)' : ''}
                        </p>
                      </div>
                      <IconButton variant="ghost" size="sm" label="Delete fact" icon={<Trash2 className="size-3.5" aria-hidden />} onClick={() => void remove(fact)} />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <div className="space-y-4">
            <Card padding="md" className="space-y-3">
              <h2 className="text-ink text-sm font-semibold">Current state</h2>
              <p className="text-subtle text-2xs">Latest value per subject and predicate, reconstructed from the fact log.</p>
              <StateList state={continuity.currentState} />
            </Card>

            <Card padding="md" className="space-y-3">
              <h2 className="text-ink text-sm font-semibold">State as of a point</h2>
              <Field label="Reconstruct after chapter" htmlFor="cont-asof">
                <Select id="cont-asof" value={asOfChapterId} onChange={(event) => void reconstruct(event.target.value)}>
                  <option value="">Select a chapter…</option>
                  {chapters.map((chapter) => (
                    <option key={chapter.id} value={chapter.id}>
                      {chapter.title}
                    </option>
                  ))}
                </Select>
              </Field>
              {asOfError ? (
                <p className="text-danger text-2xs" role="alert">
                  {asOfError}
                </p>
              ) : null}
              {asOfState ? <StateList state={asOfState} /> : <p className="text-subtle text-2xs italic">Pick a chapter to reconstruct the state at that point.</p>}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function StateList({ state }: { state: Array<{ subjectType: ContinuitySubjectType; subjectId: string | null; subjectLabel: string; values: Array<{ predicate: ContinuityPredicate; value: string; relatedLabel: string }> }> }) {
  if (state.length === 0) {
    return <p className="text-subtle text-2xs italic">No state to show.</p>;
  }
  return (
    <ul className="space-y-2">
      {state.map((subject) => (
        <li key={`${subject.subjectType}:${subject.subjectId ?? subject.subjectLabel}`} className="rounded-md border border-line px-2 py-1.5">
          <div className="flex items-center gap-1.5">
            <Badge tone="info" size="sm">
              {SUBJECT_LABELS[subject.subjectType]}
            </Badge>
            <span className="text-ink truncate text-xs font-semibold">{subject.subjectLabel || subject.subjectId}</span>
          </div>
          <ul className="mt-1 space-y-0.5">
            {subject.values.map((value) => (
              <li key={value.predicate} className="text-subtle text-2xs">
                <span className="text-muted">{PREDICATE_LABELS[value.predicate].split(' ')[0]}:</span> {value.value}
                {value.relatedLabel ? ` (${value.relatedLabel})` : ''}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------------------------- */

function FactForm({
  characters,
  chapters,
  onCancel,
  onSubmit,
}: {
  characters: Array<{ id: string; name: string }>;
  chapters: Array<{ id: string; title: string }>;
  onCancel: () => void;
  onSubmit: (input: {
    subjectType: ContinuitySubjectType;
    subjectId?: string | null;
    subjectLabel?: string;
    predicate: ContinuityPredicate;
    value: string;
    relatedLabel?: string;
    anchorChapterId: string;
  }) => Promise<void>;
}) {
  const [subjectType, setSubjectType] = useState<ContinuitySubjectType>('character');
  const [subjectId, setSubjectId] = useState('');
  const [subjectLabel, setSubjectLabel] = useState('');
  const [predicate, setPredicate] = useState<ContinuityPredicate>('position');
  const [value, setValue] = useState('');
  const [relatedLabel, setRelatedLabel] = useState('');
  const [anchorChapterId, setAnchorChapterId] = useState(chapters[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!value.trim()) return setError('A value is required.');
    if (!anchorChapterId) return setError('Choose the chapter this fact becomes true in.');
    const chosen = characters.find((c) => c.id === subjectId);
    const label = subjectLabel.trim() || chosen?.name || '';
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        subjectType,
        subjectId: subjectType === 'character' && subjectId ? subjectId : null,
        subjectLabel: label,
        predicate,
        value: value.trim(),
        relatedLabel: relatedLabel.trim(),
        anchorChapterId,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-surface-muted/50 space-y-2 rounded-md p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-ink text-xs font-semibold">New continuity fact</h3>
        <IconButton variant="ghost" size="sm" label="Close" icon={<X className="size-3.5" aria-hidden />} onClick={onCancel} />
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Subject type" htmlFor="fact-subject-type">
          <Select id="fact-subject-type" value={subjectType} onChange={(event) => setSubjectType(event.target.value as ContinuitySubjectType)}>
            {CONTINUITY_SUBJECT_TYPES.map((type) => (
              <option key={type} value={type}>
                {SUBJECT_LABELS[type]}
              </option>
            ))}
          </Select>
        </Field>
        {subjectType === 'character' ? (
          <Field label="Character" htmlFor="fact-character">
            <Select id="fact-character" value={subjectId} onChange={(event) => setSubjectId(event.target.value)}>
              <option value="">(use label)</option>
              {characters.map((character) => (
                <option key={character.id} value={character.id}>
                  {character.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label="Subject label" htmlFor="fact-subject-label">
            <TextInput id="fact-subject-label" value={subjectLabel} onChange={(event) => setSubjectLabel(event.target.value)} placeholder="e.g. The Silver Key" />
          </Field>
        )}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Predicate" htmlFor="fact-predicate">
          <Select id="fact-predicate" value={predicate} onChange={(event) => setPredicate(event.target.value as ContinuityPredicate)}>
            {CONTINUITY_PREDICATES.map((p) => (
              <option key={p} value={p}>
                {PREDICATE_LABELS[p]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Value" htmlFor="fact-value" required>
          <TextInput id="fact-value" value={value} onChange={(event) => setValue(event.target.value)} placeholder="e.g. the harbour" />
        </Field>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Related (relationship only)" htmlFor="fact-related">
          <TextInput id="fact-related" value={relatedLabel} onChange={(event) => setRelatedLabel(event.target.value)} />
        </Field>
        <Field label="Becomes true at chapter" htmlFor="fact-chapter" required>
          <Select id="fact-chapter" value={anchorChapterId} onChange={(event) => setAnchorChapterId(event.target.value)}>
            <option value="">Select…</option>
            {chapters.map((chapter) => (
              <option key={chapter.id} value={chapter.id}>
                {chapter.title}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {error ? (
        <p className="text-danger text-2xs" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={() => void submit()} loading={saving}>
          Add fact
        </Button>
      </div>
    </div>
  );
}
