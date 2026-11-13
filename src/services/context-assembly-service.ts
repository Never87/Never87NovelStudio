import type {
  AiMessage,
  AiTaskKind,
  Chapter,
  Character,
  ContextConfig,
  ContextItem,
  ContextLayer,
  ContextPriority,
  NarrativePlan,
  NovelProject,
  PromptTemplate,
  Scene,
  World,
} from '@/types';
import { PromptRepository } from '@/repositories/prompt-repository';
import { ProjectService } from './project-service';
import { WorldService } from './world-service';
import { NarrativeService } from './narrative-service';
import { CharacterService } from './character-service';
import { OutlineService } from './outline-service';
import { SceneService } from './scene-service';
import { ContextManagerService } from './context-manager-service';
import { AiService, type ResolvedAiTarget } from './ai-service';
import { estimateTokens } from './ai/token-estimator';
import { normalizeValues, renderTemplate } from './ai/prompt-render';
import { TASK_PROMPTS } from './ai/task-prompts';

/**
 * AI Context Manager — assembly & budgeting (P6).
 *
 * Turns the four-layer context model plus a rendered prompt template into ONE
 * logical request (`AssembledRequest`) that is:
 *   - shown verbatim in the preview, and
 *   - executed through the SAME P5 path via `AiAssistanceService.run({messages})`.
 *
 * Because preview and execution are produced by this single function, what the
 * user sees is what is sent (R5). No second prompt-building path exists.
 *
 * Layers (R3):
 *   1. base        — stable project facts (title, premise, theme, world summary).
 *   2. dynamic     — task-scoped facts (current chapter/scene, selection).
 *   3. retrieved   — user-selected project records (characters, outline, scenes…),
 *                    resolved LIVE so they can never be stale copies.
 *   4. instructions— persistent project instructions + per-request instructions.
 *
 * Budget (R4): the input budget is clamped to a KNOWN model context window when
 * one exists (`AiModel.contextWindowTokens` or the project override). We never
 * infer a context window from `maxTokens`. When the budget is unknown we still
 * report an estimate and (if a budget is enabled) trim to it. `required` items
 * and user instructions are never silently dropped: an overflow is surfaced.
 */

/* -------------------------------------------------------------------------- */
/* Public shapes                                                              */
/* -------------------------------------------------------------------------- */

/** A resolved context section as it appears in the final request. */
export interface AssembledSection {
  layer: ContextLayer;
  /** Stable key for dedupe/display (e.g. `base:narrative`, `retrieved:char:…`). */
  key: string;
  /** Human label for the preview. */
  label: string;
  /** Source kind, for icons/filters in the preview. */
  sourceType: string;
  priority: ContextPriority;
  /** The resolved text (could be reference content or user note). */
  content: string;
  /** Estimated tokens of `content`. */
  tokens: number;
  /** Whether this section was included after budgeting. */
  included: boolean;
  /** When trimmed, why. */
  trimmedReason?: 'budget' | 'disabled' | 'duplicate' | 'empty';
}

/** A detected overlap, conflict or duplication the user should know about. */
export interface ContextNotice {
  kind: 'duplicate' | 'overlap' | 'conflict' | 'overflow' | 'missing';
  message: string;
  /** Keys of the sections involved. */
  keys: string[];
}

/** The single logical request consumed by both preview and execution. */
export interface AssembledRequest {
  task: AiTaskKind;
  /** The template used (may be null when the task had no template). */
  templateId: string | null;
  templateName: string | null;
  /** Final messages, ready to send. */
  messages: AiMessage[];
  /** Every resolved section (included + trimmed) for the preview UI. */
  sections: AssembledSection[];
  /** Warnings: overlaps, conflicts, overflows, missing references. */
  notices: ContextNotice[];
  /** Token accounting (all ESTIMATES — see token-estimator.ts). */
  budget: {
    /** User-requested input budget, if budgeting is enabled. */
    requestedInputBudget: number | null;
    /** Effective input budget after clamping to a known model capacity. */
    effectiveInputBudget: number | null;
    /** Known model context window (input+output), if any. */
    modelContextWindow: number | null;
    /** Estimated input tokens actually used by the included sections + prompt. */
    estimatedInputTokens: number;
    /** Estimated tokens reserved for the output. */
    reservedOutputTokens: number;
    /** Whether the request fits within the effective budget/capacity. */
    fits: boolean;
    /** How the effective budget was derived, for the UI to explain it. */
    basis: 'user-budget' | 'model-window' | 'unknown';
  };
  /** Resolved target (provider/model) this request would run against. */
  target: ResolvedAiTarget | null;
}

