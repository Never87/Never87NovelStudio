# Bundled font: Noto Sans SC (subset)

`NotoSansSC-Regular-subset.ttf` is a subset of **Noto Sans SC** used ONLY to embed
a real Chinese-capable font into exported PDF files (P9 Batch C — PDF writer).
Exports work entirely offline; nothing is fetched from the network or the user's
operating system at export time — this file ships with the app.

## Source & license

- Font: **Noto Sans SC** (Simplified Chinese), Regular instance.
- Upstream copyright: `© 2014-2021 Adobe (http://www.adobe.com/), with Reserved
  Font Name 'Source'.` Noto Sans SC is derived from Source Han Sans.
- License: **SIL Open Font License, Version 1.1** (see `OFL.txt`). The OFL permits
  embedding in documents and redistribution, including embedding this font inside a
  PDF and shipping the font file with this project. The font is NOT sold on its own
  and keeps its reserved font name.

## How this subset was produced

The bundled file is a **subset** of the upstream Noto Sans SC variable font,
instanced at `wght=400` (Regular) and subset to the following Unicode ranges so it
can render common Simplified Chinese prose, Latin, digits and punctuation without
carrying unused glyphs (e.g. rare CJK Extension-A ideographs):

- U+0020–U+007E  Basic Latin
- U+00A0–U+00FF  Latin-1 Supplement
- U+2000–U+206F  General Punctuation
- U+2190–U+21FF  Arrows
- U+2460–U+24FF  Enclosed Alphanumerics
- U+2500–U+257F  Box Drawing
- U+3000–U+303F  CJK Symbols and Punctuation
- U+4E00–U+9FFF  CJK Unified Ideographs (the full common block — 20,992 chars)
- U+F900–U+FAFF  CJK Compatibility Ideographs
- U+FF00–U+FFEF  Halfwidth and Fullwidth Forms

Result: 21,924 mapped code points / ~21.8k glyphs, ~7.4 MB TTF. The full common
Simplified Chinese ideograph block is retained — no common character is removed for
size; only rare, unused extension blocks and unneeded hinting/shaping tables are
dropped.

## Distribution note

This file is served as a static asset at `/fonts/NotoSansSC-Regular-subset.ttf` and
fetched on demand only when a PDF is generated. It is not bundled into the main JS.
Keep `OFL.txt` alongside it when redistributing.
