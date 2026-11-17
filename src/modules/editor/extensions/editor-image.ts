import { mergeAttributes, Node } from '@tiptap/core';

/**
 * Story Editor image node.
 *
 * WHY this extension exists
 * -------------------------
 * The manuscript is stored as Markdown, and the editor serialises its own
 * ProseMirror JSON → Markdown (`getMarkdown` in `MarkdownEditor`). The default
 * StarterKit has NO image node, so an `![alt](src)` line would be silently
 * dropped: there would be nowhere for it to live in the schema. This node gives
 * images a home so they round-trip.
 *
 * It is deliberately MINIMAL and STORAGE-AGNOSTIC:
 *   - It is a block leaf node (`group: 'block'`, `inline: false`) matching a
 *     Markdown image paragraph, with two attributes: `src` and `alt`.
 *   - `renderHTML` emits a plain `<img>` (never raw HTML from the user's prose —
 *     attributes are escaped by the DOM). `parseHTML` reads `<img>` back, so a
 *     document the serialiser produced re-opens identically.
 *   - It stores NOTHING extra: no blob, no object URL, no server reference. The
 *     `src` is a stable URL (http(s), relative or data:image) validated by
 *     `normaliseImageSrc` BEFORE insertion. No new image storage is invented.
 *
 * Serialisation to `![alt](src)` lives in `MarkdownEditor`'s serialiser so the
 * Markdown canonical format stays the single source of truth.
 */
export interface ImageAttrs {
  src: string;
  alt: string;
}

export const EditorImage = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addOptions() {
    return {
      HTMLAttributes: {} as Record<string, unknown>,
    };
  },

  addAttributes() {
    return {
      src: {
        default: null,
        parseHTML: (element) => element.getAttribute('src'),
        renderHTML: (attributes) => (attributes.src ? { src: attributes.src } : {}),
      },
      alt: {
        default: '',
        parseHTML: (element) => element.getAttribute('alt') ?? '',
        renderHTML: (attributes) => ({ alt: attributes.alt ?? '' }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'img[src]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['img', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes)];
  },
});
