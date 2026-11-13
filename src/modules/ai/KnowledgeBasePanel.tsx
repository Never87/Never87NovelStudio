import { useMemo, useState } from 'react';
import { BookOpen, Download, Plus, Search, Trash2, X } from 'lucide-react';
import { Badge, Button, Card, EmptyState, IconButton, PageHeader } from '@/components/ui';
import type { KnowledgeEntry, KnowledgeEntryKind } from '@/types';
import { KNOWLEDGE_ENTRY_KINDS } from '@/types';
import { useKnowledgeBase, useProjects } from '@/hooks';
import { Field, Select, TextArea, TextInput } from './components/fields';
import { ProjectPicker } from './components/ProjectPicker';

const KIND_LABELS: Record<KnowledgeEntryKind, string> = {
  character: 'Character',
  location: 'Location',
  faction: 'Faction',
  rule: 'Rule',
  event: 'Event',
  item: 'Item',
  concept: 'Concept',
  term: 'Term',
};

/**
 * Knowledge Base (P7).
 *
 * Browse, search, add, edit and delete knowledge entries, and index every
 * supported existing project entity in one click. Indexing is IDEMPOTENT — the
 * import reports how many entries were created vs. refreshed, and re-running
 * never duplicates. Every imported entry keeps a traceable source reference
 * (`source: <type>`) so the user can tell where it came from.
 */
