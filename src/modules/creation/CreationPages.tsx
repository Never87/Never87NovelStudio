import { Clapperboard, Compass, Globe2, ListTree, PenLine, Users } from 'lucide-react';
import { WorldPanel } from '@/modules/world/WorldPanel';
import { CharactersPanel } from '@/modules/characters/CharactersPanel';
import { NarrativePanel } from '@/modules/narrative/NarrativePanel';
import { OutlinePanel } from '@/modules/outline/OutlinePanel';
import { WritingPanel } from '@/modules/editor/WritingPanel';
import { ScenesProsePanel } from '@/modules/editor/ScenesProsePanel';
import { ProjectScopedPage } from './ProjectScopedPage';

/**
 * Standalone Novel Creation pages (Round 1).
 *
 * Each wraps the SAME panel used by the project-detail tabs through
 * `ProjectScopedPage`, so a module reachable from the sidebar and from a
 * project's tabs shares one implementation and one data model.
 */

export function WorldBuildingPage() {
  return (
    <ProjectScopedPage
      icon={<Globe2 className="size-4" />}
      eyebrow="Novel Creation"
      title="World Building"
      description="Define the setting: sections (geography, factions, history, rules), themes and era."
    >
      {(projectId) => <WorldPanel projectId={projectId} />}
    </ProjectScopedPage>
  );
}

export function CharactersPage() {
  return (
    <ProjectScopedPage
      icon={<Users className="size-4" />}
      eyebrow="Novel Creation"
      title="Characters"
      description="Manage your cast: roles, traits, motivations and relationships."
    >
      {(projectId) => <CharactersPanel projectId={projectId} />}
    </ProjectScopedPage>
  );
}

export function NarrativePlanningPage() {
  return (
    <ProjectScopedPage
      icon={<Compass className="size-4" />}
      eyebrow="Novel Creation"
      title="Narrative Planning"
      description="Shape your story: premise, themes, plot beats and arc."
    >
      {(projectId) => <NarrativePanel projectId={projectId} />}
    </ProjectScopedPage>
  );
}

export function OutlinePage() {
  return (
    <ProjectScopedPage
      icon={<ListTree className="size-4" />}
      eyebrow="Novel Creation"
      title="Outline"
      description="Organise volumes and chapters, reorder them, and track chapter status."
    >
      {(projectId) => <OutlinePanel projectId={projectId} />}
    </ProjectScopedPage>
  );
}

export function SceneBuilderPage() {
  return (
    <ProjectScopedPage
      icon={<Clapperboard className="size-4" />}
      eyebrow="Novel Creation"
      title="Scene Builder"
      description="Plan and write scene-level prose, independent of chapter manuscripts."
    >
      {(projectId) => <ScenesProsePanel projectId={projectId} />}
    </ProjectScopedPage>
  );
}

export function StoryEditorPage() {
  return (
    <ProjectScopedPage
      icon={<PenLine className="size-4" />}
      eyebrow="Novel Creation"
      title="Story Editor"
      description="Write and autosave chapter manuscripts with version protection and AI tools."
    >
      {(projectId) => <WritingPanel projectId={projectId} />}
    </ProjectScopedPage>
  );
}
