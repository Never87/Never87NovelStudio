/**
 * Blurb Generator — PURE prompt/context construction (P9 Batch D).
 *
 * This module is the single, dependency-free brain of the Blurb Generator. It
 * turns a project's PUBLIC-FACING metadata into the messages sent to the model,
 * so the rules for "what may the model see" live in exactly one testable place.
 *
 * ## What the model is allowed to see (and what it never sees)
 *
 * Only material a reader is meant to know:
 *   - the project title and its INTERNAL `description` (used as premise source),
 *   - genre + tags,
 *   - the narrative plan's public spine (logline, theme, premise, central
 *     conflict, stakes),
 *   - the world's overview + themes,
 *   - character NAME, ROLE and one-line SUMMARY.
 *
 * It NEVER receives: manuscript chapter/scene prose, internal notes, snapshots,
 * API keys, provider credentials or any other secret. The builder only reads the
 * explicitly-whitelisted fields below — there is no "dump the whole project"
 * path — so a future field cannot leak in by accident.
 *
 * The module performs no I/O and imports nothing at runtime, which lets the
 * verification harness bundle and unit-test it directly.
 */

/** How long the generated blurb should be. */
export type BlurbLength = 'short' | 'standard' | 'long';

/** The creative angle the model should emphasise. */
export type BlurbStyle = 'suspense' | 'character' | 'world' | 'balanced';

/** A single character fact safe to show a model (no notes, no manuscript). */
export interface BlurbCharacterInput {
  readonly name: string;
  readonly role?: string;
  readonly summary?: string;
}

/**
 * The PUBLIC-safe project context fed to the model.
 *
 * Every field here is derived from data a reader would legitimately see. Fields
 * are optional so a sparse project still produces a usable prompt (e.g. only a
 * title + description).
 */
export interface BlurbContext {
  readonly title: string;
  /** Internal project summary — the author's premise, used as source material. */
  readonly description?: string;
  readonly genre: readonly string[];
  readonly tags: readonly string[];
  /** Narrative plan public spine (never the full beat sheet). */
  readonly logline?: string;
  readonly theme?: string;
  readonly premise?: string;
  readonly centralConflict?: string;
  readonly stakes?: string;
  /** World overview + themes (never internal rules/notes). */
  readonly worldOverview?: string;
  readonly worldThemes?: readonly string[];
  readonly characters?: readonly BlurbCharacterInput[];
}

/** User-tunable generation options. */
export interface BlurbOptions {
  readonly length: BlurbLength;
  readonly style: BlurbStyle;
  /** Optional extra instruction from the user (e.g. "make it darker"). */
  readonly extraInstruction?: string;
}

/** A single message ready to send (mirrors the AI layer's shape). */
export interface BlurbMessage {
  readonly role: 'system' | 'user';
  readonly content: string;
}

/** Target word ranges per length preset (guidance for the model + UI copy). */
export const BLURB_LENGTH_TARGETS: Record<BlurbLength, { readonly min: number; readonly max: number; readonly label: string; readonly description: string }> = {
  short: { min: 25, max: 60, label: 'Short', description: 'A punchy one-paragraph hook (25–60 words).' },
  standard: { min: 70, max: 150, label: 'Standard', description: 'A standard back-cover blurb (70–150 words).' },
  long: { min: 150, max: 300, label: 'Long', description: 'A detailed blurb with more world and stakes (150–300 words).' },
};

/** Human labels + guidance per style. */
export const BLURB_STYLE_GUIDE: Record<BlurbStyle, { readonly label: string; readonly emphasis: string }> = {
  suspense: {
    label: 'Suspense',
    emphasis:
      'Emphasise tension, danger, unanswered questions and the central threat. End on a hook. Do not reveal the resolution.',
  },
  character: {
    label: 'Character-driven',
    emphasis:
      'Centre the protagonist’s desire, flaw and arc. Make the reader care about a person. Lead with internal stakes over plot.',
  },
  world: {
    label: 'World-driven',
    emphasis:
      'Lead with the setting, its rules and atmosphere. Make the world itself feel like a character full of wonder and danger.',
  },
  balanced: {
    label: 'Balanced',
    emphasis:
      'Balance character, stakes and setting. Give a clear sense of premise, protagonist and conflict in equal measure.',
  },
};

