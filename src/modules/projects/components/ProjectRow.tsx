import { Link } from 'react-router-dom';
import { Pencil, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui';
import type { NovelProject } from '@/types';
import { formatDate, projectInitials, PROJECT_STATUS_META } from '../project-meta';

export interface ProjectRowProps {
  project: NovelProject;
  /** Opens the edit dialog. Omitted => no Edit control (e.g. Recent Projects). */
  onEdit?: (project: NovelProject) => void;
  /** Opens the delete dialog. Omitted => no Delete control. */
  onDelete?: (project: NovelProject) => void;
}

/**
 * One project, rendered as a responsive card row.
 *
 * Interaction structure is deliberately FLAT — no nested interactive elements:
 * - The title is a `<Link>` to `/projects/:projectId` (keyboard-enterable).
 * - Edit / Delete are real `<button>`s that are SIBLINGS of the link, not
 *   inside it, so activating them can never trigger navigation.
 * - No `aria-label` wraps the whole content, so a screen reader still reads the
 *   title, status, dates and tags. Each action button carries its own explicit
 *   `aria-label` naming the project.
 *
 * Omit `onEdit`/`onDelete` on lists that should not offer those actions (e.g.
 * Recent Projects), and the controls simply do not render.
 *
 * Narrow screens wrap meta and tags; actions stay in a fixed-width column, so
 * the row never produces horizontal overflow.
 */
export function ProjectRow({ project, onEdit, onDelete }: ProjectRowProps) {
  const status = PROJECT_STATUS_META[project.status];
  const tags = project.tags.slice(0, 6);
  const extraTags = project.tags.length - tags.length;
  const hasActions = Boolean(onEdit || onDelete);

  return (
    <article className="hover:bg-surface-muted/50 flex items-start gap-3 px-4 py-3 transition-colors">
      <span
        aria-hidden
        className="bg-accent-soft text-accent-soft-text grid size-9 shrink-0 place-items-center rounded-md text-xs font-semibold"
      >
        {projectInitials(project.title)}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="text-ink min-w-0 truncate text-sm font-medium">
            <Link
              to={`/projects/${project.id}`}
              className="focus-visible:outline-accent-ring rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              {project.title}
            </Link>
          </h3>
          <Badge tone={status.tone} size="sm" dot>
            {status.label}
          </Badge>
        </div>

        {project.description ? (
          <p className="text-muted mt-0.5 line-clamp-2 text-xs">{project.description}</p>
        ) : (
          <p className="text-subtle mt-0.5 text-xs italic">No description</p>
        )}

        <div className="text-subtle mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs">
          {project.genre.length > 0 ? (
            <span className="text-muted">{project.genre.join(' · ')}</span>
          ) : null}
          <span>Created {formatDate(project.createdAt)}</span>
          <span>Updated {formatDate(project.updatedAt)}</span>
          {project.targetWordCount !== undefined ? (
            <span>Target {project.targetWordCount.toLocaleString()} words</span>
          ) : null}
        </div>

        {tags.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {tags.map((tag) => (
              <span
                key={tag}
                className="bg-surface-muted text-muted border-line inline-flex items-center rounded border px-1.5 py-0.5 text-2xs"
              >
                {tag}
              </span>
            ))}
            {extraTags > 0 ? (
              <span className="text-subtle text-2xs">+{extraTags} more</span>
            ) : null}
          </div>
        ) : null}
      </div>

      {hasActions ? (
        <div className="flex shrink-0 items-center gap-1">
          {onEdit ? (
            <button
              type="button"
              onClick={() => onEdit(project)}
              aria-label={`Edit project ${project.title}`}
              className="text-muted hover:bg-surface-muted hover:text-ink focus-visible:outline-accent-ring grid size-8 place-items-center rounded-md transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2"
            >
              <Pencil aria-hidden className="size-4" />
            </button>
          ) : null}
          {onDelete ? (
            <button
              type="button"
              onClick={() => onDelete(project)}
              aria-label={`Delete project ${project.title}`}
              className="text-muted hover:bg-danger-soft hover:text-danger focus-visible:outline-accent-ring grid size-8 place-items-center rounded-md transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2"
            >
              <Trash2 aria-hidden className="size-4" />
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

