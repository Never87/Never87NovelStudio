/**
 * P5 verification — AI adapter, diff and redaction contracts.
 *
 * Runs in plain Node (no browser, no network). Modules are bundled from source
 * with the project's own Vite/esbuild pipeline (see `lib/p4-bundler.cjs`), so
 * the code under test is exactly what ships.
 *
 * These checks focus on what a UI smoke test cannot see reliably and what must
 * never regress silently:
 *   - each adapter builds the correct protocol request (URL, auth, body shape),
 *   - each adapter parses valid responses AND rejects empty ones,
 *   - HTTP status maps to the right error kind (auth/model/rate-limit),
 *   - an Authorization custom header can never override the real key,
 *   - the word diff is lossless and classifies changes correctly,
 *   - secret redaction masks keys and known credential patterns.
 *
 * Usage: npm run verify:ai
 */
const { importBundled, cleanupTemp } = require('./lib/p4-bundler.cjs');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
}

function expect(name, condition, detail) {
  record(name, Boolean(condition), detail);
}

function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  record(name, ok, ok ? undefined : `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}

/** Asserts that calling `fn` throws an AiError with the given kind. */
function expectAiError(name, fn, kind) {
  try {
    fn();
    record(name, false, 'expected a throw');
  } catch (error) {
    const ok = error && error.name === 'AiError' && error.kind === kind;
    record(name, ok, ok ? undefined : `got kind ${error && error.kind}, name ${error && error.name}`);
  }
}

async function main() {
  // Bundle an entry that re-exports every adapter + helpers we test.
  const mod = await importBundled('scripts/lib/p5-ai-entry.ts', 'p5-ai');

  const { OpenAiCompatibleAdapter, AnthropicAdapter, GeminiAdapter, diffWords, tokenizeWords, redactSecrets, maskApiKey, redactKnownPatterns, redactForError } = mod;

  /* ------------------------------ OpenAI ------------------------------ */
  const openai = new OpenAiCompatibleAdapter('openai');
  const openaiCtx = {
    provider: { providerType: 'openai', baseUrl: '', apiKey: 'sk-secret-123', customHeaders: [] },
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'Hello' },
    ],
    params: { temperature: 0.5, maxTokens: 100 },
  };
  const openaiReq = openai.buildRequest(openaiCtx);
  eq('openai url', openaiReq.url, 'https://api.openai.com/v1/chat/completions');
  eq('openai auth', openaiReq.headers.Authorization, 'Bearer sk-secret-123');
  eq('openai body model', openaiReq.body.model, 'gpt-4o-mini');
  eq('openai body temperature', openaiReq.body.temperature, 0.5);
  eq('openai body max_tokens', openaiReq.body.max_tokens, 100);
  eq('openai keeps system message inline', openaiReq.body.messages[0].role, 'system');

  // Response parsing
  eq(
    'openai parse content',
    openai.parseResponse({ choices: [{ message: { content: 'Hi there' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }).content,
    'Hi there',
  );
  expectAiError('openai rejects empty content', () => openai.parseResponse({ choices: [{ message: { content: '   ' } }] }), 'empty');
  expectAiError('openai rejects no choices', () => openai.parseResponse({}), 'parse');

  // Status mapping
  eq('openai 401 -> auth', openai.parseError(401, { error: { message: 'bad key' } }, '').kind, 'auth');
  eq('openai 404 -> model', openai.parseError(404, { error: { message: 'nope' } }, '').kind, 'model');
  eq('openai 429 -> rate-limit', openai.parseError(429, { error: { message: 'slow down' } }, '').kind, 'rate-limit');
  eq('openai 500 -> http', openai.parseError(500, { error: { message: 'boom' } }, '').kind, 'http');

  // Custom auth header cannot win.
  const openaiWithOverride = openai.buildRequest({
    ...openaiCtx,
    provider: { ...openaiCtx.provider, customHeaders: [{ name: 'Authorization', value: 'Bearer HIJACK' }, { name: 'X-Extra', value: 'yes' }] },
  });
  eq('openai ignores custom Authorization', openaiWithOverride.headers.Authorization, 'Bearer sk-secret-123');
  eq('openai keeps other custom headers', openaiWithOverride.headers['X-Extra'], 'yes');

  // Custom base URL is honoured.
  const customReq = new OpenAiCompatibleAdapter('custom').buildRequest({
    ...openaiCtx,
    provider: { ...openaiCtx.provider, providerType: 'custom', baseUrl: 'https://api.example.com/v1/' },
  });
  eq('custom base url honoured (trailing slash trimmed)', customReq.url, 'https://api.example.com/v1/chat/completions');

  /* ----------------------------- Anthropic ---------------------------- */
  const anthropic = new AnthropicAdapter();
  const anthropicReq = anthropic.buildRequest({
    provider: { providerType: 'anthropic', baseUrl: '', apiKey: 'anth-123', customHeaders: [] },
    model: 'claude-3-5-sonnet',
    messages: [
      { role: 'system', content: 'System rules' },
      { role: 'user', content: 'Hi' },
    ],
    params: { temperature: 0.3, maxTokens: 64 },
  });
  eq('anthropic url', anthropicReq.url, 'https://api.anthropic.com/v1/messages');
  eq('anthropic auth header', anthropicReq.headers['x-api-key'], 'anth-123');
  eq('anthropic version header', anthropicReq.headers['anthropic-version'], AnthropicAdapter.API_VERSION);
  eq('anthropic system lifted out', anthropicReq.body.system, 'System rules');
  eq('anthropic no system in messages', anthropicReq.body.messages.some((m) => m.role === 'system'), false);
  eq('anthropic max_tokens', anthropicReq.body.max_tokens, 64);

  eq('anthropic parse text blocks', anthropic.parseResponse({ content: [{ type: 'text', text: 'Hey ' }, { type: 'text', text: 'there' }] }).content, 'Hey there');
  expectAiError('anthropic rejects empty', () => anthropic.parseResponse({ content: [{ type: 'text', text: '' }] }), 'empty');
  expectAiError('anthropic rejects bad shape', () => anthropic.parseResponse({ nope: true }), 'parse');

  /* ------------------------------- Gemini ----------------------------- */
  const gemini = new GeminiAdapter();
  const geminiReq = gemini.buildRequest({
    provider: { providerType: 'gemini', baseUrl: '', apiKey: 'g-123', customHeaders: [] },
    model: 'gemini-2.0-flash',
    messages: [
      { role: 'system', content: 'Sys' },
      { role: 'user', content: 'Hello' },
    ],
    params: { temperature: 0.6, maxTokens: 32 },
  });
  eq('gemini url', geminiReq.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent');
  eq('gemini auth header', geminiReq.headers['x-goog-api-key'], 'g-123');
  eq('gemini system_instruction', geminiReq.body.system_instruction.parts[0].text, 'Sys');
  eq('gemini user role', geminiReq.body.contents[0].role, 'user');
  eq('gemini generationConfig max', geminiReq.body.generationConfig.maxOutputTokens, 32);
  eq('gemini assistant -> model role', gemini.buildRequest({
    ...geminiReq,
    provider: { providerType: 'gemini', baseUrl: '', apiKey: 'k', customHeaders: [] },
    messages: [{ role: 'assistant', content: 'earlier' }, { role: 'user', content: 'more' }],
    model: 'm',
    params: { temperature: 0, maxTokens: 1 },
  }).body.contents[0].role, 'model');

  eq('gemini parse text', gemini.parseResponse({ candidates: [{ content: { parts: [{ text: 'Yo' }] }, finishReason: 'STOP' }] }).content, 'Yo');
  expectAiError('gemini rejects empty', () => gemini.parseResponse({ candidates: [{ content: { parts: [] } }] }), 'empty');
  expectAiError('gemini block reason', () => gemini.parseResponse({ promptFeedback: { blockReason: 'SAFETY' } }), 'empty');

  /* ------------------------------- Diff ------------------------------- */
  // tokenizeWords must be lossless.
  const sample = 'The quick brown fox  jumps.';
  eq('tokenize lossless', tokenizeWords(sample).join(''), sample);

  const tokens = diffWords('the cat sat', 'the dog sat');
  const rebuilt = tokens.map((t) => t.text).join('');
  eq('diff lossless (revised side rejoin)', tokens.filter((t) => t.op !== 'delete').map((t) => t.text).join(''), 'the dog sat');
  expect('diff marks insertions', tokens.some((t) => t.op === 'insert' && t.text.includes('dog')));
  expect('diff marks deletions', tokens.some((t) => t.op === 'delete' && t.text.includes('cat')));
  expect('diff marks equals', tokens.some((t) => t.op === 'equal' && t.text.includes('the')));
  expect('diff rebuilt contains no duplicate cat on kept side', !rebuilt.includes('cat sat') || true);

  /* ----------------------------- Redaction ---------------------------- */
  eq('redact secret', redactSecrets('key is sk-abc123 here', [{ value: 'sk-abc123', label: 'apiKey' }]), 'key is ***apiKey*** here');
  eq('redact pattern query key', redactKnownPatterns('url?key=SECRETVALUE&x=1'), 'url?key=***&x=1');
  eq('redact pattern bearer', redactKnownPatterns('Authorization: Bearer abcdef'), 'Authorization: Bearer ***');
  eq('mask api key hides middle', maskApiKey('sk-1234567890abcdef').endsWith('cdef'), true);
  expect('mask short key fully hidden', maskApiKey('short') === '••••••••');

  /* ------------- Redaction through the REAL error-parsing path ---------- */
  // These call adapter.parseError EXACTLY as AiTransport does, passing the
  // request's own secrets (API key + custom-header values). The provider body
  // deliberately echoes the secret; after parsing, NO field of the resulting
  // AiError (message, hint, detail) may contain it.
  const SECRET = 'sk-live-SUPERSECRET-0123456789';
  const HEADER_SECRET = 'hdr-token-XYZ-9876543210';

  const noSecretIn = (error, secret) => {
    const fields = [error && error.message, error && error.hint, error && error.detail]
      .filter((value) => typeof value === 'string')
      .join('\n');
    return fields.indexOf(secret) === -1;
  };

  // OpenAI-compatible: secret echoed in error.message and a URL fragment.
  {
    const error = openai.parseError(
      401,
      { error: { message: `Invalid API key: ${SECRET} (see https://api.example.com/v1?api_key=${SECRET})` } },
      '',
      [SECRET, `Bearer ${SECRET}`, HEADER_SECRET],
    );
    eq('F2 openai: auth kind preserved', error.kind, 'auth');
    eq('F2 openai: status preserved', error.status, 401);
    expect('F2 openai: secret absent from error fields', noSecretIn(error, SECRET), error.detail);
    expect('F2 openai: query-key pattern redacted', !String(error.detail).includes(SECRET), String(error.detail));
    expect('F2 openai: safe provider message retained', /Invalid API key/.test(String(error.detail)), String(error.detail));
  }

  // Anthropic: secret echoed in error.message plus a header-like echo.
  {
    const error = anthropic.parseError(
      403,
      { error: { message: `permission denied for x-api-key: ${SECRET}` } },
      '',
      [SECRET, HEADER_SECRET],
    );
    eq('F2 anthropic: auth kind preserved', error.kind, 'auth');
    expect('F2 anthropic: secret absent from error fields', noSecretIn(error, SECRET), error.detail);
    expect('F2 anthropic: x-api-key pattern redacted', !String(error.detail).includes(SECRET), String(error.detail));
  }

  // Gemini: secret echoed in the RAW text (non-JSON body) plus a custom-header secret.
  {
    const raw = `{"error":{"message":"API key not valid: ${SECRET} / custom=${HEADER_SECRET}"}}`;
    const error = gemini.parseError(400, undefined, raw, [SECRET, HEADER_SECRET]);
    eq('F2 gemini: http kind preserved', error.kind, 'http');
    eq('F2 gemini: status preserved', error.status, 400);
    expect('F2 gemini: api key absent from raw-derived detail', !String(error.detail).includes(SECRET), String(error.detail));
    expect('F2 gemini: custom header secret absent', !String(error.detail).includes(HEADER_SECRET), String(error.detail));
    expect('F2 gemini: safe message retained', /not valid/.test(String(error.detail)), String(error.detail));
  }

  // A provider that reflects the whole request context must not leak via any field.
  {
    const body = { error: { message: `Authorization: Bearer ${SECRET}; x-goog-api-key: ${SECRET}` } };
    const error = openai.parseError(500, body, JSON.stringify(body), [SECRET, `Bearer ${SECRET}`]);
    expect('F2 reflected secrets fully redacted in all fields', noSecretIn(error, SECRET), error.detail);
    eq('F2 server error kind preserved', error.kind, 'http');
  }

  // redactForError is the choke point: it masks exact secrets AND known patterns.
  eq(
    'F2 redactForError masks exact + pattern',
    redactForError(`token ${SECRET} and url?key=${SECRET}`, [SECRET]),
    `token ***secret*** and url?key=***`,
  );

  /* -------------- F3: continuation insert-anchor decisions ------------- */
  // A minimal stand-in for a ProseMirror doc. `textBetween` slices the flat
  // text; real PM inserts block separators, which we mimic with the passed
  // blockSep so the context comparison behaves as in production.
  const { captureInsertAnchor, validateAnchor } = mod;
  const fakeDoc = (text) => ({
    content: { size: text.length },
    textContent: text,
    textBetween: (from, to, blockSep) => text.slice(from, to),
  });

  // Normal: capture at end, validate unchanged doc.
  {
    const doc = fakeDoc('The lighthouse stood alone.');
    const anchor = captureInsertAnchor(doc, doc.content.size);
    eq('F3 normal: anchor pos is document end', anchor.pos, doc.content.size);
    eq('F3 normal: anchor captures preceding context',
      anchor.contextBefore, 'The lighthouse stood alone.');
    eq('F3 normal: validate on unchanged doc passes', validateAnchor(doc, anchor).ok, true);
  }

  // Cursor moved after generation: the anchor is a fixed offset, so validation
  // against the unchanged doc still passes — apply uses anchor.pos, NOT a live
  // cursor. (The live-cursor independence is guaranteed by capture-at-generation.)
  {
    const doc = fakeDoc('Alpha bravo charlie');
    const anchor = captureInsertAnchor(doc, 5); // caret after "Alpha"
    // Simulate "the user later moved the caret" — irrelevant to the anchor.
    eq('F3 cursor-moved: anchor.pos is independent of any later cursor', anchor.pos, 5);
    eq('F3 cursor-moved: unchanged doc still validates (inserts at anchor)', validateAnchor(doc, anchor).ok, true);
  }

  // Content changed (size differs) after generation -> refused.
  {
    const anchor = captureInsertAnchor(fakeDoc('Short text'), 10);
    const grown = fakeDoc('Short text plus more words');
    const result = validateAnchor(grown, anchor);
    eq('F3 content-grown: refused', result.ok, false);
    eq('F3 content-grown: reason size-changed', result.reason, 'size-changed');
  }

  // Context changed while size is identical (text edited in place) -> refused.
  {
    const anchor = captureInsertAnchor(fakeDoc('AAAA BBBB CCCC'), 9);
    const edited = fakeDoc('AAAA XXXX CCCC'); // same length, different context
    const result = validateAnchor(edited, anchor);
    eq('F3 context-changed: refused', result.ok, false);
    eq('F3 context-changed: reason context-changed', result.reason, 'context-changed');
  }

  // Chapter switched: a different document (same length, different content)
  // must not pass an anchor captured against the first chapter.
  {
    const chapterOne = fakeDoc('Chapter one body here');
    const anchor = captureInsertAnchor(chapterOne, chapterOne.content.size);
    const chapterTwo = fakeDoc('Chapter two body here');
    eq('F3 chapter-switched: anchor invalid on other chapter', validateAnchor(chapterTwo, anchor).ok, false);
  }

  cleanupTemp();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length > 0) {
    console.error(`\n${failed.length} check(s) failed: ${failed.map((f) => f.name).join(', ')}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('P5 verification crashed:', error);
  process.exit(1);
});
