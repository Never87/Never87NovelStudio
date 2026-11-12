/**
 * P4 unit tests for the autosave engine.
 *
 * Runs in plain Node (no browser). The engine is TypeScript, so it is bundled
 * with the project's own Vite/esbuild pipeline via `scripts/lib/p4-bundler.cjs`
 * — the code under test is exactly what ships, not a hand-transformed copy.
 *
 * Covers what a UI smoke test cannot observe reliably: debounce timing,
 * serialisation, staleness, conflict recovery and target switching.
 *
 * Usage: npm run verify:editor
 */
const { importBundled, cleanupTemp } = require('./lib/p4-bundler.cjs');

/* ----------------------------- test harness ----------------------------- */

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
}

async function flushMicrotasks() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** Virtual clock + timers so debounce behaviour is deterministic. */
function createClock() {
  let current = 0;
  let nextId = 1;
  const timers = new Map();

  return {
    now: () => current,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: current + ms });
      return id;
    },
    clearTimer: (id) => void timers.delete(id),
    async advance(ms) {
      const target = current + ms;
      for (;;) {
        let due = null;
        for (const entry of timers) {
          const [id, timer] = entry;
          if (timer.at <= target && (!due || timer.at < due.timer.at)) due = { id, timer };
        }
        if (!due) break;
        timers.delete(due.id);
        current = due.timer.at;
        due.timer.fn();
        await flushMicrotasks();
      }
      current = target;
      await flushMicrotasks();
    },
  };
}

/**
 * Fake store mirroring `ManuscriptService`'s contract: revision-checked writes
 * that reject a stale `expectedRevision` with a `DraftConflictError`.
 */
function createFakeStore() {
  const state = { content: '', revision: 0, writes: [], failNext: 0, conflictOnce: false };
  return {
    state,
    async save(target, input, options) {
      const ownerId = target.ownerId;
      state.writes.push({
        ownerId,
        projectId: target.projectId,
        content: input.content,
        expected: input.expectedRevision,
        options,
      });
      await flushMicrotasks();

      if (state.failNext > 0) {
        state.failNext -= 1;
        const error = new Error('Simulated storage failure');
        error.name = 'ProjectRepositoryError';
        throw error;
      }
      if (state.conflictOnce) {
        state.conflictOnce = false;
        state.revision += 1; // another writer advanced it meanwhile
        const error = new Error('stale revision');
        error.name = 'DraftConflictError';
        error.currentRevision = state.revision;
        throw error;
      }
      if (input.expectedRevision !== undefined && input.expectedRevision !== state.revision) {
        const error = new Error(`expected ${input.expectedRevision}, current ${state.revision}`);
        error.name = 'DraftConflictError';
        error.currentRevision = state.revision;
        throw error;
      }
      state.content = input.content;
      state.revision += 1;
      return {
        draft: { id: `draft_${ownerId}`, revision: state.revision, content: input.content },
        changed: true,
        snapshot: false,
      };
    },
  };
}

/* --------------------------------- tests -------------------------------- */

