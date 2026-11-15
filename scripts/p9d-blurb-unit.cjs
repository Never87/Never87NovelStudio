/**
 * P9 Batch D — Blurb Generator: PURE unit tests (no browser, no UI, no server).
 *
 * Exercises the REAL modules bundled from source with the project's own Vite
 * pipeline (`scripts/lib/p4-bundler.cjs`), so the code under test is what ships:
 *
 *   1. blurb-prompt (pure)   — length/style presets, message structure, and the
 *                              CRITICAL security rule: the prompt is built ONLY
 *                              from public-safe fields and never contains
 *                              manuscript prose / notes / secrets that the
 *                              context builder is not given.
 *   2. blurb-service         — gathers public-safe context from project/world/
 *                              narrative/characters, runs the shared AiService
 *                              with task `blurb`, strips code fences, maps errors
 *                              (project-not-found / empty-context) and NEVER
 *                              persists (the fake AiService records the request
 *                              only; the fake project service records no writes).
 *
 * Usage: npm run verify:blurb
 */
const { importBundled, cleanupTemp, projectPath } = require('./lib/p4-bundler.cjs');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  -> ${detail}` : ''}`);
}
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const ALIAS = { '@': projectPath('src') };

/* ------------------------------ fixtures -------------------------------- */

function makeProject(overrides = {}) {
  return {
    id: 'p1',
    title: '沉默之城',
    description: '一名失聪的记者调查一座消失的城市。',
    status: 'drafting',
    genre: ['悬疑', '剧情'],
    tags: ['城市', '记忆'],
    settings: { author: '作者甲', language: 'zh-CN' },
    createdAt: 1,
    updatedAt: 2,
    // A field a naive builder might leak — it must NOT be sent to the model.
    secretInternalNote: 'DO-NOT-SEND-INTERNAL-NOTE',
    ...overrides,
  };
}

function makeWorld() {
  return {
    id: 'w1',
    projectId: 'p1',
    title: '世界',
    overview: '一座被雾笼罩的沿海城市。',
    themes: ['遗忘', '记忆'],
    sections: [{ id: 's1', title: '机密设定', content: 'DO-NOT-SEND-WORLD-SECTION-BODY' }],
    createdAt: 1,
    updatedAt: 2,
  };
}

function makePlan() {
  return {
    id: 'n1',
    projectId: 'p1',
    logline: '当城市在地图上消失，只有她能记起它。',
    theme: '记忆与身份',
    premise: '记者的故乡在一夜之间从所有记录中抹除。',
    centralConflict: '她必须证明一座不存在城市的真实。',
    stakes: '真相将颠覆所有人的记忆。',
    ending: 'DO-NOT-SEND-ENDING-SPOILER',
    beats: [{ id: 'b1', title: 'DO-NOT-SEND-BEAT', description: 'x', position: 0 }],
    motifs: [],
    structure: 'three-act',
    status: 'drafting',
    createdAt: 1,
    updatedAt: 2,
  };
}

function makeCharacters() {
  return [
    { id: 'c1', projectId: 'p1', name: '林岚', role: 'protagonist', summary: '失聪的记者，执着于真相。', background: 'DO-NOT-SEND-BACKGROUND', personality: 'x', motivation: 'x', appearance: 'x', status: 'active', tags: [], createdAt: 1, updatedAt: 2 },
    { id: 'c2', projectId: 'p1', name: '周教授', role: 'antagonist', summary: '掌权者，想让城市被遗忘。', status: 'active', tags: [], createdAt: 1, updatedAt: 2 },
  ];
}

/* ------------------------------ main ------------------------------------ */

