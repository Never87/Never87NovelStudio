import { Extension, InputRule } from '@tiptap/core';
import type { NodeType, Node as PMNode, Schema } from '@tiptap/pm/model';
import { Fragment, Slice } from '@tiptap/pm/model';

/**
 * Native Markdown typing shortcuts for the Story Editor.
 *
 * TipTap's StarterKit already ships input rules for:
 *   `#`–`######`  → headings,  `-`/`*` → bullet list,  `1.` → ordered list,
 *   `>`           → blockquote, ` ``` ` → code block, `---` → horizontal rule,
 *   and the Markdown mark rules (`**bold**`, `*italic*`, `_italic_`, `~~strike~~`,
 *   `` `code` ``).
 *
 * Rather than re-register those (which would make every shortcut fire twice and
 * "undo" itself), the Story Editor keeps StarterKit's rules and ADDS only the
 * one it lacks:
 *
 *   `![alt](url)` typed in an EMPTY paragraph → an image block.
 *
 * This mirrors the Image insertion command, so Markdown typed by hand and a
 * menu-inserted image produce the exact same document — and both are what
 * `getMarkdown` serialises back to.
 */

/** Matches a typed `![alt](url)` as the ONLY content of the paragraph. */
const IMAGE_INPUT_REGEX = /^!\[([^\]]*)\]\((\S+?)\)$/;

/** Resolves the image node type, or null when EditorImage is not registered. */
function imageType(schema: Schema): NodeType | null {
  return schema.nodes.image ?? null;
}

/** Locates the top-level textblock (depth 1) that encloses doc position `pos`. */
function topLevelBlock(doc: PMNode, pos: number): { node: PMNode; pos: number } | null {
  // A doc's content is at depth 0; its children start at depth 1.
  const $pos = doc.resolve(pos);
  if ($pos.depth < 1) return null;
  return { node: $pos.node(1), pos: $pos.before(1) };
}

export const MarkdownShortcutRules = Extension.create({
  name: 'n87MarkdownShortcuts',

  addInputRules() {
    return [
      new InputRule({
        find: IMAGE_INPUT_REGEX,
        handler: ({ state, range, match }) => {
          const type = imageType(state.schema);
          if (!type) return;

          const alt = (match[1] ?? '').slice(0, 300);
          const src = (match[2] ?? '').trim();
          if (!src) return;

          const block = topLevelBlock(state.doc, range.from);
          if (!block) return;

          const imageNode = type.create({ src, alt });
          // Replace the whole paragraph (which held only the typed Markdown)
          // with the image block. "Open" replaces so the selection lands after
          // the image, ready for the next paragraph.
          const imageSlice = new Slice(Fragment.from(imageNode), 0, 0);
          state.tr.replace(block.pos, block.pos + block.node.nodeSize, imageSlice).scrollIntoView();
        },
      }),
    ];
  },
});