export function KnowledgeBasePanel() {
  const { projects, initialLoading: projectsLoading } = useProjects();
  const [projectId, setProjectId] = useState('');
  const effectiveProjectId = projectId || projects[0]?.id || '';

  const knowledge = useKnowledgeBase(effectiveProjectId);

  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<KnowledgeEntryKind | ''>('');
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState<KnowledgeEntry | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const terms = normalized ? normalized.split(/\s+/).filter(Boolean) : [];
    return knowledge.entries.filter((entry) => {
      if (kindFilter && entry.kind !== kindFilter) return false;
      if (terms.length === 0) return true;
      const haystack = entry.searchText || `${entry.title} ${entry.summary} ${entry.body}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [knowledge.entries, query, kindFilter]);

  const runImport = async () => {
    setImportMessage(null);
    setActionError(null);
    try {
      const result = await knowledge.importFromProject();
      setImportMessage(
        `Indexed existing entities: ${result.imported} created, ${result.updated} refreshed, ${result.skipped} skipped` +
          (result.removed > 0 ? `, ${result.removed} stale removed (source deleted).` : '.'),
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const remove = async (entry: KnowledgeEntry) => {
    setActionError(null);
    try {
      await knowledge.deleteEntry(entry.id);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Knowledge Base"
        description="Search and organise the structured knowledge of your novel. Index existing entities in one click — every entry stays traceable to its source."
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
          icon={<BookOpen className="size-5" aria-hidden />}
          title="No projects yet"
          description="The Knowledge Base is per project. Create a project first."
        />
      ) : (
        <div className="space-y-4">
          <Card padding="md" className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-48 flex-1">
                <Search className="text-subtle pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" aria-hidden />
                <TextInput
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search entries…"
                  className="pl-7"
                  aria-label="Search knowledge entries"
                />
              </div>
              <Select
                value={kindFilter}
                onChange={(event) => setKindFilter(event.target.value as KnowledgeEntryKind | '')}
                aria-label="Filter by kind"
                className="min-w-36"
              >
                <option value="">All kinds</option>
                {KNOWLEDGE_ENTRY_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {KIND_LABELS[kind]}
                  </option>
                ))}
              </Select>
              <Button variant="secondary" size="sm" iconLeft={<Download className="size-3.5" />} onClick={() => void runImport()} loading={knowledge.importing}>
                Index project
              </Button>
              <Button variant="primary" size="sm" iconLeft={<Plus className="size-3.5" />} onClick={() => setShowCreate(true)}>
                New entry
              </Button>
            </div>

            {importMessage ? (
              <p className="text-success text-2xs" role="status">
                {importMessage}
              </p>
            ) : null}
            {actionError ? (
              <p className="text-danger text-2xs" role="alert">
                {actionError}
              </p>
            ) : null}
          </Card>

          {showCreate ? (
            <EntryForm
              projectId={effectiveProjectId}
              onCancel={() => setShowCreate(false)}
              onSubmit={async (input) => {
                await knowledge.createEntry(input);
                setShowCreate(false);
              }}
            />
          ) : null}

          {editing ? (
            <EntryForm
              projectId={effectiveProjectId}
              initial={editing}
              onCancel={() => setEditing(null)}
              onSubmit={async (input) => {
                await knowledge.updateEntry(editing.id, input);
                setEditing(null);
              }}
            />
          ) : null}

          {knowledge.loading && knowledge.entries.length === 0 ? (
            <Card padding="lg">
              <p className="text-subtle text-xs" role="status">
                Loading knowledge entries…
              </p>
            </Card>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={<BookOpen className="size-5" aria-hidden />}
              title={knowledge.entries.length === 0 ? 'Your knowledge base is empty' : 'No matching entries'}
              description={
                knowledge.entries.length === 0
                  ? 'Index existing characters, world, chapters and scenes in one click, or add an entry manually.'
                  : 'Try a different search term or kind filter.'
              }
            />
          ) : (
            <ul className="grid gap-2 md:grid-cols-2">
              {filtered.map((entry) => (
                <li key={entry.id}>
                  <EntryCard entry={entry} onEdit={() => setEditing(entry)} onDelete={() => void remove(entry)} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function EntryCard({ entry, onEdit, onDelete }: { entry: KnowledgeEntry; onEdit: () => void; onDelete: () => void }) {
  return (
    <Card padding="md" className="flex h-full flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <Badge tone="accent" size="sm">
              {KIND_LABELS[entry.kind]}
            </Badge>
            <Badge tone="neutral" size="sm">
              {entry.source}
            </Badge>
          </div>
          <h3 className="text-ink mt-1 truncate text-sm font-semibold">{entry.title}</h3>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onEdit}>
            Edit
          </Button>
          <IconButton variant="ghost" size="sm" label={`Delete ${entry.title}`} icon={<Trash2 className="size-3.5" aria-hidden />} onClick={onDelete} />
        </div>
      </div>
      {entry.summary ? <p className="text-muted line-clamp-3 text-xs">{entry.summary}</p> : null}
      {entry.tags.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {entry.tags.slice(0, 6).map((tag) => (
            <span key={tag} className="bg-surface-muted text-subtle rounded px-1.5 py-0.5 text-2xs">
              #{tag}
            </span>
          ))}
        </div>
      ) : null}
      {entry.sourceRef.entityId ? (
        <p className="text-subtle mt-auto text-2xs">
          Source: {entry.sourceRef.entityType} · <span className="font-mono">{entry.sourceRef.entityId}</span>
        </p>
      ) : null}
    </Card>
  );
}

/* -------------------------------------------------------------------------- */

function EntryForm({
  projectId,
  initial,
  onCancel,
  onSubmit,
}: {
  projectId: string;
  initial?: KnowledgeEntry;
  onCancel: () => void;
  onSubmit: (input: { kind: KnowledgeEntryKind; title: string; summary?: string; body?: string; tags?: string[] }) => Promise<void>;
}) {
  const [kind, setKind] = useState<KnowledgeEntryKind>(initial?.kind ?? 'concept');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [summary, setSummary] = useState(initial?.summary ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [tags, setTags] = useState((initial?.tags ?? []).join(', '));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!title.trim()) {
      setError('A title is required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        kind,
        title: title.trim(),
        summary: summary.trim(),
        body,
        tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card padding="md" className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-ink text-sm font-semibold">{initial ? 'Edit entry' : 'New entry'}</h2>
        <IconButton variant="ghost" size="sm" label="Close" icon={<X className="size-4" aria-hidden />} onClick={onCancel} />
      </div>
      <input type="hidden" value={projectId} readOnly />
      <div className="grid gap-2 sm:grid-cols-[160px_1fr]">
        <Field label="Kind" htmlFor="kb-kind">
          <Select id="kb-kind" value={kind} onChange={(event) => setKind(event.target.value as KnowledgeEntryKind)}>
            {KNOWLEDGE_ENTRY_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Title" htmlFor="kb-title" required>
          <TextInput id="kb-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. The Silver Key" />
        </Field>
      </div>
      <Field label="Summary" htmlFor="kb-summary" hint="One or two lines, shown in lists.">
        <TextInput id="kb-summary" value={summary} onChange={(event) => setSummary(event.target.value)} />
      </Field>
      <Field label="Body" htmlFor="kb-body">
        <TextArea id="kb-body" value={body} onChange={(event) => setBody(event.target.value)} className="min-h-[100px]" />
      </Field>
      <Field label="Tags" htmlFor="kb-tags" hint="Comma-separated.">
        <TextInput id="kb-tags" value={tags} onChange={(event) => setTags(event.target.value)} />
      </Field>
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
          {initial ? 'Save changes' : 'Create entry'}
        </Button>
      </div>
    </Card>
  );
}