(async () => {
  let prompt;
  let service;
  try {
    prompt = await importBundled('src/modules/publishing/blurb/blurb-prompt.ts', 'p9d-prompt', { alias: ALIAS });
    service = await importBundled('src/services/blurb-service.ts', 'p9d-service', { alias: ALIAS });
  } catch (error) {
    console.error('Failed to bundle modules:\n', error);
    process.exit(1);
  }

  try {
    testPromptPresets();
    testPromptPublicSafe();
    await testServiceContext();
    await testServiceGenerate();
    await testServiceErrors();
  } finally {
    cleanupTemp();
  }

  const failures = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failures.length}/${results.length} checks passed.`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f.name}  ${f.detail ?? ''}`);
    process.exit(1);
  }
  process.exit(0);

  /* ==================== test bodies (hoisted) ==================== */

  function testPromptPresets() {
    const {
      BLURB_LENGTHS,
      BLURB_STYLES,
      BLURB_LENGTH_TARGETS,
      BLURB_STYLE_GUIDE,
      hasUsableBlurbContext,
    } = prompt;
    eq('prompt: exactly three lengths', BLURB_LENGTHS, ['short', 'standard', 'long']);
    eq('prompt: exactly four styles', BLURB_STYLES, ['suspense', 'character', 'world', 'balanced']);
    check('prompt: every length has a target range', BLURB_LENGTHS.every((l) => BLURB_LENGTH_TARGETS[l].min > 0 && BLURB_LENGTH_TARGETS[l].max > BLURB_LENGTH_TARGETS[l].min));
    check('prompt: every style has a label + emphasis', BLURB_STYLES.every((s) => BLURB_STYLE_GUIDE[s].label && BLURB_STYLE_GUIDE[s].emphasis));

    check('prompt: hasUsableBlurbContext true with title+description', hasUsableBlurbContext({ title: 'X', genre: [], tags: [], description: 'A premise.' }));
    check('prompt: hasUsableBlurbContext false with only a title', !hasUsableBlurbContext({ title: 'X', genre: [], tags: [], description: '' }));
    check('prompt: hasUsableBlurbContext true with title+premise', hasUsableBlurbContext({ title: 'X', genre: [], tags: [], premise: 'P' }));
    check('prompt: hasUsableBlurbContext false with empty title', !hasUsableBlurbContext({ title: '', genre: [], tags: [], description: 'A premise.' }));
  }

  function testPromptPublicSafe() {
    const { buildBlurbMessages } = prompt;
    const context = {
      title: '沉默之城',
      description: '一名失聪的记者调查一座消失的城市。',
      genre: ['悬疑'],
      tags: ['城市'],
      logline: '当城市消失，只有她能记起它。',
      premise: '故乡被从记录中抹除。',
      theme: '记忆',
      centralConflict: '证明一座不存在的城市。',
      stakes: '颠覆所有人的记忆。',
      worldOverview: '被雾笼罩的沿海城市。',
      worldThemes: ['遗忘'],
      // A field the builder does NOT read — must not leak.
      ending: 'DO-NOT-SEND-ENDING',
      beats: [{ title: 'DO-NOT-SEND-BEAT' }],
    };
    const messages = buildBlurbMessages(context, { length: 'standard', style: 'suspense' });

    check('prompt: returns system + user', messages.length === 2 && messages[0].role === 'system' && messages[1].role === 'user');
    check('prompt: system tells the model not to spoil', /do not spoil/i.test(messages[0].content));
    const user = messages[1].content;
    check('prompt: includes title', user.includes('沉默之城'));
    check('prompt: includes premise', user.includes('一名失聪的记者'));
    check('prompt: includes logline', user.includes('只有她能记起它'));
    check('prompt: includes world overview', user.includes('被雾笼罩的沿海城市'));
    check('prompt: includes length guidance (standard range)', user.includes('70') && user.includes('150'));
    check('prompt: includes chosen style label', /suspense/i.test(user));
    // SECURITY: fields the builder ignores must never appear.
    const all = messages.map((m) => m.content).join('\n');
    check('prompt: NEVER leaks unread context fields (ending/beats)', !all.includes('DO-NOT-SEND'));
    check('prompt: no markdown fences requested (system forbids)', /no.*(headings|labels|quotes|fences|markdown)/i.test(messages[0].content));
  }

  // Builds a BlurbService with fully fake, in-memory dependencies.
  function makeService(opts = {}) {
    const calls = { assemble: 0, generate: 0, generatedMessages: [], generatedTask: null, generatedModel: null };
    const fakeProjectService = {
      async getProject(id) {
        if (opts.missingProject) return null;
        return id === 'empty' ? makeProject({ id: 'empty', description: '', title: '无内容' }) : makeProject();
      },
      async updateProject() {
        throw new Error('blurb service must never persist via projectService');
      },
    };
    const fakeWorldService = { async getWorld() { return opts.noWorld ? null : makeWorld(); } };
    const fakeNarrativeService = { async getPlan(id) { return opts.noPlan || id === 'empty' ? null : makePlan(); } };
    const fakeCharacterService = {
      async listCharacters() { return opts.noCharacters ? [] : makeCharacters(); },
    };
    const fakeAi = {
      async generate(args) {
        calls.generate += 1;
        calls.generatedTask = args.task;
        calls.generatedModel = args.modelId ?? null;
        calls.generatedMessages = args.messages;
        if (opts.aiError) throw opts.aiError;
        return {
          result: { content: '  ```\n一段生成的简介。\n```  ', finishReason: 'stop' },
          target: {
            provider: { name: 'Fake Provider' },
            model: { displayName: 'Fake Model', modelId: 'model_x' },
            source: 'task',
          },
        };
      },
    };
    const svc = new service.BlurbService(fakeAi, {
      projectService: fakeProjectService,
      worldService: fakeWorldService,
      narrativeService: fakeNarrativeService,
      characterService: fakeCharacterService,
    });
    return { svc, calls };
  }

  async function testServiceContext() {
    const { svc } = makeService();
    const ctx = await svc.buildContext('p1');
    check('service: context carries title', ctx.title === '沉默之城');
    check('service: context carries description', ctx.description.includes('失聪'));
    check('service: context carries genre + tags', ctx.genre.includes('悬疑') && ctx.tags.includes('城市'));
    check('service: context carries narrative spine', ctx.logline && ctx.premise && ctx.centralConflict && ctx.stakes);
    check('service: context carries world overview + themes', ctx.worldOverview && ctx.worldThemes.includes('遗忘'));
    check('service: context carries characters (name/role/summary)', ctx.characters.length === 2 && ctx.characters[0].name === '林岚' && ctx.characters[0].role === 'protagonist' && ctx.characters[0].summary.includes('记者'));
    // SECURITY: context is built from whitelisted fields only.
    const json = JSON.stringify(ctx);
    check('service: context never contains internal note', !json.includes('DO-NOT-SEND-INTERNAL-NOTE'));
    check('service: context never contains world section body', !json.includes('DO-NOT-SEND-WORLD-SECTION-BODY'));
    check('service: context never contains ending/beat spoilers', !json.includes('DO-NOT-SEND-ENDING') && !json.includes('DO-NOT-SEND-BEAT'));
    check('service: context never contains character background', !json.includes('DO-NOT-SEND-BACKGROUND'));
    check('service: context has no manuscript/prose key', !('chapters' in ctx) && !('draft' in ctx) && !('content' in ctx));

    // Optional material absent → still a valid context.
    const { svc: bare } = makeService({ noWorld: true, noPlan: true, noCharacters: true });
    const bareCtx = await bare.buildContext('p1');
    check('service: missing world/plan/characters still yields context', bareCtx.title === '沉默之城' && bareCtx.characters === undefined && bareCtx.worldOverview === undefined);
  }

  async function testServiceGenerate() {
    const { svc, calls } = makeService();
    const proposal = await svc.generate({ projectId: 'p1', length: 'long', style: 'character' });

    eq('service: generate runs exactly one AI call', calls.generate, 1);
    eq('service: uses task "blurb"', calls.generatedTask, 'blurb');
    check('service: sends system + user messages to the AI', calls.generatedMessages.length === 2 && calls.generatedMessages[0].role === 'system');
    const userMsg = calls.generatedMessages[1].content;
    check('service: the AI receives the premise', userMsg.includes('失聪'));
    check('service: the AI never receives spoilers/notes', !JSON.stringify(calls.generatedMessages).includes('DO-NOT-SEND'));
    check('service: length preset reflected in the prompt', userMsg.includes('150') && userMsg.includes('300'));

    check('service: proposal carries the generated text', proposal.generatedText.includes('一段生成的简介'));
    check('service: proposal strips code fences', !proposal.generatedText.includes('```'), proposal.generatedText);
    eq('service: proposal echoes the length', proposal.length, 'long');
    eq('service: proposal echoes the style', proposal.style, 'character');
    check('service: proposal reports the target model', proposal.target.modelName === 'Fake Model' && proposal.target.providerName === 'Fake Provider');

    // Explicit model override is forwarded.
    const { svc: s2, calls: c2 } = makeService();
    await s2.generate({ projectId: 'p1', length: 'short', style: 'balanced', modelId: 'model_override' });
    eq('service: explicit modelId is forwarded to the AI', c2.generatedModel, 'model_override');

    // Extra instruction is included.
    const { svc: s3, calls: c3 } = makeService();
    await s3.generate({ projectId: 'p1', length: 'standard', style: 'world', extraInstruction: 'KEEP-UNDER-60-WORDS' });
    check('service: extra instruction reaches the prompt', c3.generatedMessages[1].content.includes('KEEP-UNDER-60-WORDS'));
  }

  async function testServiceErrors() {
    // Missing project → project-not-found.
    const { svc: missing } = makeService({ missingProject: true });
    let err1 = null;
    try { await missing.buildContext('missing'); } catch (e) { err1 = e; }
    check('service: missing project → project-not-found', err1 && err1.code === 'project-not-found' && err1.name === 'BlurbServiceError', err1 && err1.code);

    // Empty (title only, no premise) → empty-context.
    const { svc: empty, calls: emptyCalls } = makeService();
    let err2 = null;
    try { await empty.generate({ projectId: 'empty', length: 'short', style: 'balanced' }); } catch (e) { err2 = e; }
    check('service: empty context → empty-context error', err2 && err2.code === 'empty-context', err2 && err2.code);
    eq('service: empty context spends no AI call', emptyCalls.generate, 0);

    // AI failure propagates (not swallowed).
    const aiError = Object.assign(new Error('No model configured'), { name: 'AiError', kind: 'config' });
    const { svc: failing } = makeService({ aiError });
    let err3 = null;
    try { await failing.generate({ projectId: 'p1', length: 'short', style: 'balanced' }); } catch (e) { err3 = e; }
    check('service: AI errors propagate to the caller', err3 === aiError);
  }
})().catch((error) => {
  cleanupTemp();
  console.error('\nUnexpected error:', error);
  process.exit(1);
});
