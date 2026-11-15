/**
 * Publishing Presets page (P9 Batch B) — `/publishing/presets`.
 *
 * Manages the SHARED preset state: browse the 8 built-in presets, select the
 * active one, and create/edit/duplicate/rename/delete custom presets. Built-in
 * presets are read-only (they can only be cloned into a custom preset).
 *
 * All state lives in the shared `usePublishingPresets` hook, so a change here is
 * immediately reflected on the Chapter Export page and survives reloads. This
 * page does NOT persist or format anything itself — it is a thin, validated UI
 * over the store and the Batch A preset vocabulary.
 */

import { useMemo, useState } from 'react';
import {
  BookMarked,
  Check,
  Copy,
  Pencil,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { Badge, Button, Card, PageHeader } from '@/components/ui';
import { ProjectDialog } from '@/modules/projects/components/ProjectDialog';
import { usePublishingPresets } from '@/hooks';
import {
  defaultDraft,
  type CustomPresetEntry,
  type PublishingPreset,
} from '@/modules/publishing';
import type { CustomPresetDraft } from '@/schemas/publishing-preset';
import { cn } from '@/utils/cn';
import { PresetCharacteristics, PresetKindBadge } from './components/PresetPicker';
import { PresetEditor } from './components/PresetEditor';
import { describePreset } from './components/preset-describe';

/** Editor dialog state: closed, creating, or editing a specific custom preset. */
type EditorState =
  | { mode: 'closed' }
  | { mode: 'create'; initial: CustomPresetDraft }
  | { mode: 'edit'; id: string; initial: CustomPresetDraft };

export function PublishingPresetsPage() {
  const presets = usePublishingPresets();
  const [editor, setEditor] = useState<EditorState>({ mode: 'closed' });
  const [deleteTarget, setDeleteTarget] = useState<CustomPresetEntry | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const builtins = presets.builtins;
  const customs = presets.customPresets;

  const openCreateFromDefault = () => {
    setFeedback(null);
    setEditor({ mode: 'create', initial: defaultDraft() });
  };

  const openEdit = (entry: CustomPresetEntry) => {
    setFeedback(null);
    const { label, metadata, includeVolumeHeadings, volumeHeadingTemplate,
      chapterHeadingStyle, chapterHeadingTemplate, paragraphStyle, paragraphIndent,
      paragraphSpacing, sceneBreak, fileNameTemplate, fileExtension } = entry;
    setEditor({
      mode: 'edit',
      id: entry.id,
      initial: {
        label, metadata, includeVolumeHeadings, volumeHeadingTemplate, chapterHeadingStyle,
        chapterHeadingTemplate, paragraphStyle, paragraphIndent, paragraphSpacing, sceneBreak,
        fileNameTemplate, fileExtension,
      },
    });
  };

  const handleSubmit = (draft: CustomPresetDraft) => {
    if (editor.mode === 'create') {
      const created = presets.createCustom(draft);
      setFeedback(`Created “${created.label}” and set it as the active preset.`);
    } else if (editor.mode === 'edit') {
      const updated = presets.updateCustom(editor.id, draft);
      setFeedback(`Saved changes to “${updated.label}”.`);
    }
    setEditor({ mode: 'closed' });
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    const label = deleteTarget.label;
    presets.deleteCustom(deleteTarget.id);
    setDeleteTarget(null);
    setFeedback(`Deleted “${label}”.`);
  };

  const activeLabel = presets.active.label;
  const activeIsBuiltin = presets.isBuiltin(presets.activeId);
  const isDefaultActive = presets.activeId === 'generic';

  return (
    <div className="space-y-5">
      <PageHeader
        title="Publishing Presets"
        description="Choose the formatting profile used for chapter exports, and build your own from the built-ins. These presets are pragmatic formatting profiles — not verified platform submission rules."
        icon={<BookMarked className="size-4" aria-hidden />}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              iconLeft={<Plus className="size-3.5" />}
              onClick={openCreateFromDefault}
              data-testid="create-preset"
            >
              New preset
            </Button>
          </div>
        }
      />

      {/* Active preset banner. */}
      <Card padding="md" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Sparkles className="text-accent size-4" aria-hidden />
            <span className="text-ink text-sm font-medium">
              Active preset: <span data-testid="active-preset-label">{activeLabel}</span>
            </span>
            <PresetKindBadge builtin={activeIsBuiltin} />
          </div>
          <Button
            variant="ghost"
            size="sm"
            iconLeft={<RotateCcw className="size-3.5" />}
            onClick={() => {
              presets.resetToDefault();
              setFeedback('Active preset reset to the default (Generic).');
            }}
            disabled={isDefaultActive}
            data-testid="reset-to-default"
          >
            Reset to default
          </Button>
        </div>
        <PresetCharacteristics lines={describePreset(presets.active)} />
        <p className="text-subtle text-2xs">
          The active preset is shared with the Chapter Export page and is remembered across reloads.
        </p>
      </Card>

      {feedback ? (
        <div
          className="border-success/40 bg-success-soft/50 text-success flex items-start gap-2 rounded-md border px-3 py-2 text-xs"
          role="status"
          data-testid="preset-feedback"
        >
          <Check className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{feedback}</span>
        </div>
      ) : null}

      {presets.recoveryNotice ? (
        <div
          className="border-warning/40 bg-warning-soft/40 text-warning flex items-start gap-2 rounded-md border px-3 py-2 text-xs"
          role="status"
          data-testid="preset-recovery-notice"
        >
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{presets.recoveryNotice}</span>
        </div>
      ) : null}

      {/* Built-in presets. */}
      <section className="space-y-2">
        <h2 className="text-subtle text-2xs font-medium uppercase tracking-wide">
          Built-in presets ({builtins.length})
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="builtin-presets">
          {builtins.map((preset) => (
            <PresetCard
              key={preset.id}
              preset={preset}
              active={preset.id === presets.activeId}
              onSelect={() => {
                presets.selectPreset(preset.id);
                setFeedback(`Selected “${preset.label}”.`);
              }}
              onDuplicate={() => {
                const copy = presets.createFromBuiltin(preset.id);
                setFeedback(`Created custom preset “${copy.label}” from “${preset.label}”.`);
              }}
            />
          ))}
        </div>
      </section>

      {/* Custom presets. */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-subtle text-2xs font-medium uppercase tracking-wide">
            Custom presets ({customs.length})
          </h2>
          <Button
            variant="secondary"
            size="sm"
            iconLeft={<Plus className="size-3.5" />}
            onClick={openCreateFromDefault}
          >
            New custom preset
          </Button>
        </div>
        {customs.length === 0 ? (
          <Card padding="md">
            <p className="text-subtle text-xs" data-testid="no-custom-presets">
              No custom presets yet. Create one from scratch or duplicate a built-in above to start
              from its settings.
            </p>
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="custom-presets">
            {customs.map((entry) => (
              <PresetCard
                key={entry.id}
                preset={entry}
                active={entry.id === presets.activeId}
                onSelect={() => {
                  presets.selectPreset(entry.id);
                  setFeedback(`Selected “${entry.label}”.`);
                }}
                onEdit={() => openEdit(entry)}
                onDuplicate={() => {
                  const copy = presets.duplicateCustom(entry.id);
                  setFeedback(`Duplicated as “${copy.label}”.`);
                }}
                onDelete={() => setDeleteTarget(entry)}
              />
            ))}
          </div>
        )}
      </section>

      <PresetEditor
        open={editor.mode !== 'closed'}
        mode={editor.mode === 'edit' ? 'edit' : 'create'}
        initial={editor.mode === 'closed' ? defaultDraft() : editor.initial}
        onSubmit={handleSubmit}
        onClose={() => setEditor({ mode: 'closed' })}
      />

      <DeletePresetDialog
        target={deleteTarget}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

/** Card for one preset (built-in or custom) with its actions. */
function PresetCard({
  preset,
  active,
  onSelect,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  preset: PublishingPreset;
  active: boolean;
  onSelect: () => void;
  onEdit?: () => void;
  onDuplicate: () => void;
  onDelete?: () => void;
}) {
  const builtin = preset.builtin;
  const lines = useMemo(() => describePreset(preset), [preset]);
  return (
    <Card
      padding="md"
      className={cn('flex flex-col gap-2', active && 'ring-accent/40 ring-2')}
      data-testid="preset-card"
      data-preset-id={preset.id}
      data-active={active}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-ink flex items-center gap-1.5 truncate text-sm font-medium">
            {preset.label}
            {active ? (
              <Badge tone="success" size="sm" data-testid="preset-active-badge">
                Active
              </Badge>
            ) : null}
          </p>
        </div>
        <PresetKindBadge builtin={builtin} />
      </div>

      <PresetCharacteristics lines={lines} />

      <div className="border-line mt-auto flex flex-wrap items-center gap-1.5 border-t pt-2">
        <Button
          variant={active ? 'success' in {} ? 'secondary' : 'secondary' : 'secondary'}
          size="sm"
          disabled={active}
          onClick={onSelect}
          iconLeft={<Check className="size-3.5" />}
          data-testid="preset-select"
        >
          {active ? 'Selected' : 'Select'}
        </Button>
        {onEdit ? (
          <Button
            variant="ghost"
            size="sm"
            iconLeft={<Pencil className="size-3.5" />}
            onClick={onEdit}
            data-testid="preset-edit"
          >
            Edit
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          iconLeft={<Copy className="size-3.5" />}
          onClick={onDuplicate}
          data-testid="preset-duplicate"
        >
          {builtin ? 'Customise' : 'Duplicate'}
        </Button>
        {onDelete ? (
          <Button
            variant="ghost"
            size="sm"
            iconLeft={<Trash2 className="size-3.5" />}
            onClick={onDelete}
            data-testid="preset-delete"
            className="text-danger"
          >
            Delete
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

/** Confirmation dialog for deleting a custom preset. */
function DeletePresetDialog({
  target,
  onCancel,
  onConfirm,
}: {
  target: CustomPresetEntry | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <SimpleConfirmDialog
      open={target !== null}
      title="Delete this custom preset?"
      description={target ? `“${target.label}” will be removed permanently.` : ''}
      confirmLabel="Delete preset"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

/**
 * Minimal confirm dialog for destructive preset actions. Reuses the shared
 * dialog styling via a tiny local wrapper kept intentionally small.
 */
function SimpleConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;
  return (
    <ProjectDialog
      open={open}
      title={title}
      description={description}
      tone="danger"
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            iconLeft={<Trash2 className="size-3.5" />}
            onClick={onConfirm}
            data-testid="preset-delete-confirm"
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-muted text-xs leading-relaxed">
        This only removes the saved custom preset. Any chapters already exported with it are not
        affected. If it is the active preset, the selection falls back to the default.
      </p>
    </ProjectDialog>
  );
}
