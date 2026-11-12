import { useMemo, useState } from 'react';
import {
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  TriangleAlert,
  Users,
  X,
} from 'lucide-react';
import { Badge, Button, Card } from '@/components/ui';
import type { Character, CharacterStatus } from '@/types';
import { useCharacters } from '@/hooks';
import type { CreateCharacterInput, UpdateCharacterInput } from '@/services';
import { ProjectDialog } from '@/modules/projects/components/ProjectDialog';
import { describeError } from '@/modules/projects/components/ProjectFormDialog';
import { CHARACTER_ROLE_META, CHARACTER_STATUS_META, characterInitials } from './character-meta';
import { CharacterFormDialog } from './components/CharacterFormDialog';

type StatusFilter = CharacterStatus | 'all';

/**
 * Characters section of the project detail page.
 *
 * Local search + status filter (in-memory) over the project's cast. States:
 * loading / error / empty / no-match / list. All data flows through
 * `useCharacters`, so a project can only ever see its own characters.
 */
export function CharactersPanel({ projectId }: { projectId: string }) {
  const {
    characters,
    initialLoading,
    loading,
    error,
    refresh,
    createCharacter,
    updateCharacter,
    deleteCharacter,
  } = useCharacters(projectId);

  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Character | null>(null);
  const [deleting, setDeleting] = useState<Character | null>(null);

  const normalizedQuery = query.trim().toLowerCase();

  const visible = useMemo(() => {
    return characters.filter((character) => {
      if (statusFilter !== 'all' && character.status !== statusFilter) return false;
      if (!normalizedQuery) return true;
      const haystack = [
        character.name,
        character.summary,
        character.personality,
        character.background,
        character.motivation,
        ...character.tags,
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [characters, statusFilter, normalizedQuery]);

  const hasCharacters = characters.length > 0;
  const isFiltering = normalizedQuery.length > 0 || statusFilter !== 'all';
  const noMatches = hasCharacters && visible.length === 0 && isFiltering;

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (character: Character) => {
    setEditing(character);
    setFormOpen(true);
  };

  const handleCreate = async (input: CreateCharacterInput | UpdateCharacterInput) => {
    await createCharacter(input as CreateCharacterInput);
  };

  const handleUpdate = async (input: CreateCharacterInput | UpdateCharacterInput) => {
    if (!editing) return;
    await updateCharacter(editing.id, input as UpdateCharacterInput);
  };

  if (initialLoading && loading) {
    return (
      <Card padding="lg">
        <div
          className="text-subtle flex items-center justify-center gap-2 py-8 text-xs"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Loading characters…
        </div>
      </Card>
    );
  }

  if (error) {
    const message = error instanceof Error ? error.message : String(error);
    const name = error instanceof Error ? error.name : 'Error';
    return (
      <Card padding="lg" className="flex flex-col items-center text-center" role="alert">
        <span className="bg-danger-soft text-danger grid size-10 place-items-center rounded-lg">
          <TriangleAlert className="size-5" aria-hidden />
        </span>
        <h3 className="text-ink mt-3 text-sm font-semibold">Couldn’t load characters</h3>
        <p className="text-muted mt-1 max-w-md text-xs">
          Something went wrong while reading this project’s cast. Your data has not been changed.
        </p>
        <pre className="bg-surface-muted text-subtle mt-3 max-h-24 w-full max-w-md overflow-auto rounded-md p-2 text-2xs whitespace-pre-wrap break-words">
          {name}: {message}
        </pre>
        <Button
          variant="primary"
          size="sm"
          className="mt-4"
          iconLeft={<RefreshCw className="size-3.5" />}
          onClick={() => void refresh()}
        >
          Retry
        </Button>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search
            className="text-subtle pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2"
            aria-hidden
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name, traits, tags…"
            aria-label="Search characters"
            className="bg-surface text-ink placeholder:text-subtle border-line h-9 w-full rounded-md border pr-8 pl-8 text-sm"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="text-subtle hover:text-ink absolute right-2 top-1/2 -translate-y-1/2"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          ) : null}
        </div>

        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
          aria-label="Filter by status"
          className="bg-surface text-ink border-line h-9 rounded-md border px-2 text-sm"
        >
          <option value="all">All statuses</option>
          {(Object.keys(CHARACTER_STATUS_META) as CharacterStatus[]).map((status) => (
            <option key={status} value={status}>
              {CHARACTER_STATUS_META[status].label}
            </option>
          ))}
        </select>

        <Button
          variant="primary"
          size="sm"
          iconLeft={<Plus className="size-3.5" />}
          onClick={openCreate}
          className="sm:ml-auto"
        >
          New character
        </Button>
      </div>

      {hasCharacters ? (
        <p className="text-subtle text-2xs">
          Showing {visible.length} of {characters.length}
          {isFiltering ? ' matching' : ''} character{characters.length === 1 ? '' : 's'}
          {loading ? ' · refreshing…' : ''}
        </p>
      ) : null}

      {!hasCharacters ? (
        <Card padding="lg" className="flex flex-col items-center text-center">
          <span className="bg-surface text-subtle mb-3 grid size-11 place-items-center rounded-lg border border-line">
            <Users className="size-5" aria-hidden />
          </span>
          <h3 className="text-ink text-sm font-semibold">No characters yet</h3>
          <p className="text-muted mt-1 max-w-md text-xs leading-relaxed">
            Add your cast to track personalities, backgrounds, motivations and roles.
          </p>
          <Button
            variant="primary"
            size="sm"
            className="mt-4"
            iconLeft={<Plus className="size-3.5" />}
            onClick={openCreate}
          >
            Create your first character
          </Button>
        </Card>
      ) : noMatches ? (
        <Card padding="lg" className="flex flex-col items-center text-center">
          <h3 className="text-ink text-sm font-semibold">No matching characters</h3>
          <p className="text-muted mt-1 max-w-md text-xs">
            No characters match your current search and filters.
          </p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-4"
            onClick={() => {
              setQuery('');
              setStatusFilter('all');
            }}
          >
            Clear filters
          </Button>
        </Card>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((character) => (
            <li key={character.id}>
              <CharacterCard
                character={character}
                onEdit={() => openEdit(character)}
                onDelete={() => setDeleting(character)}
              />
            </li>
          ))}
        </ul>
      )}

      <CharacterFormDialog
        open={formOpen && editing === null}
        onSubmit={handleCreate}
        onClose={() => setFormOpen(false)}
      />
      <CharacterFormDialog
        key={editing?.id ?? 'edit'}
        open={formOpen && editing !== null}
        initialCharacter={editing}
        onSubmit={handleUpdate}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
        }}
      />

      <ProjectDialog
        open={deleting !== null}
        title="Delete character?"
        description={deleting ? `“${deleting.name}” will be permanently removed.` : undefined}
        tone="danger"
        onClose={() => setDeleting(null)}
        footer={
          <DeleteCharacterFooter
            onCancel={() => setDeleting(null)}
            onConfirm={async () => {
              if (deleting) await deleteCharacter(deleting.id);
            }}
            onDone={() => setDeleting(null)}
          />
        }
      >
        <p className="text-muted text-xs">
          This removes the character profile from this project. It cannot be undone.
        </p>
      </ProjectDialog>
    </div>
  );
}