export interface AssemblyInput {
  projectId: string;
  task: AiTaskKind;
  /** Variable values for the selected template (or built-in fallback). */
  values?: Record<string, unknown>;
  /** Per-request instruction appended to the instructions layer. */
  instruction?: string;
  /** Current chapter, when editing inside one (feeds dynamic layer). */
  chapterId?: string;
  /** Current scene, when editing inside one (feeds dynamic layer). */
  sceneId?: string;
  /** Explicit model override; used to resolve the target for capacity checks. */
  modelId?: string;
  /** Optional explicit template (otherwise the task default, then built-in). */
  templateId?: string;
}

/** Raised when assembly cannot produce a faithful request. */
export class ContextAssemblyError extends Error {
  readonly kind: 'config' | 'template' | 'render' | 'resolution';
  readonly cause?: unknown;
  constructor(kind: ContextAssemblyError['kind'], message: string, cause?: unknown) {
    super(message);
    this.name = 'ContextAssemblyError';
    this.kind = kind;
    this.cause = cause;
  }
}

/** Character cap for a single retrieved record, to avoid one table dominating context. */
const MAX_SECTION_CHARS = 8_000;

/**
 * Service that assembles the logical AI request.
 *
 * All dependencies are injected so the assembly can be unit-tested with fakes and
 * so it reads exclusively through the existing Services (R3).
 */
export class ContextAssemblyService {
  private readonly projectService: ProjectService;
  private readonly worldService: WorldService;
  private readonly narrativeService: NarrativeService;
  private readonly characterService: CharacterService;
  private readonly outlineService: OutlineService;
  private readonly sceneService: SceneService;
  private readonly contextManager: ContextManagerService;
  private readonly promptRepository: PromptRepository;
  private readonly aiService: AiService;

  constructor(deps: {
    projectService?: ProjectService;
    worldService?: WorldService;
    narrativeService?: NarrativeService;
    characterService?: CharacterService;
    outlineService?: OutlineService;
    sceneService?: SceneService;
    contextManager?: ContextManagerService;
    promptRepository?: PromptRepository;
    aiService?: AiService;
  } = {}) {
    this.projectService = deps.projectService ?? new ProjectService();
    this.worldService = deps.worldService ?? new WorldService();
    this.narrativeService = deps.narrativeService ?? new NarrativeService();
    this.characterService = deps.characterService ?? new CharacterService();
    this.outlineService = deps.outlineService ?? new OutlineService();
    this.sceneService = deps.sceneService ?? new SceneService();
    this.contextManager = deps.contextManager ?? new ContextManagerService();
    this.promptRepository = deps.promptRepository ?? new PromptRepository();
    this.aiService = deps.aiService ?? new AiService();
  }

