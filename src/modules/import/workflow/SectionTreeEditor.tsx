import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, CornerDownRight, Pencil, X } from 'lucide-react';
import { Badge, Button, IconButton } from '@/components/ui';
import type { UpdateSectionInput } from '@/services';
import type { DocumentSection, DocumentSectionLevel } from '@/types';
import { cn } from '@/utils/cn';
import { buildSectionTree, listChildLevels, listValidParents, type SectionTreeNode } from './import-workflow-stages';

/**
 * Editable structure tree (P8 Batch 6).
 *
 * Renders a document's proposed hierarchy and exposes the structural edits that
 * `ImportService` supports:
 *   - rename a section (title only — the raw text is immutable),
 *   - change its level,
 *   - re-parent it (only to a strictly-higher level; descendants are excluded),
 *   - move it up/down among its siblings (reassigning `order` through
 *     `reorderSections`).
 *
 * Every mutation goes through the callbacks this component receives, which the
 * page wires to `useImportDocuments()` → `ImportService`. The component performs
 * NO writes and re-implements NO business rules: the pickers only offer choices
 * the service will accept (valid parents / child levels), so the user cannot
 * build a tree the service then rejects. Whether an edit really succeeded, and
 * whether it cleared the document's confirmation, is decided by the service.
 *
 * Sections arrive as a PROP and are reloaded by the page after each mutation
 * (`onReload`), because any structural edit clears the confirmation and may
 * recompute `order`; trusting a locally-cached copy would show stale state.
 */
export interface SectionTreeEditorProps {
  sections: DocumentSection[];
  /** Edit a section's structure. Rejects on failure (the page surfaces the error). */
  onUpdate: (sectionId: string, input: UpdateSectionInput) => Promise<void>;
  /** Reassign sibling order for the whole document (all ids, in the new order). */
  onReorder: (orderedIds: string[]) => Promise<void>;
  /** Re-reads the sections after an edit (the hook does not store them). */
  onReload: () => Promise<void>;
  /** Disables controls while a mutation is in flight. */
  busy?: boolean;
  /** id of the section currently saving (for a per-row indicator). */
  savingId?: string | null;
}