/** All length presets, in display order. */
export const BLURB_LENGTHS: readonly BlurbLength[] = ['short', 'standard', 'long'];

/** All style presets, in display order. */
export const BLURB_STYLES: readonly BlurbStyle[] = ['suspense', 'character', 'world', 'balanced'];

const SYSTEM_PROMPT =
  'You are a professional back-cover copywriter for published novels. ' +
  'Write MARKETING blurbs that hook a browsing reader in the first sentence, ' +
  'convey the protagonist, the stakes and the central conflict, and end on a ' +
  'compelling hook. Do NOT spoil the ending or major twists. Do NOT invent facts ' +
  'that contradict the provided information. Write in the language of the project ' +
  'information (default to English if unclear). Return ONLY the blurb prose — no ' +
  'title, headings, labels, quotes, commentary or markdown fences.';

/** Collapses whitespace and trims; returns '' for nullish/blank input. */
function clean(value: string | undefined | null): string {
  return (value ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Joins a non-empty list of labelled lines into a single block. */
function block(lines: Array<string | undefined | null>): string {
  return lines.map((line) => clean(line)).filter((line) => line.length > 0).join('\n');
}

/**
 * Produces the system + user messages for a blurb request.
 *
 * This is the ONLY function that decides what the model sees, so it is the unit
 * under test for the "no manuscript / no secrets" rule.
 */
export function buildBlurbMessages(context: BlurbContext, options: BlurbOptions): BlurbMessage[] {
  const lengthTarget = BLURB_LENGTH_TARGETS[options.length];
  const styleGuide = BLURB_STYLE_GUIDE[options.style];

  const facts = block([
    `Title: ${clean(context.title)}`,
    context.genre.length > 0 ? `Genre: ${context.genre.join(', ')}` : undefined,
    context.tags.length > 0 ? `Tags: ${context.tags.join(', ')}` : undefined,
    clean(context.description) ? `Premise (internal summary): ${clean(context.description)}` : undefined,
    clean(context.logline) ? `Logline: ${clean(context.logline)}` : undefined,
    clean(context.premise) ? `Story premise: ${clean(context.premise)}` : undefined,
    clean(context.theme) ? `Themes: ${clean(context.theme)}` : undefined,
    clean(context.centralConflict) ? `Central conflict: ${clean(context.centralConflict)}` : undefined,
    clean(context.stakes) ? `What is at stake: ${clean(context.stakes)}` : undefined,
    clean(context.worldOverview) ? `World: ${clean(context.worldOverview)}` : undefined,
    context.worldThemes && context.worldThemes.length > 0 ? `World themes: ${context.worldThemes.join(', ')}` : undefined,
    formatCharacters(context.characters),
  ]);

  const requirements = block([
    `Length: ${lengthTarget.min}–${lengthTarget.max} words.`,
    `Angle: ${styleGuide.label}. ${styleGuide.emphasis}`,
    clean(options.extraInstruction) ? `Additional instruction: ${clean(options.extraInstruction)}` : undefined,
  ]);

  const user = block([
    'Write a back-cover blurb for the following novel.',
    '',
    facts || `Title: ${clean(context.title)}`,
    '',
    'Requirements:',
    requirements,
  ]);

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/** Renders up to a handful of characters as public-safe one-liners. */
function formatCharacters(characters: readonly BlurbCharacterInput[] | undefined): string | undefined {
  if (!characters || characters.length === 0) return undefined;
  const lines = characters
    .filter((c) => clean(c.name).length > 0)
    // Cap the list so the prompt stays focused (and token cost bounded).
    .slice(0, 8)
    .map((c) => {
      const role = clean(c.role);
      const summary = clean(c.summary);
      const tail = [role, summary].filter((p) => p.length > 0).join(' — ');
      return tail ? `- ${clean(c.name)} (${tail})` : `- ${clean(c.name)}`;
    });
  return lines.length > 0 ? `Key characters:\n${lines.join('\n')}` : undefined;
}

/**
 * True when the context carries enough material to produce a meaningful blurb.
 * A bare title with no description/premise is too thin — the UI warns instead of
 * spending quota on an empty prompt.
 */
export function hasUsableBlurbContext(context: BlurbContext): boolean {
  return (
    clean(context.title).length > 0 &&
    (clean(context.description).length > 0 ||
      clean(context.premise).length > 0 ||
      clean(context.logline).length > 0)
  );
}