  /**
   * Builds the single logical request for a task. Performs no network I/O.
   */
  async assemble(input: AssemblyInput): Promise<AssembledRequest> {
    const project = await this.projectService.getProject(input.projectId);
    if (!project) {
      throw new ContextAssemblyError('resolution', `Project "${input.projectId}" was not found.`);
    }

    const config = await this.contextManager.getConfig(input.projectId);
    const items = await this.contextManager.listItems(input.projectId);

    // Resolve the target first so capacity checks can use the real model window.
    let target: ResolvedAiTarget | null = null;
    let targetError: ContextAssemblyError | null = null;
    try {
      target = await this.aiService.resolveTarget(input.task, input.modelId);
    } catch (error) {
      // Assembly for PREVIEW must still work without a model (so the user can see
      // context and tokens); the error is surfaced as a notice, not a throw.
      targetError = new ContextAssemblyError('config', error instanceof Error ? error.message : 'No model resolved.', error);
    }

    const sections: AssembledSection[] = [];
    const notices: ContextNotice[] = [];

    // Resolve the prompt (template) separately from context sections.
    const { template, promptText, promptTokens } = await this.resolvePrompt(input, notices);

    // 1) BASE layer.
    if (config.enabledLayers.base) {
      sections.push(...(await this.resolveBaseLayer(project, notices)));
    }

    // 2) DYNAMIC layer.
    if (config.enabledLayers.dynamic) {
      sections.push(...(await this.resolveDynamicLayer(project, input, config, notices)));
    }

    // 3) RETRIEVED layer — only user-selected/persisted references.
    if (config.enabledLayers.retrieved) {
      sections.push(...(await this.resolveRetrievedLayer(project, items, notices)));
    }

    // 4) INSTRUCTIONS layer — persistent + item instructions + per-request.
    if (config.enabledLayers.instructions) {
      sections.push(...this.resolveInstructionsLayer(config, items, input.instruction));
    }

    // De-duplicate / detect overlaps BEFORE budgeting.
    const deduped = dedupeSections(sections, notices);

    // Budget: clamp to the user's budget AND a known model window, then trim.
    const budget = this.computeBudget(config, target);
    const trimmed = applyBudget(deduped, budget.effectiveInputBudget, promptTokens, notices);

    // Build final message list: system = instructions + base/dynamic/retrieved;
    // user = the rendered prompt (template). This keeps the prompt authoritative
    // and the context clearly delimited.
    const includedContext = trimmed.filter((section) => section.included && section.content.trim().length > 0);
    const contextBlock = formatContextBlock(includedContext);
    const messages: AiMessage[] = [];
    messages.push({ role: 'system', content: buildSystemMessage(project, config, contextBlock) });
    messages.push({ role: 'user', content: promptText });

    const estimatedInputTokens = promptTokens + includedContext.reduce((total, section) => total + section.tokens, 0) + estimateTokens(buildSystemMessage(project, config, ''));

    if (targetError) {
      notices.push({ kind: 'missing', message: targetError.message, keys: [] });
    }
    if (!budget.fits) {
      notices.push({
        kind: 'overflow',
        message: `Estimated input (~${estimatedInputTokens.toLocaleString()} tokens) exceeds the ${budget.basis === 'unknown' ? 'budget' : 'effective budget'} of ${budget.effectiveInputBudget?.toLocaleString() ?? '?'} tokens. Raise the budget or trim retrieved context.`,
        keys: [],
      });
    }

    return {
      task: input.task,
      templateId: template?.id ?? null,
      templateName: template?.name ?? null,
      messages,
      sections: trimmed,
      notices,
      budget: {
        ...budget,
        estimatedInputTokens,
        fits: budget.fits && estimatedInputTokens <= (budget.effectiveInputBudget ?? Number.POSITIVE_INFINITY),
      },
      target,
    };
  }

  /* ------------------------------ Prompt -------------------------------- */

  /**
   * Resolves the template for a task: explicit → task default → built-in
   * behaviour. Renders it STRICTLY against the supplied values.
   */
  private async resolvePrompt(
    input: AssemblyInput,
    notices: ContextNotice[],
  ): Promise<{ template: PromptTemplate | null; promptText: string; promptTokens: number }> {
    const templates = await this.promptRepository.listByProject(input.projectId);

    let template: PromptTemplate | null = null;
    if (input.templateId) {
      template = templates.find((candidate) => candidate.id === input.templateId) ?? null;
      if (!template) {
        notices.push({ kind: 'missing', message: `Template "${input.templateId}" was not found.`, keys: [] });
      }
    }
    if (!template) {
      template = templates.find((candidate) => candidate.taskKind === input.task && candidate.isDefault) ?? null;
    }
    if (!template) {
      template = templates.find((candidate) => candidate.taskKind === input.task && candidate.enabled) ?? null;
    }

    if (!template) {
      // No template in the project at all: fall back to the built-in P5 prompt
      // so AI keeps working before the user seeds/curates templates.
      const definition = TASK_PROMPTS[input.task];
      const values = normalizeValues(input.values ?? {});
      const built = definition.build({
        sourceText: values.sourceText ?? '',
        chapterTitle: values.chapterTitle,
        instruction: values.instruction,
      });
      const text = built.user;
      return { template: null, promptText: text, promptTokens: estimateTokens(built.system) + estimateTokens(text) };
    }

    if (!template.enabled) {
      notices.push({ kind: 'missing', message: `The template "${template.name}" is disabled.`, keys: [] });
    }

    try {
      const result = renderTemplate(template.content, template.variables, normalizeValues(input.values ?? {}));
      return { template, promptText: result.text, promptTokens: estimateTokens(result.text) };
    } catch (error) {
      throw new ContextAssemblyError('render', error instanceof Error ? error.message : 'Failed to render the template.', error);
    }
  }

