import { useCallback, useEffect, useMemo, useState } from 'react';
import { Ban, Bot, Maximize2, Minimize2, Sparkles, Wand2 } from 'lucide-react';
import type { Editor } from '@tiptap/react';
import { Badge, Button, Card } from '@/components/ui';
import type { AiTaskKind } from '@/types';
import { TASK_PROMPT_LIST } from '@/services';
import { useAiAssistance, useAiConfig } from '@/hooks';
import { cn } from '@/utils/cn';
import { AiPreviewDialog } from './components/AiPreviewDialog';
import { captureInsertAnchor, validateAnchor } from './insert-anchor';

export interface EditorAiAssistantProps {
  /** The TipTap editor, once ready. Null while mounting. */
  editor: Editor | null;
  chapterTitle: string;
  /** Locked chapters cannot receive AI edits. */
  locked?: boolean;
  className?: string;
}

/**
 * AI assistant embedded in the chapter editor (P5).
 *
 * Flow and safety guarantees:
 *   1. The user picks a task; text tasks read the CURRENT selection (or the
 *      chapter tail when nothing is selected, for continuation).
 *   2. The proposal is shown in a preview dialog — never applied automatically.
 *   3. On Apply, the text is written through the SAME `editor` the user types
 *      into, so it flows through the P4 debounced, revision-checked autosave.
 *      There is no second write path and no way to bypass the version guard.
 *
 * Replace tasks (rewrite/polish/expand/shorten) require a selection and replace
 * exactly that range. Continuation inserts at the position captured when
 * generation began (not the live cursor), so Apply is deterministic; if the
 * document changed in a way that makes the anchor unsafe, Apply refuses rather
 * than guessing. Undo (Ctrl+Z) reverts an Apply as a normal editor edit.
 */