function CharacterCard({
  character,
  onEdit,
  onDelete,
}: {
  character: Character;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const roleMeta = CHARACTER_ROLE_META[character.role];
  const statusMeta = CHARACTER_STATUS_META[character.status];

  return (
    <Card padding="md" className="flex h-full flex-col">
      <div className="flex items-start gap-2.5">
        <span className="bg-accent-soft text-accent-soft-text grid size-9 shrink-0 place-items-center rounded-full text-xs font-semibold">
          {characterInitials(character.name)}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-ink truncate text-sm font-semibold">{character.name}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <Badge tone={roleMeta.tone} size="sm">
              {roleMeta.label}
            </Badge>
            <Badge tone={statusMeta.tone} size="sm" dot>
              {statusMeta.label}
            </Badge>
          </div>
        </div>
      </div>

      <p className="text-muted mt-2 line-clamp-3 min-h-[2.5rem] text-xs">
        {character.summary || character.personality || (
          <span className="text-subtle italic">No summary yet.</span>
        )}
      </p>

      {character.tags.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {character.tags.slice(0, 4).map((tag) => (
            <span
              key={tag}
              className="bg-surface-muted text-muted border-line inline-flex items-center rounded border px-1.5 py-0.5 text-2xs"
            >
              {tag}
            </span>
          ))}
        </div>
      ) : null}

      <div className="border-line mt-3 flex items-center justify-end gap-1.5 border-t pt-2.5">
        <Button
          variant="ghost"
          size="sm"
          iconLeft={<Pencil className="size-3.5" />}
          onClick={onEdit}
          aria-label={`Edit character ${character.name}`}
        >
          Edit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          iconLeft={<Trash2 className="size-3.5" />}
          onClick={onDelete}
          aria-label={`Delete character ${character.name}`}
        >
          Delete
        </Button>
      </div>
    </Card>
  );
}

/** Delete confirmation with its own in-flight / error state. */
function DeleteCharacterFooter({
  onCancel,
  onConfirm,
  onDone,
}: {
  onCancel: () => void;
  onConfirm: () => Promise<void>;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await onConfirm();
      onDone();
    } catch (error) {
      setFailure(describeError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex w-full flex-col gap-2">
      {failure ? (
        <p className="text-danger text-2xs" role="alert">
          {failure}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="danger" size="sm" loading={busy} onClick={() => void run()}>
          Delete character
        </Button>
      </div>
    </div>
  );
}