  /* ------------------------------ Layers -------------------------------- */

  private async resolveBaseLayer(project: NovelProject, notices: ContextNotice[]): Promise<AssembledSection[]> {
    const out: AssembledSection[] = [];

    out.push(makeSection('base', 'base:project', 'Project', 'project', 'required',
      `Title: ${project.title}\nGenre: ${project.genre.join(', ') || '—'}\nDescription: ${project.description || '—'}`));

    try {
      const narrative = await this.narrativeService.getPlan(project.id);
      if (narrative) out.push(narrativeSection(narrative));
    } catch {
      notices.push({ kind: 'missing', message: 'The narrative plan could not be loaded and was omitted.', keys: ['base:narrative'] });
    }

    try {
      const world = await this.worldService.getWorld(project.id);
      if (world) out.push(worldSection(world));
    } catch {
      notices.push({ kind: 'missing', message: 'The world record could not be loaded and was omitted.', keys: ['base:world'] });
    }

    return out;
  }

  private async resolveDynamicLayer(
    project: NovelProject,
    input: AssemblyInput,
    _config: ContextConfig,
    notices: ContextNotice[],
  ): Promise<AssembledSection[]> {
    const out: AssembledSection[] = [];

    if (input.chapterId) {
      try {
        const chapter = await this.outlineService.getChapter(input.chapterId);
        if (chapter && chapter.projectId === project.id) {
          out.push(chapterSection(chapter));
        } else if (chapter) {
          notices.push({ kind: 'missing', message: `Chapter "${input.chapterId}" does not belong to this project.`, keys: ['dynamic:chapter'] });
        }
      } catch {
        notices.push({ kind: 'missing', message: 'The current chapter could not be loaded and was omitted.', keys: ['dynamic:chapter'] });
      }
    }

    if (input.sceneId) {
      try {
        const scene = await this.sceneService.getScene(input.sceneId);
        if (scene && scene.projectId === project.id) {
          out.push(sceneSection(scene));
        }
      } catch {
        notices.push({ kind: 'missing', message: 'The current scene could not be loaded and was omitted.', keys: ['dynamic:scene'] });
      }
    }

    return out;
  }

  private async resolveRetrievedLayer(
    project: NovelProject,
    items: ContextItem[],
    notices: ContextNotice[],
  ): Promise<AssembledSection[]> {
    const out: AssembledSection[] = [];
    const retrieved = items.filter((item) => item.layer === 'retrieved' && item.enabled);

    // Pre-resolve lists once so multiple referenced characters don't re-query.
    let characters: Character[] | null = null;

    for (const item of retrieved) {
      const base = {
        layer: 'retrieved' as const,
        key: `retrieved:${item.sourceType}:${item.sourceId ?? item.id}`,
        label: item.sourceLabel || titleForSource(item),
        sourceType: item.sourceType,
        priority: item.priority,
      };

      try {
        switch (item.sourceType) {
          case 'character': {
            if (!characters) characters = await this.characterService.listCharacters(project.id);
            const character = characters.find((candidate) => candidate.id === item.sourceId);
            if (!character) {
              notices.push({ kind: 'missing', message: `Referenced character "${item.sourceLabel || item.sourceId}" no longer exists.`, keys: [base.key] });
              out.push({ ...base, content: '', tokens: 0, included: false, trimmedReason: 'empty' });
              break;
            }
            out.push(makeSection('retrieved', base.key, character.name, 'character', item.priority, characterText(character)));
            break;
          }
          case 'chapter': {
            const chapter = await this.outlineService.getChapter(item.sourceId ?? '');
            if (!chapter || chapter.projectId !== project.id) {
              notices.push({ kind: 'missing', message: `Referenced chapter "${item.sourceLabel || item.sourceId}" no longer exists.`, keys: [base.key] });
              out.push({ ...base, content: '', tokens: 0, included: false, trimmedReason: 'empty' });
              break;
            }
            out.push(chapterSection(chapter, base.key));
            break;
          }
          case 'scene': {
            const scene = await this.sceneService.getScene(item.sourceId ?? '');
            if (!scene || scene.projectId !== project.id) {
              notices.push({ kind: 'missing', message: `Referenced scene "${item.sourceLabel || item.sourceId}" no longer exists.`, keys: [base.key] });
              out.push({ ...base, content: '', tokens: 0, included: false, trimmedReason: 'empty' });
              break;
            }
            out.push(sceneSection(scene, base.key));
            break;
          }
          case 'narrative':
          case 'world': {
            // These are 1:1, already covered by the base layer; including again
            // would duplicate. Surface an overlap instead of adding a copy.
            notices.push({ kind: 'duplicate', message: `"${base.label}" is already provided by the base layer.`, keys: [base.key] });
            break;
          }
          case 'note': {
            out.push(makeSection('retrieved', base.key, base.label, 'note', item.priority, item.content));
            break;
          }
          default: {
            // Unsupported/unsupplied sources (timeline, project) are reported.
            notices.push({ kind: 'missing', message: `Context source "${item.sourceType}" has no resolver yet and was skipped.`, keys: [base.key] });
          }
        }
      } catch {
        notices.push({ kind: 'missing', message: `"${base.label}" could not be resolved and was skipped.`, keys: [base.key] });
      }
    }

    return out;
  }

