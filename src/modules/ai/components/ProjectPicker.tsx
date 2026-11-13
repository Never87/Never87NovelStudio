import type { NovelProject } from '@/types';
import { Select } from './fields';

/**
 * Project selector shared by the workspace-level AI pages (P6).
 *
 * Prompt templates and context are PER PROJECT, but `/ai/prompt-templates` and
 * `/ai/context-manager` are workspace routes with no project in the URL. This
 * control lets the user pick which project's templates/context they are viewing.
 *
 * `onCreate` is rendered by the caller when there are no projects yet.
 */
export function ProjectPicker({
  projects,
  value,
  onChange,
  id = 'ai-project-picker',
}: {
  projects: NovelProject[];
  value: string;
  onChange: (projectId: string) => void;
  id?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-subtle text-2xs font-medium uppercase tracking-wide">
        Project
      </label>
      <Select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-w-48"
        disabled={projects.length === 0}
      >
        {projects.length === 0 ? <option value="">No projects</option> : null}
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.title}
          </option>
        ))}
      </Select>
    </div>
  );
}