export function SectionTreeEditor({
  sections,
  onUpdate,
  onReorder,
  onReload,
  busy,
  savingId,
}: SectionTreeEditorProps) {
  const tree = useMemo(() => buildSectionTree(sections), [sections]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);

  const toggle = (id: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /**
   * Moves a section by one position among its siblings.
   *
   * `reorderSections` expects the FULL document order (every id). The new order
   * is the old document order with ONLY the two swapped ids exchanged, so every
   * other section keeps its relative position.
   */
  const move = async (node: SectionTreeNode, direction: 'up' | 'down') => {
    const siblings = sections
      .filter((section) => (section.parentId ?? null) === (node.section.parentId ?? null))
      .sort((a, b) => a.order - b.order);
    const index = siblings.findIndex((section) => section.id === node.section.id);
    const swapWith = direction === 'up' ? index - 1 : index + 1;
    if (index < 0 || swapWith < 0 || swapWith >= siblings.length) return;

    const a = siblings[index];
    const b = siblings[swapWith];
    const documentOrder = [...sections].sort((x, y) => x.order - y.order).map((section) => section.id);
    const aPos = documentOrder.indexOf(a.id);
    const bPos = documentOrder.indexOf(b.id);
    documentOrder[aPos] = b.id;
    documentOrder[bPos] = a.id;

    await onReorder(documentOrder);
    await onReload();
  };

  /**
   * Applies a structural edit, then reloads.
   *
   * The service clears the document's confirmation on ANY structural edit and
   * may recompute `order`/parent consistency, so the page must re-read the
   * sections rather than keep showing the locally-cached copy.
   */
  const applyUpdate = async (sectionId: string, input: UpdateSectionInput) => {
    await onUpdate(sectionId, input);
    await onReload();
  };

  if (sections.length === 0) {
    return (
      <p className="text-subtle px-3 py-4 text-center text-2xs">
        No sections to edit. Parse the document first.
      </p>
    );
  }

  return (
    <ul className="divide-line divide-y" aria-label="Document structure">
      {flattenVisible(tree, collapsed).map((node) => {
        const { section } = node;
        const hasChildren = node.children.length > 0;
        const isCollapsed = collapsed.has(section.id);

        const siblings = sections
          .filter((candidate) => (candidate.parentId ?? null) === (section.parentId ?? null))
          .sort((a, b) => a.order - b.order);
        const siblingIndex = siblings.findIndex((candidate) => candidate.id === section.id);
        const canMoveUp = siblingIndex > 0;
        const canMoveDown = siblingIndex >= 0 && siblingIndex < siblings.length - 1;

        const isEditing = editingId === section.id;
        const isSaving = savingId === section.id;
        const isBusy = Boolean(busy) || isSaving;

        return (
          <li key={section.id} style={{ paddingLeft: `${node.depth * 1.1}rem` }} className="py-1.5 pr-2">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => hasChildren && toggle(section.id)}
                aria-label={hasChildren ? (isCollapsed ? 'Expand' : 'Collapse') : undefined}
                aria-expanded={hasChildren ? !isCollapsed : undefined}
                disabled={!hasChildren}
                className={cn(
                  'text-subtle grid size-5 shrink-0 place-items-center rounded',
                  hasChildren ? 'hover:bg-surface-muted hover:text-ink' : 'opacity-0',
                )}
              >
                {isCollapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
              </button>

              <Badge tone={levelTone(section.level)} size="sm" className="shrink-0 capitalize">
                {section.level}
              </Badge>

              {isEditing ? (
                <SectionEditForm
                  section={section}
                  sections={sections}
                  busy={isBusy}
                  onSubmit={async (input) => {
                    await applyUpdate(section.id, input);
                    setEditingId(null);
                  }}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <>
                  <span className="text-ink min-w-0 flex-1 truncate text-xs">{section.title}</span>
                  {isSaving ? (
                    <span className="text-subtle shrink-0 text-2xs">saving…</span>
                  ) : (
                    <span className="text-subtle hidden shrink-0 text-2xs tabular-nums sm:inline">
                      {section.text.length.toLocaleString()} ch
                    </span>
                  )}
                  <div className="flex shrink-0 items-center">
                    <IconButton
                      size="sm"
                      label="Move up"
                      disabled={isBusy || !canMoveUp}
                      icon={<ArrowUp className="size-3" aria-hidden />}
                      onClick={() => void move(node, 'up')}
                    />
                    <IconButton
                      size="sm"
                      label="Move down"
                      disabled={isBusy || !canMoveDown}
                      icon={<ArrowDown className="size-3" aria-hidden />}
                      onClick={() => void move(node, 'down')}
                    />
                    <IconButton
                      size="sm"
                      label="Edit structure"
                      disabled={isBusy}
                      icon={<Pencil className="size-3" aria-hidden />}
                      onClick={() => setEditingId(section.id)}
                    />
                  </div>
                </>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Inline edit form for one section.
 *
 * Level and parent are applied IMMEDIATELY on change (each is a distinct service
 * call), while the title is committed by "Save". This mirrors the service's
 * per-field `UpdateSectionInput` and avoids inventing a combined partial update
 * that the service does not model.
 */
function SectionEditForm({
  section,
  sections,
  busy,
  onSubmit,
  onCancel,
}: {
  section: DocumentSection;
  sections: DocumentSection[];
  busy: boolean;
  onSubmit: (input: UpdateSectionInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(section.title);
  const validParents = useMemo(() => listValidParents(sections, section), [sections, section]);
  const childLevels = useMemo(() => listChildLevels(section.level), [section.level]);

  // The current parent may no longer be a valid target (e.g. its level changed);
  // surface that explicitly instead of silently showing a wrong selection.
  const parentExists = validParents.some((parent) => parent?.id === section.parentId);

  return (
    <form
      className="bg-surface-muted flex flex-1 flex-wrap items-center gap-1.5 rounded-md border border-line p-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = title.trim();
        if (!trimmed || trimmed === section.title) {
          onCancel();
          return;
        }
        void onSubmit({ title: trimmed });
      }}
    >
      <input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        aria-label="Section title"
        autoFocus
        className="bg-surface border-line-strong text-ink focus-visible:outline-accent h-7 min-w-40 flex-1 rounded border px-2 text-xs focus-visible:outline-2 focus-visible:outline-offset-1"
      />
      <label className="text-subtle flex items-center gap-1 text-2xs">
        Level
        <select
          aria-label="Section level"
          value={section.level}
          disabled={busy}
          onChange={(event) => void onSubmit({ level: event.target.value as DocumentSectionLevel })}
          className="bg-surface border-line-strong text-ink h-7 rounded border px-1 text-2xs"
        >
          {(['volume', 'chapter', 'scene', 'paragraph'] as const).map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </label>
      <label className="text-subtle flex items-center gap-1 text-2xs">
        <CornerDownRight className="size-3" aria-hidden />
        Parent
        <select
          aria-label="Parent section"
          value={parentExists ? (section.parentId ?? '') : '__invalid__'}
          disabled={busy}
          onChange={(event) => void onSubmit({ parentId: event.target.value ? event.target.value : null })}
          className="bg-surface border-line-strong text-ink h-7 max-w-40 rounded border px-1 text-2xs"
        >
          {!parentExists ? <option value="__invalid__">(invalid parent)</option> : null}
          {validParents.map((parent) => (
            <option key={parent?.id ?? '__root__'} value={parent?.id ?? ''}>
              {parent ? `${parent.title} (${parent.level})` : '— none (top level) —'}
            </option>
          ))}
        </select>
      </label>
      <span className="text-subtle text-2xs">
        children allowed: {childLevels.length > 0 ? childLevels.join(', ') : 'none'}
      </span>
      <Button type="submit" variant="primary" size="sm" disabled={busy}>
        Save
      </Button>
      <IconButton
        size="sm"
        label="Cancel"
        disabled={busy}
        icon={<X className="size-3" aria-hidden />}
        onClick={onCancel}
      />
    </form>
  );
}

function levelTone(level: DocumentSectionLevel) {
  switch (level) {
    case 'volume':
      return 'accent' as const;
    case 'chapter':
      return 'info' as const;
    case 'scene':
      return 'warning' as const;
    default:
      return 'neutral' as const;
  }
}

/** Depth-first nodes, skipping the children of collapsed nodes. */
function flattenVisible(nodes: ReadonlyArray<SectionTreeNode>, collapsed: Set<string>): SectionTreeNode[] {
  const out: SectionTreeNode[] = [];
  const walk = (list: ReadonlyArray<SectionTreeNode>) => {
    for (const node of list) {
      out.push(node);
      if (!collapsed.has(node.section.id)) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}
