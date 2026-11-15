/**
 * Blurb Generator service (P9 Batch D).
 *
 * Business layer between the Blurb Generator UI and the P5 AI pipeline. It:
 *
 *   1. loads the project and gathers its PUBLIC-SAFE context (title, genre,
 *      tags, narrative spine, world overview/themes, character names/roles/
 *      summaries) using the existing domain services;
 *   2. builds the request messages with the PURE `buildBlurbMessages` helper —
 *      the single place that decides what the model may see;
 *   3. runs the generation through the shared `AiService` (task `blurb`, so the
 *      user's Model Configuration applies) and returns a reviewable proposal.
 *
 * It NEVER sends manuscript prose, internal notes or credentials, and it NEVER
 * writes to the project — saving a blurb is an explicit, separate step the UI
 * performs through `ProjectService.updateProject({ blurb })`.
 */

import type { AiMessage } from '@/types';
import type { AiService, ResolvedAiTarget } from './ai-service';
import { ProjectService } from './project-service';
import { WorldService } from './world-service';
import { NarrativeService } from './narrative-service';
import { CharacterService } from './character-service';
import {
  buildBlurbMessages,
  hasUsableBlurbContext,
  type BlurbCharacterInput,
  type BlurbContext,
  type BlurbLength,
  type BlurbOptions,
  type BlurbStyle,
} from '@/modules/publishing/blurb/blurb-prompt';

/** Raised when a blurb cannot be produced for a business reason. */
export class BlurbServiceError extends Error {
  readonly code:
    | 'project-not-found'
    | 'empty-context'
    | 'generation-failed';

  constructor(code: BlurbServiceError['code'], message: string, cause?: unknown) {
    super(message);
    this.name = 'BlurbServiceError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }

  readonly cause?: unknown;
}

/** A generated blurb awaiting review. Never persisted by this service. */
export interface BlurbProposal {
  readonly generatedText: string;
  readonly length: BlurbLength;
  readonly style: BlurbStyle;
  /** Provider/model that produced it (display + audit). */
  readonly target: { providerName: string; modelName: string; modelId: string };
  readonly createdAt: number;
  readonly usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

export interface GenerateBlurbInput {
  readonly projectId: string;
  readonly length: BlurbLength;
  readonly style: BlurbStyle;
  readonly extraInstruction?: string;
  /** Optional explicit model override (otherwise task/global fallback). */
  readonly modelId?: string;
  readonly signal?: AbortSignal;
}

/** Dependencies (all default to the app singletons; injected in tests). */
export interface BlurbServiceDeps {
  readonly projectService?: ProjectService;
  readonly worldService?: WorldService;
  readonly narrativeService?: NarrativeService;
  readonly characterService?: CharacterService;
}

export class BlurbService {
  private readonly aiService: AiService;
  private readonly projectService: ProjectService;
  private readonly worldService: WorldService;
  private readonly narrativeService: NarrativeService;
  private readonly characterService: CharacterService;

  constructor(aiService: AiService, deps: BlurbServiceDeps = {}) {
    this.aiService = aiService;
    this.projectService = deps.projectService ?? new ProjectService();
    this.worldService = deps.worldService ?? new WorldService();
    this.narrativeService = deps.narrativeService ?? new NarrativeService();
    this.characterService = deps.characterService ?? new CharacterService();
  }

  /**
   * Gathers the PUBLIC-SAFE context for a project. Exposed so the UI can show
   * exactly what will be shared (and so it is directly testable). Never returns
   * manuscript text, notes or secrets.
   */
  async buildContext(projectId: string): Promise<BlurbContext> {
    const project = await this.projectService.getProject(projectId);
    if (!project) {
      throw new BlurbServiceError('project-not-found', `Project "${projectId}" was not found.`);
    }

    // Load the optional supporting material in parallel; a missing piece is fine.
    const [world, plan, characters] = await Promise.all([
      this.worldService.getWorld(projectId).catch(() => null),
      this.narrativeService.getPlan(projectId).catch(() => null),
      this.characterService.listCharacters(projectId).catch(() => []),
    ]);

    const charactersSafe: BlurbCharacterInput[] = characters.map((c) => ({
      name: c.name,
      role: humanizeRole(c.role),
      summary: c.summary,
    }));

    return {
      title: project.title,
      description: project.description,
      genre: project.genre,
      tags: project.tags,
      ...(plan?.logline ? { logline: plan.logline } : {}),
      ...(plan?.theme ? { theme: plan.theme } : {}),
      ...(plan?.premise ? { premise: plan.premise } : {}),
      ...(plan?.centralConflict ? { centralConflict: plan.centralConflict } : {}),
      ...(plan?.stakes ? { stakes: plan.stakes } : {}),
      ...(world?.overview ? { worldOverview: world.overview } : {}),
      ...(world && world.themes.length > 0 ? { worldThemes: world.themes } : {}),
      ...(charactersSafe.length > 0 ? { characters: charactersSafe } : {}),
    };
  }

  /** Generates a blurb proposal. Performs no persistence. */
  async generate(input: GenerateBlurbInput): Promise<BlurbProposal> {
    const context = await this.buildContext(input.projectId);
    if (!hasUsableBlurbContext(context)) {
      throw new BlurbServiceError(
        'empty-context',
        'Add a title and at least a short description or premise before generating a blurb.',
      );
    }

    const options: BlurbOptions = {
      length: input.length,
      style: input.style,
      ...(input.extraInstruction ? { extraInstruction: input.extraInstruction } : {}),
    };
    const promptMessages = buildBlurbMessages(context, options);
    const messages: AiMessage[] = promptMessages.map((m) => ({ role: m.role, content: m.content }));

    let result: Awaited<ReturnType<AiService['generate']>>;
    try {
      result = await this.aiService.generate({
        task: 'blurb',
        messages,
        ...(input.modelId ? { modelId: input.modelId } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      // Preserve the typed AI errors (config/model) so the UI can guide the user.
      throw error;
    }


    return this.toProposal(result.result.content, result.result.usage, input, result.target);
  }

  private toProposal(
    content: string,
    usage: BlurbProposal['usage'],
    input: GenerateBlurbInput,
    target: ResolvedAiTarget,
  ): BlurbProposal {
    return {
      generatedText: stripFences(content),
      length: input.length,
      style: input.style,
      target: {
        providerName: target.provider.name,
        modelName: target.model.displayName,
        modelId: target.model.modelId,
      },
      createdAt: Date.now(),

      ...(usage ? { usage } : {}),
    };
  }
}

/** Maps a raw character role enum to a readable label for the prompt. */
function humanizeRole(role: string | undefined): string | undefined {
  if (!role) return undefined;
  switch (role) {
    case 'protagonist':
      return 'protagonist';
    case 'antagonist':
      return 'antagonist';
    case 'supporting':
      return 'supporting character';
    case 'minor':
      return 'minor character';
    default:
      return role;
  }
}

/** Strips accidental wrapping code fences the model may add despite instructions. */
function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[a-zA-Z0-9]*\n([\s\S]*?)\n```$/.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

/** Re-exported for convenience so the UI does not import the pure module twice. */
export type { BlurbLength, BlurbStyle, BlurbContext } from '@/modules/publishing/blurb/blurb-prompt';
