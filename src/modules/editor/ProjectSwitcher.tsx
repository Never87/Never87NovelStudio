import { useEffect, useRef, useState } from 'react';
import { ChevronDown, FolderKanban, Plus, Check } from 'lucide-react';
import { useProjects } from '@/hooks';
import { cn } from '@/utils/cn';

export interface ProjectSwitcherProps {
  currentProjectId: string;
  /** Called with the id of the project to open (existing or freshly created). */
  onSwitchProject: (projectId: string) => void;
  className?: string;
}

/**
 * Compact project selector with a lightweight "New Project" entry (item 3).
 *
 * Reuses the SAME `useProjects()` hook and `projectService.createProject` as the
 * rest of the app — there is no second creation flow. Creating a project asks
 * only for a title (everything else defaults), persists it, and immediately
 * switches to it so the manuscript workspace opens writable.
 */
export function ProjectSwitcher({ currentProjectId, onSwitchProject, className }: ProjectSwitcherProps) {
  const { projects, createProject } = useProjects();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const current = projects.find((project) => project.id === currentProjectId);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const submitCreate = async () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createProject({ title: trimmed });
      setCreating(false);
      setTitle('');
      setOpen(false);
      onSwitchProject(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create project.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="border-line bg-surface text-ink hover:bg-surface-muted inline-flex max-w-[12rem] items-center gap-1.5 rounded-md border px-2 py-1 text-xs"
      >
        <FolderKanban className="text-subtle size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{current?.title ?? 'Select project'}</span>
        <ChevronDown className="text-subtle size-3 shrink-0" aria-hidden />
      </button>

      {open ? (
        <div className="bg-surface shadow-[var(--n87-shadow-popover)] absolute left-0 top-9 z-40 w-64 overflow-hidden rounded-lg border border-line">
          <ul role="listbox" aria-label="Projects" className="max-h-64 overflow-y-auto py-1">
            {projects.map((project) => {
              const selected = project.id === currentProjectId;
              return (
                <li key={project.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      setOpen(false);
                      if (!selected) onSwitchProject(project.id);
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs',
                      selected ? 'bg-accent-soft text-accent-soft-text' : 'text-ink hover:bg-surface-muted',
                    )}
                  >
                    {selected ? <Check className="size-3 shrink-0" aria-hidden /> : <span className="size-3 shrink-0" />}
                    <span className="truncate">{project.title}</span>
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="border-line border-t p-2">
            {creating ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitCreate();
                }}
                className="space-y-1.5"
              >
                <label className="text-subtle text-2xs font-medium">New project title</label>
                <input
                  autoFocus
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="e.g. The Silent Tide"
                  className="border-line bg-surface text-ink focus:border-accent w-full rounded border px-2 py-1 text-xs outline-none"
                />
                {error ? <p className="text-danger text-2xs">{error}</p> : null}
                <div className="flex justify-end gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      setCreating(false);
                      setTitle('');
                      setError(null);
                    }}
                    className="text-muted hover:text-ink rounded px-2 py-1 text-2xs"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={busy || !title.trim()}
                    className="bg-accent hover:bg-accent-hover rounded px-2 py-1 text-2xs font-medium text-white disabled:opacity-50"
                  >
                    Create
                  </button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="text-accent-soft-text hover:bg-accent-soft inline-flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-2xs font-medium"
              >
                <Plus className="size-3.5" aria-hidden />
                New Project
              </button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
