/**
 * P4 unit tests for the manuscript text utilities and Markdown import/export
 * parsing (no browser, no database).
 *
 * Asserts:
 *   - Markdown → plain text stripping,
 *   - word counting for Latin AND CJK manuscripts,
 *   - chapter splitting on `#`/`##` headings,
 *   - export → import round-tripping (the property an import/export pair must
 *     have to be safe to use on real drafts).
 *
 * Usage: npm run verify:markdown
 */
const assert = require('node:assert/strict');
const { importBundled, cleanupTemp } = require('./lib/p4-bundler.cjs');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
}

async function main() {
  const text = await importBundled('src/utils/manuscript-text.ts', 'manuscript-text');

  // 1 — Markdown syntax is stripped from plain text.
  {
    const md = [
      '# Chapter One',
      '',
      'Some **bold**, *italic* and `code` text.',
      '',
      '> A quote with a [link](https://example.com).',
      '',
      '- item one',
      '- item two',
      '',
      '```js',
      'const x = 1;',
      '```',
    ].join('\n');
    const plain = text.markdownToPlainText(md);
    const hasSyntax =
      /[#*`>]|\[|\]|\(https?:/.test(plain) || plain.includes('---');
    record(
      'markdownToPlainText: strips headings, marks, quotes, lists and fences',
      !hasSyntax && plain.includes('bold') && plain.includes('const x = 1;'),
      JSON.stringify(plain.slice(0, 60)),
    );
  }

  // 2 — Latin word counting.
  {
    const count = text.countWords('One two three four five.');
    record('countWords: Latin text', count === 5, `count=${count}`);
  }

  // 3 — CJK word counting (each character is a word; punctuation is not).
  {
    const count = text.countWords('他走进雨中。');
    record('countWords: CJK text counts characters, not punctuation', count === 5, `count=${count}`);
  }

  // 4 — Mixed Latin + CJK in one line.
  {
    const count = text.countWords('Hello 世界');
    record('countWords: mixed Latin and CJK', count === 3, `count=${count}`);
  }

  // 5 — characters exclude whitespace.
  {
    const count = text.countCharacters('a b\nc');
    record('countCharacters: ignores whitespace', count === 3, `count=${count}`);
  }

  // 6 — chapter splitting on h1/h2 headings.
  {
    const md = ['Preamble text', '', '# One', 'Body one', '', '## Two', 'Body two'].join('\n');
    const chapters = text.splitMarkdownChapters(md);
    record(
      'splitMarkdownChapters: splits on # and ##, keeps the preamble',
      chapters.length === 3 &&
        chapters[0].title === '' &&
        chapters[1].title === 'One' &&
        chapters[2].title === 'Two' &&
        chapters[2].content === 'Body two',
      `titles=[${chapters.map((c) => JSON.stringify(c.title)).join(', ')}]`,
    );
  }

  // 7 — a document with no headings is one untitled chapter.
  {
    const chapters = text.splitMarkdownChapters('Just prose.\n\nAnother paragraph.');
    record(
      'splitMarkdownChapters: heading-less document → single untitled chapter',
      chapters.length === 1 && chapters[0].title === '' && chapters[0].content.includes('Another'),
      `count=${chapters.length}`,
    );
  }

  // 8 — round trip: chaptersToMarkdown → splitMarkdownChapters.
  {
    const source = [
      { title: 'The Storm', content: 'Rain fell.\n\nShe waited.' },
      { title: 'Aftermath', content: 'Morning came.' },
    ];
    const md = text.chaptersToMarkdown(source);
    const back = text.splitMarkdownChapters(md);
    const same =
      back.length === 2 &&
      back[0].title === 'The Storm' &&
      back[0].content === 'Rain fell.\n\nShe waited.' &&
      back[1].title === 'Aftermath' &&
      back[1].content === 'Morning came.';
    record('round trip: export → import preserves titles and bodies', same, `roundTripped=${back.length}`);
  }

  // 9 — empty input never throws and yields nothing.
  {
    const chapters = text.splitMarkdownChapters('');
    record(
      'empty document: no chapters, no error',
      Array.isArray(chapters) && chapters.length === 0,
      `count=${chapters.length}`,
    );
  }

  // 10 — CRLF input is normalised (Windows-authored drafts).
  {
    const chapters = text.splitMarkdownChapters('# Title\r\nBody line\r\n');
    record(
      'CRLF input: headings detected, \\r stripped',
      chapters.length === 1 && chapters[0].title === 'Title' && !chapters[0].content.includes('\r'),
      `count=${chapters.length}`,
    );
  }

  // 11 — REGRESSION: headings inside a chapter must not split it on re-import.
  {
    const stored = text.normaliseChapterHeadings(
      ['A #hashtag line', '', '# Inner title', '', 'body', '', '## Sub inner', '', 'more'].join('\n'),
    );
    const reparsed = text.splitMarkdownChapters(`## Outer\n\n${stored}\n`);
    record(
      'normaliseChapterHeadings: inner #/## demoted, chapter stays one chapter',
      reparsed.length === 1 &&
        reparsed[0].title === 'Outer' &&
        stored.includes('### Inner title') &&
        stored.includes('### Sub inner') &&
        stored.includes('#hashtag'),
      `chapters=${reparsed.length} stored=${JSON.stringify(stored.split('\n')[2])}`,
    );
  }

  // 12 — REGRESSION: export applies the same normalisation, so export→import is
  // stable even when stored prose contains its own headings.
  {
    const md = text.chaptersToMarkdown([
      { title: 'Lighthouse', content: '# Opening\n\nseed text' },
      { title: 'Second', content: 'plain' },
    ]);
    const reparsed = text.splitMarkdownChapters(md);
    record(
      'chaptersToMarkdown: demotes stored headings → exact round trip',
      reparsed.length === 2 &&
        reparsed[0].title === 'Lighthouse' &&
        reparsed[0].content.includes('### Opening') &&
        reparsed[1].title === 'Second',
      `titles=[${reparsed.map((c) => c.title).join(', ')}]`,
    );
  }

  // 13 — parsed chapters report the heading level they were declared with.
  {
    const chapters = text.splitMarkdownChapters('# One\n\n## Two\n');
    record(
      'splitMarkdownChapters: reports heading level per chapter',
      chapters.length === 2 && chapters[0].level === 1 && chapters[1].level === 2,
      `levels=[${chapters.map((c) => c.level).join(', ')}]`,
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nTOTAL ${results.length}  PASS ${results.length - failed.length}  FAIL ${failed.length}`);
  if (failed.length > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error('HARNESS ERROR:', error);
    process.exitCode = 1;
  })
  .finally(cleanupTemp);
