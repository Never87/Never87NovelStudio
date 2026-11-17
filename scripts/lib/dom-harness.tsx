/**
 * Test-only React harness for the Story Editor DOM-level verification.
 *
 * This file is bundled INTO a single module graph (React, TipTap and the editor
 * components all together) so there is exactly ONE React instance at runtime.
 * Bundling the components with `external: ['react']` instead left the harness
 * and the components on subtly different React internals, which surfaced as
 * `dispatcher.getOwner is not a function` — a pure test-setup artefact, not a
 * product bug.
 *
 * It exposes small imperative helpers (`mountToolbarHarness`, etc.) that the
 * Node verification script drives; all expectations stay in the script.
 */
import { createRoot } from 'react-dom/client';
import { createElement, useEffect, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { MarkdownEditor, getMarkdown } from '@/modules/editor/MarkdownEditor';
import { EditorToolbar } from '@/modules/editor/EditorToolbar';
import { SlashMenu } from '@/modules/editor/SlashMenu';
import { useStoryEditorStore } from '@/stores/story-editor-store';

export { getMarkdown, useStoryEditorStore };

export interface MountedHarness {
  container: HTMLElement;
  /** The live TipTap editor, once `onEditorReady` has fired. */
  getEditor: () => Editor | null;
  /** Markdown serialised from the live editor. */
  getMarkdown: () => string;
  /** Everything passed to `onChange`, in order. */
  changeLog: string[];
  /** Requests the slash menu at the caret (the toolbar `/` button path). */
  openSlash: () => void;
  unmount: () => void;
}

/**
 * Mounts the real `EditorToolbar` + a real `MarkdownEditor` + the real
 * `SlashMenu` into a fresh container, wired the same way `WritingPanel` wires
 * them. Returns handles so the caller can click/inspect. Uses the caller's
 * `act`-aware rendering by mounting synchronously under the global
 * `IS_REACT_ACT_ENVIRONMENT`.
 */
export function mountHarness(value = ''): MountedHarness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const changeLog: string[] = [];
  let editorRef: Editor | null = null;
  const root = createRoot(container);
  let setSignal: (fn: (n: number) => number) => void = () => {};

  function Harness() {
    const [editor, setEditor] = useState<Editor | null>(null);
    const [signal, setSignalState] = useState(0);
    setSignal = setSignalState;
    useEffect(() => {
      editorRef = editor;
    }, [editor]);
    return createElement(
      'div',
      null,
      createElement(
        'div',
        { id: 'hdr' },
        createElement(EditorToolbar, { editor, onOpenSlashMenu: () => setSignalState((n) => n + 1) }),
      ),
      createElement(
        'div',
        { style: { position: 'relative' } },
        createElement(MarkdownEditor, {
          editorKey: 'verify',
          value,
          onChange: (md: string) => changeLog.push(md),
          onEditorReady: setEditor,
        }),
        createElement(SlashMenu, { editor, openSignal: signal }),
      ),
    );
  }

  root.render(createElement(Harness));

  return {
    container,
    getEditor: () => editorRef,
    getMarkdown: () => (editorRef ? getMarkdown(editorRef) : ''),
    changeLog,
    openSlash: () => setSignal((n) => n + 1),
    unmount: () => {
      root.unmount();
      container.remove();
    },
  };
}