export function EditorAiAssistant({ editor, chapterTitle, locked, className }: EditorAiAssistantProps) {
  const { models } = useAiConfig();
  const assistance = useAiAssistance();

  const [previewOpen, setPreviewOpen] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [lastTask, setLastTask] = useState<AiTaskKind | null>(null);
  const [selectionInfo, setSelectionInfo] = useState<{ from: number; to: number; text: string } | null>(null);

  // Track the current selection so the panel can enable/disable tasks and show
  // how much text will be operated on.
  useEffect(() => {
    if (!editor) return;
    const update = () => {
      const { from, to } = editor.state.selection;
      const text = editor.state.doc.textBetween(from, to, '\n', '\n');
      setSelectionInfo(from === to ? null : { from, to, text });
    };
    update();
    editor.on('selectionUpdate', update);
    editor.on('update', update);
    return () => {
      editor.off('selectionUpdate', update);
      editor.off('update', update);
    };
  }, [editor]);

  const hasModels = models.length > 0;
  const replaceTasks = useMemo(
    () => TASK_PROMPT_LIST.filter((task) => task.mode === 'replace-selection'),
    [],
  );

  /** Text for a task: selection for replace tasks, chapter tail for continue. */
  const resolveSourceText = useCallback(
    (task: AiTaskKind): string => {
      if (!editor) return '';
      const definition = TASK_PROMPT_LIST.find((entry) => entry.task === task);
      if (definition?.mode === 'replace-selection') {
        const { from, to } = editor.state.selection;
        return editor.state.doc.textBetween(from, to, '\n', '\n');
      }
      return editor.getText().slice(-4000);
    },
    [editor],
  );

  /**
   * Captures where a continuation should be inserted.
   *
   * We insert at the end of the current selection (the caret for a collapsed
   * selection), snapshotting the document size and the text immediately before
   * the anchor. Apply later re-checks these, so a moved cursor or a changed
   * document cannot silently redirect the insertion.
   */
  const captureAnchor = useCallback((): ReturnType<typeof captureInsertAnchor> | null => {
    if (!editor) return null;
    return captureInsertAnchor(editor.state.doc, editor.state.selection.to);
  }, [editor]);

  const runTask = useCallback(
    async (task: AiTaskKind) => {
      if (!editor) return;
      setApplyError(null);
      setLastTask(task);
      const definition = TASK_PROMPT_LIST.find((entry) => entry.task === task);
      // Only continuation carries an anchor; replace/chat do not insert.
      const insertAnchor = definition?.mode === 'insert' ? captureAnchor() ?? undefined : undefined;
      const proposal = await assistance.run({
        task,
        sourceText: resolveSourceText(task),
        chapterTitle,
        insertAnchor,
      });
      if (proposal) setPreviewOpen(true);
    },
    [assistance, captureAnchor, chapterTitle, editor, resolveSourceText],
  );

  /** Applies the proposal through the editor — the single safe write path. */
  const applyProposal = useCallback(() => {
    const proposal = assistance.proposal;
    if (!editor || !proposal) return;
    setApplyError(null);

    try {
      if (proposal.mode === 'insert') {
        const anchor = proposal.insertAnchor;
        const doc = editor.state.doc;
        // Fall back to the end of the document if (defensively) no anchor is
        // present, never the live cursor.
        const target = anchor?.pos ?? doc.content.size;

        // Deterministic-insert guard: refuse if the document changed in a way
        // that makes the snapshot stale, rather than inserting somewhere the
        // user did not preview.
        if (anchor) {
          const validation = validateAnchor(doc, anchor);
          if (!validation.ok) {
            setApplyError(
              'The chapter changed since this continuation was generated, so it may no longer fit at that spot. Regenerate to continue from the current text.',
            );
            return;
          }
        }

        const prefix = doc.textContent.length > 0 && target > 0 ? '\n\n' : '';
        editor.chain().focus().insertContentAt(target, `${prefix}${proposal.generatedText}`).run();
      } else if (proposal.mode === 'replace-selection') {
        const { from, to } = editor.state.selection;
        if (from === to) {
          setApplyError('The selection changed — reselect the text and generate again.');
          return;
        }
        editor.chain().focus().insertContentAt({ from, to }, proposal.generatedText).run();
      }
      setPreviewOpen(false);
      assistance.reset();
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : 'The change could not be applied.');
    }
  }, [assistance, editor]);

  const regenerate = useCallback(() => {
    if (!lastTask) return;
    setPreviewOpen(false);
    void runTask(lastTask);
  }, [lastTask, runTask]);

  const busy = assistance.generating;

  return (
    <Card padding="sm" className={cn('space-y-2', className)}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Bot className="text-accent size-4" aria-hidden />
          <h3 className="text-ink text-xs font-semibold">AI Assistant</h3>
        </div>
        {!hasModels ? (
          <Badge tone="warning" size="sm">
            Not configured
          </Badge>
        ) : selectionInfo ? (
          <Badge tone="accent" size="sm">
            {selectionInfo.text.trim().split(/\s+/).filter(Boolean).length} selected
          </Badge>
        ) : null}
      </div>

      {!hasModels ? (
        <p className="text-subtle text-2xs leading-relaxed">
          Configure a provider and model in Settings to use AI here.
        </p>
      ) : locked ? (
        <p className="text-subtle text-2xs leading-relaxed">Unlock the chapter to use AI edits.</p>
      ) : busy ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-subtle inline-flex items-center gap-1.5 text-2xs" role="status">
            <span className="bg-accent size-1.5 animate-pulse rounded-full" aria-hidden />
            Generating…
          </span>
          <Button variant="ghost" size="sm" iconLeft={<Ban className="size-3" />} onClick={assistance.cancel}>
            Stop
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-1.5">
          <Button
            variant="secondary"
            size="sm"
            iconLeft={<Sparkles className="size-3.5" />}
            onClick={() => void runTask('continue')}
            fullWidth
          >
            Continue
          </Button>
          {replaceTasks.map((task) => (
            <Button
              key={task.task}
              variant="secondary"
              size="sm"
              iconLeft={
                task.task === 'expand' ? (
                  <Maximize2 className="size-3.5" />
                ) : task.task === 'shorten' ? (
                  <Minimize2 className="size-3.5" />
                ) : (
                  <Wand2 className="size-3.5" />
                )
              }
              onClick={() => void runTask(task.task)}
              disabled={!selectionInfo}
              title={selectionInfo ? task.description : 'Select text first'}
              fullWidth
            >
              {task.label}
            </Button>
          ))}
        </div>
      )}

      {replaceTasks.length > 0 && !selectionInfo && hasModels && !locked && !busy ? (
        <p className="text-subtle text-2xs italic">
          Select text to enable {replaceTasks.map((task) => task.label).join(', ')}.
        </p>
      ) : null}

      {assistance.status === 'error' && assistance.error ? (
        <div className="bg-danger-soft/60 rounded-md px-2 py-1.5">
          <p className="text-danger text-2xs" role="alert">
            {assistance.error.message}
          </p>
          {'hint' in assistance.error && (assistance.error as { hint?: string }).hint ? (
            <p className="text-subtle mt-0.5 text-2xs">{(assistance.error as { hint?: string }).hint}</p>
          ) : null}
        </div>
      ) : null}

      <AiPreviewDialog
        open={previewOpen}
        proposal={assistance.proposal}
        applying={false}
        onClose={() => {
          setPreviewOpen(false);
          assistance.reset();
        }}
        onApply={applyProposal}
        onRegenerate={regenerate}
        applyError={applyError}
      />
    </Card>
  );
}
