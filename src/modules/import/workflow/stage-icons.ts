import type { LucideIcon } from 'lucide-react';
import { Upload, FileText, ScanText, Sparkles, ClipboardCheck, Merge } from 'lucide-react';
import type { ImportWorkflowStage } from './import-workflow-stages';

/**
 * Per-stage icon for the shared workflow stepper.
 *
 * Kept in sync with the `icon` of each nav item in `config/navigation.ts`, so the
 * stepper and the sidebar read as the same journey. Typed as `Record` over the
 * stage union, so adding a stage is a compile error here — the stepper can never
 * silently render an icon-less step.
 */
export const STAGE_ICONS: Record<ImportWorkflowStage, LucideIcon> = {
  import: Upload,
  parser: FileText,
  structure: ScanText,
  extraction: Sparkles,
  review: ClipboardCheck,
  integration: Merge,
};