async function main() {
  const { AutosaveEngine } = await importBundled(
    'src/modules/editor/autosave-engine.ts',
    'autosave-engine',
  );

  const make = (store, clock, extra = {}) =>
    new AutosaveEngine(store, {
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      ...extra,
    });

  // 1 — debounce coalesces rapid edits into one write of the final text.
  {
    const clock = createClock();
    const store = createFakeStore();
    const engine = make(store, clock, { debounceMs: 500, maxWaitMs: 10_000 });
    engine.bind({ projectId: 'p1', ownerId: 'c1', revision: 0, content: '' });

    engine.update('a');
    await clock.advance(200);
    engine.update('ab');
    await clock.advance(200);
    engine.update('abc');
    await clock.advance(500);

    record(
      'debounce: rapid edits → one write with the final text',
      store.state.writes.length === 1 && store.state.writes[0].content === 'abc',
      `writes=${store.state.writes.length} last=${JSON.stringify(store.state.writes.at(-1)?.content ?? null)}`,
    );
  }

  // 2 — maxWait forces periodic saves during continuous typing.
  {
    const clock = createClock();
    const store = createFakeStore();
    const engine = make(store, clock, { debounceMs: 1_000, maxWaitMs: 2_500 });
    engine.bind({ projectId: 'p1', ownerId: 'c1', revision: 0, content: '' });

    for (let i = 0; i < 4; i += 1) {
      engine.update('x'.repeat(i + 1));
      await clock.advance(900);
    }

    record(
      'maxWait: continuous typing still saves periodically',
      store.state.writes.length >= 1,
      `writes=${store.state.writes.length}`,
    );
  }

  // 3 — reverting to the persisted value cancels the pending write.
  {
    const clock = createClock();
    const store = createFakeStore();
    const engine = make(store, clock, { debounceMs: 300 });
    engine.bind({ projectId: 'p1', ownerId: 'c1', revision: 0, content: 'saved' });

    engine.update('changed');
    engine.update('saved');
    await clock.advance(600);

    record(
      'dirty→clean: reverting text cancels the write',
      store.state.writes.length === 0 && engine.snapshot().dirty === false,
      `writes=${store.state.writes.length} status=${engine.snapshot().status}`,
    );
  }

  // 4 — concurrent flush calls never double-write the same text.
  {
    const clock = createClock();
    const store = createFakeStore();
    const engine = make(store, clock, { debounceMs: 50 });
    engine.bind({ projectId: 'p1', ownerId: 'c1', revision: 0, content: '' });

    engine.update('one');
    await Promise.all([engine.flush(), engine.flush(), engine.flush()]);

    record(
      'concurrent flush: one write, no duplicate',
      store.state.writes.length === 1 && store.state.revision === 1,
      `writes=${store.state.writes.length} revision=${store.state.revision}`,
    );
  }

  // 5 — edits arriving mid-flight are written after, with the newer text.
  {
    const clock = createClock();
    const store = createFakeStore();
    const engine = make(store, clock, { debounceMs: 50 });
    engine.bind({ projectId: 'p1', ownerId: 'c1', revision: 0, content: '' });

    engine.update('first');
    const flushing = engine.flush();
    engine.update('second'); // arrives mid-flight
    await flushing;

    const contents = store.state.writes.map((w) => w.content);
    record(
      'in-flight edit: newer text is written, older is not re-sent',
      contents.join('|') === 'first|second' && store.state.content === 'second',
      `writes=[${contents.join(', ')}] final=${JSON.stringify(store.state.content)}`,
    );
  }

  // 6 — a stale revision is reconciled, never silently overwritten.
  {
    const clock = createClock();
    const store = createFakeStore();
    const engine = make(store, clock, { debounceMs: 50 });
    engine.bind({ projectId: 'p1', ownerId: 'c1', revision: 0, content: '' });

    engine.update('mine');
    store.state.conflictOnce = true;
    await engine.flush();

    record(
      'conflict: recovers, keeps user text, records the conflict',
      store.state.content === 'mine' &&
        engine.snapshot().conflicts === 1 &&
        engine.snapshot().status === 'saved',
      `final=${JSON.stringify(store.state.content)} conflicts=${engine.snapshot().conflicts} status=${engine.snapshot().status}`,
    );
  }

  // 7 — a failed save keeps the text; retry resends it.
  {
    const clock = createClock();
    const store = createFakeStore();
    const engine = make(store, clock, { debounceMs: 50 });
    engine.bind({ projectId: 'p1', ownerId: 'c1', revision: 0, content: '' });

    engine.update('fragile');
    store.state.failNext = 1;
    await engine.flush();
    const afterFailure = { status: engine.snapshot().status, dirty: engine.snapshot().dirty };

    await engine.retry();

    record(
      'failure→retry: text is preserved and sent on retry',
      afterFailure.status === 'error' &&
        afterFailure.dirty === true &&
        store.state.content === 'fragile' &&
        engine.snapshot().status === 'saved',
      `afterFailure=${JSON.stringify(afterFailure)} final=${JSON.stringify(store.state.content)}`,
    );
  }

  // 8 — switching targets flushes the outgoing document first.
  {
    const clock = createClock();
    const store = createFakeStore();
    const engine = make(store, clock, { debounceMs: 5_000 });
    engine.bind({ projectId: 'p1', ownerId: 'chapterA', revision: 0, content: '' });
    engine.update('A text');

    await engine.switchTo({ projectId: 'p1', ownerId: 'chapterB', revision: 0, content: '' });
    engine.update('B text');
    await engine.flush();

    const aWrite = store.state.writes.find((w) => w.ownerId === 'chapterA');
    const bWrite = store.state.writes.find((w) => w.ownerId === 'chapterB');
    record(
      'switch: outgoing chapter is flushed, new edits target the new chapter',
      aWrite?.content === 'A text' &&
        bWrite?.content === 'B text' &&
        engine.snapshot().dirty === false,
      `A=${JSON.stringify(aWrite?.content ?? null)} B=${JSON.stringify(bWrite?.content ?? null)}`,
    );
  }

  // 9 — a disposed engine never writes (unmount / navigation safety).
  {
    const clock = createClock();
    const store = createFakeStore();
    const engine = make(store, clock, { debounceMs: 200 });
    engine.bind({ projectId: 'p1', ownerId: 'c1', revision: 0, content: '' });
    engine.update('too late');
    engine.dispose();
    await clock.advance(1_000);

    record(
      'dispose: pending timers are cancelled, nothing is written',
      store.state.writes.length === 0,
      `writes=${store.state.writes.length}`,
    );
  }

  // 10 — every write carries the revision it is based on AND its project.
  {
    const clock = createClock();
    const store = createFakeStore();
    const engine = make(store, clock, { debounceMs: 10 });
    engine.bind({ projectId: 'proj_test', ownerId: 'c1', revision: 0, content: '' });

    engine.update('scoped');
    await engine.flush();

    record(
      'store receives the target project (writes stay project-scoped)',
      store.state.writes[0]?.projectId === 'proj_test' &&
        store.state.writes[0]?.ownerId === 'c1',
      `projectId=${store.state.writes[0]?.projectId} ownerId=${store.state.writes[0]?.ownerId}`,
    );
  }

  // 11 — every write carries the revision it is based on.
  {
    const clock = createClock();
    const store = createFakeStore();
    const engine = make(store, clock, { debounceMs: 10 });
    engine.bind({ projectId: 'p1', ownerId: 'c1', revision: 0, content: '' });

    engine.update('one');
    await engine.flush();
    engine.update('two');
    await engine.flush();

    const expected = store.state.writes.map((w) => w.expected);
    record(
      'optimistic concurrency: each write sends the revision it is based on',
      expected.join(',') === '0,1',
      `expected=[${expected.join(', ')}]`,
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\nTOTAL ${results.length}  PASS ${results.length - failed.length}  FAIL ${failed.length}`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error('HARNESS ERROR:', error);
    process.exitCode = 1;
  })
  .finally(cleanupTemp);