  private resolveInstructionsLayer(
    config: ContextConfig,
    items: ContextItem[],
    perRequest?: string,
  ): AssembledSection[] {
    const out: AssembledSection[] = [];

    if (config.persistentInstructions.trim()) {
      out.push(makeSection('instructions', 'instructions:persistent', 'Project instructions', 'instruction', 'required', config.persistentInstructions));
    }

    for (const item of items.filter((i) => i.layer === 'instructions' && i.enabled && i.content.trim())) {
      out.push(makeSection('instructions', `instructions:item:${item.id}`, item.sourceLabel || 'Instruction', 'instruction', item.priority, item.content));
    }

    if (perRequest && perRequest.trim()) {
      out.push(makeSection('instructions', 'instructions:request', 'This request', 'instruction', 'required', perRequest));
    }

    return out;
  }

  /* ------------------------------ Budget -------------------------------- */

  /**
   * Computes the effective input budget.
   *
   * R4: a model's `maxTokens` is an OUTPUT cap and is NEVER used as a context
   * window. The window comes only from `AiModel.contextWindowTokens` or the
   * project override. When neither is known we do not invent one.
   */
  private computeBudget(
    config: ContextConfig,
    target: ResolvedAiTarget | null,
  ): {
    requestedInputBudget: number | null;
    effectiveInputBudget: number | null;
    modelContextWindow: number | null;
    reservedOutputTokens: number;
    basis: 'user-budget' | 'model-window' | 'unknown';
    fits: boolean;
  } {
    const reservedOutputTokens = Math.max(0, config.requestedOutputTokens);
    const modelContextWindow =
      (target?.model.contextWindowTokens ?? null) || (config.contextWindowOverrideTokens ?? null);

    const requested = config.budgetEnabled ? config.inputBudgetTokens : null;

    let effective: number | null = requested;
    let basis: 'user-budget' | 'model-window' | 'unknown' = requested !== null ? 'user-budget' : 'unknown';

    if (modelContextWindow !== null) {
      // Input can use at most (window - reserved output). Never exceed it even
      // if the user asked for more — and never exceed the user budget either.
      const windowInputCap = Math.max(0, modelContextWindow - reservedOutputTokens);
      if (effective === null || effective > windowInputCap) {
        effective = windowInputCap;
        basis = 'model-window';
      }
    }

    return {
      requestedInputBudget: requested,
      effectiveInputBudget: effective,
      modelContextWindow,
      reservedOutputTokens,
      basis,
      // `fits` here only says a budget exists/shape is consistent; final token
      // check happens in `assemble` once content is known.
      fits: true,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Section builders                                                           */
/* -------------------------------------------------------------------------- */

function makeSection(
  layer: ContextLayer,
  key: string,
  label: string,
  sourceType: string,
  priority: ContextPriority,
  content: string,
): AssembledSection {
  const clipped = content.length > MAX_SECTION_CHARS ? `${content.slice(0, MAX_SECTION_CHARS)}\n…[truncated]` : content;
  return {
    layer,
    key,
    label,
    sourceType,
    priority,
    content: clipped,
    tokens: estimateTokens(clipped),
    included: true,
  };
}

function narrativeSection(plan: NarrativePlan): AssembledSection {
  const parts = [
    plan.logline ? `Logline: ${plan.logline}` : '',
    plan.theme ? `Theme: ${plan.theme}` : '',
    plan.premise ? `Premise: ${plan.premise}` : '',
    plan.centralConflict ? `Central conflict: ${plan.centralConflict}` : '',
    plan.stakes ? `Stakes: ${plan.stakes}` : '',
  ].filter(Boolean);
  return makeSection('base', 'base:narrative', 'Narrative plan', 'narrative', 'required', parts.join('\n'));
}

function worldSection(world: World): AssembledSection {
  const parts = [world.title, world.overview];
  for (const section of world.sections) parts.push(`${section.title}: ${section.content}`);
  return makeSection('base', 'base:world', 'World', 'world', 'normal', parts.filter(Boolean).join('\n'));
}

function characterText(character: Character): string {
  const parts = [
    `${character.name} — ${character.role}${character.summary ? `: ${character.summary}` : ''}`,
    character.background ? `Background: ${character.background}` : '',
    character.personality ? `Personality: ${character.personality}` : '',
    character.motivation ? `Motivation: ${character.motivation}` : '',
  ];
  return parts.filter(Boolean).join('\n');
}

function chapterSection(chapter: Chapter, key = 'dynamic:chapter'): AssembledSection {
  const parts = [
    `Chapter: ${chapter.title}`,
    chapter.summary ? `Summary: ${chapter.summary}` : '',
    chapter.goal ? `Goal: ${chapter.goal}` : '',
    chapter.keyEvents ? `Key events: ${chapter.keyEvents}` : '',
  ];
  return makeSection('dynamic', key, `Chapter — ${chapter.title}`, 'chapter', 'normal', parts.filter(Boolean).join('\n'));
}

function sceneSection(scene: Scene, key = 'dynamic:scene'): AssembledSection {
  const parts = [
    `Scene: ${scene.title}`,
    scene.location ? `Location: ${scene.location}` : '',
    scene.timeOfDay ? `Time: ${scene.timeOfDay}` : '',
    scene.goal ? `Goal: ${scene.goal}` : '',
    scene.conflict ? `Conflict: ${scene.conflict}` : '',
    scene.outcome ? `Outcome: ${scene.outcome}` : '',
  ];
  return makeSection('dynamic', key, `Scene — ${scene.title}`, 'scene', 'normal', parts.filter(Boolean).join('\n'));
}

function titleForSource(item: ContextItem): string {
  const label = item.sourceLabel?.trim();
  if (label) return label;
  return `${capitalize(item.sourceType)}${item.sourceId ? ` ${item.sourceId.slice(0, 8)}…` : ''}`;
}

function capitalize(value: string): string {
  return value.length > 0 ? value[0].toUpperCase() + value.slice(1) : value;
}

/* -------------------------------------------------------------------------- */
/* Dedupe & budget application                                                */
/* -------------------------------------------------------------------------- */

/**
 * Removes exact-duplicate sections and flags heavy overlaps.
 *
 * Two sections whose normalized content is identical are collapsed to one; when
 * content is only partially overlapping we keep both but add a notice so the
 * user understands potential redundancy (R3: "detect and avoid duplication").
 */
function dedupeSections(sections: AssembledSection[], notices: ContextNotice[]): AssembledSection[] {
  const byContent = new Map<string, AssembledSection>();
  const out: AssembledSection[] = [];

  for (const section of sections) {
    const normalized = normalizeForCompare(section.content);
    if (!normalized) {
      out.push({ ...section, included: false, trimmedReason: 'empty' });
      continue;
    }
    const existing = byContent.get(normalized);
    if (existing) {
      notices.push({ kind: 'duplicate', message: `"${section.label}" duplicates "${existing.label}" and was collapsed.`, keys: [existing.key, section.key] });
      out.push({ ...section, included: false, trimmedReason: 'duplicate' });
      continue;
    }
    byContent.set(normalized, section);
    out.push(section);
  }

  // Lightweight overlap detection for non-identical but clearly related content.
  const included = out.filter((section) => section.included);
  for (let i = 0; i < included.length; i += 1) {
    for (let j = i + 1; j < included.length; j += 1) {
      if (included[i].layer !== included[j].layer) continue;
      if (jaccard(included[i].content, included[j].content) >= 0.6) {
        notices.push({
          kind: 'overlap',
          message: `"${included[i].label}" and "${included[j].label}" overlap substantially; consider keeping one.`,
          keys: [included[i].key, included[j].key],
        });
      }
    }
  }

  return out;
}

/**
 * Applies the input budget by trimming low/normal priority sections first.
 *
 * `required` sections and all instructions are never trimmed. If the required
 * content alone overflows, the overflow notice is raised by the caller.
 */
function applyBudget(
  sections: AssembledSection[],
  budget: number | null,
  promptTokens: number,
  notices: ContextNotice[],
): AssembledSection[] {
  if (budget === null) return sections; // No budget enforced.

  // Required sections + instructions are protected.
  const isProtected = (section: AssembledSection) =>
    section.priority === 'required' || section.layer === 'instructions';

  const included = sections.filter((section) => section.included && section.content.trim().length > 0);
  let used = promptTokens + included.filter(isProtected).reduce((total, s) => total + s.tokens, 0);

  // Trim order: low, then normal. Required/instructions stay.
  const trimmable = included
    .filter((section) => !isProtected(section))
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || b.tokens - a.tokens);

  const trimmedKeys = new Set<string>();
  for (const section of trimmable) {
    if (used + section.tokens <= budget) {
      used += section.tokens;
      continue;
    }
    trimmedKeys.add(section.key);
    notices.push({
      kind: 'overflow',
      message: `"${section.label}" was trimmed to fit the ${budget.toLocaleString()}-token budget.`,
      keys: [section.key],
    });
  }

  return sections.map((section) =>
    trimmedKeys.has(section.key) ? { ...section, included: false, trimmedReason: 'budget' as const } : section,
  );
}

function priorityRank(priority: ContextPriority): number {
  return priority === 'low' ? 0 : priority === 'normal' ? 1 : 2;
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

function formatContextBlock(sections: AssembledSection[]): string {
  if (sections.length === 0) return '';
  const grouped = new Map<ContextLayer, AssembledSection[]>();
  for (const section of sections) {
    const list = grouped.get(section.layer) ?? [];
    list.push(section);
    grouped.set(section.layer, list);
  }
  const order: ContextLayer[] = ['base', 'dynamic', 'retrieved', 'instructions'];
  const titles: Record<ContextLayer, string> = {
    base: 'Story foundation',
    dynamic: 'Current context',
    retrieved: 'Reference material',
    instructions: 'Instructions',
  };
  const blocks: string[] = [];
  for (const layer of order) {
    const list = grouped.get(layer);
    if (!list || list.length === 0) continue;
    const body = list.map((section) => `### ${section.label}\n${section.content}`).join('\n\n');
    blocks.push(`## ${titles[layer]}\n${body}`);
  }
  return blocks.join('\n\n');
}

function buildSystemMessage(project: NovelProject, config: ContextConfig, contextBlock: string): string {
  const lines = [
    `You are a professional fiction-writing assistant working inside the novel editor for "${project.title}".`,
    'Match the established voice, tense and point of view. Treat the provided context as authoritative.',
    config.persistentInstructions.trim() ? `Project instructions: ${config.persistentInstructions.trim()}` : '',
    contextBlock ? `\nUse this context:\n\n${contextBlock}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

function normalizeForCompare(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Jaccard similarity over word sets, for overlap warnings. */
function jaccard(a: string, b: string): number {
  const setA = new Set(normalizeForCompare(a).split(' ').filter(Boolean));
  const setB = new Set(normalizeForCompare(b).split(' ').filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const word of setA) if (setB.has(word)) intersection += 1;
  return intersection / (setA.size + setB.size - intersection);
}
