/**
 * Human-readable labels for preset formatting options (P9 Batch B).
 *
 * Single place that maps the Batch A preset vocabulary to plain language, so the
 * Presets page and the Chapter Export page describe presets IDENTICALLY and only
 * for options the pipeline actually consumes.
 */

import type {
  ChapterHeadingStyle,
  MetadataPolicy,
  ParagraphStyle,
  PublishingPreset,
} from '@/modules/publishing';

export const METADATA_POLICY_LABELS: Record<MetadataPolicy, string> = {
  none: 'No title header',
  title: 'Title header',
  'title-and-author': 'Title + author header',
};

export const PARAGRAPH_STYLE_LABELS: Record<ParagraphStyle, string> = {
  indent: 'First-line indent + blank line',
  'indent-only': 'First-line indent, no blank line',
  'blank-line': 'Blank line, no indent',
  flush: 'No indent, no blank line',
};

export const CHAPTER_HEADING_STYLE_LABELS: Record<ChapterHeadingStyle, string> = {
  none: 'No chapter heading',
  number: 'Numbered (e.g. "Chapter 1: …")',
  'number-padded': 'Numbered, zero-padded (e.g. "Chapter 01: …")',
  label: 'Custom label (e.g. "第1章 …")',
};

/** A small, ordered list of concise characteristics for a preset card. */
export function describePreset(preset: PublishingPreset): string[] {
  const lines: string[] = [];
  lines.push(METADATA_POLICY_LABELS[preset.metadata]);
  lines.push(
    preset.includeVolumeHeadings
      ? `Volume heading: “${preset.volumeHeadingTemplate}”`
      : 'No volume headings',
  );
  lines.push(`Chapter heading: ${CHAPTER_HEADING_STYLE_LABELS[preset.chapterHeadingStyle]}`);
  lines.push(`Paragraphs: ${PARAGRAPH_STYLE_LABELS[preset.paragraphStyle]}`);
  if (preset.paragraphStyle === 'indent' || preset.paragraphStyle === 'indent-only') {
    lines.push(`Indent: ${preset.paragraphIndent} character${preset.paragraphIndent === 1 ? '' : 's'}`);
  }
  lines.push(`Scene break: “${preset.sceneBreak}”`);
  lines.push(`File: “${preset.fileNameTemplate}.${preset.fileExtension}”`);
  return lines;
}
