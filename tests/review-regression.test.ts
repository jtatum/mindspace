import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { Readable } from 'node:stream';
import test from 'node:test';
import type { Participant } from '../src/shared/types.js';
import { CodexRuntime } from '../src/server/runtime/codex.js';
import type { WireMessage } from '../src/server/runtime/rpc.js';
import type { AgentRuntime, RuntimeHooks, RuntimeTurnResult } from '../src/server/runtime/types.js';
import { Scheduler } from '../src/server/scheduler.js';
import { Store } from '../src/server/store.js';
import { webFetch } from '../src/server/web-fetch.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function sessionFixture() {
  const store = new Store(':memory:');
  const human = store.createIdentity('Reviewer');
  const snapshot = store.createSession({
    title: 'Runtime regression', task: 'Discuss the task.',
    agents: ['A', 'B', 'C'].map(name => ({ name, instructions: '' })),
  }, human, 'simulation');
  return { store, snapshot, agent: snapshot.participants.find(p => p.kind === 'agent')! };
}

for (const identifierSource of ['response', 'notification'] as const) {
  test(`pause interrupts a turn whose ID arrives later through the ${identifierSource}`, async () => {
    const { store, agent } = sessionFixture();
    const startRequested = deferred<void>();
    const startResponse = deferred<{ turn: { id: string } }>();
    const requests: Array<{ method: string; params: any }> = [];
    const hooks: RuntimeHooks = {
      onActivity() {}, onThread() {}, onUsage() {}, onTurnStarted() {}, onTool: async () => ({}),
    };
    const runtime = new CodexRuntime(agent, hooks, '/unused-test-runtime');
    // Inject only the transport boundary: no Codex process, login file, or model call.
    const internals = runtime as unknown as {
      initialization: Promise<void>;
      rpc: { request(method: string, params: unknown): Promise<unknown>; close(): Promise<void> };
      handle(message: WireMessage): Promise<void>;
    };
    internals.initialization = Promise.resolve();
    internals.rpc = {
      request: async (method, params) => {
        requests.push({ method, params });
        if (method === 'turn/start') { startRequested.resolve(); return startResponse.promise; }
        return {};
      },
      close: async () => {},
    };
    const running = runtime.run({ text: 'Begin working.', messageId: 'input-before-pause' });
    try {
      await startRequested.promise;
      await runtime.interrupt();
      assert.equal(requests.filter(item => item.method === 'turn/interrupt').length, 0, 'the ID is not known yet');
      if (identifierSource === 'notification') {
        await internals.handle({ method: 'turn/started', params: { turn: { id: 'late-turn' } } });
      } else {
        startResponse.resolve({ turn: { id: 'late-turn' } });
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      assert.ok(requests.some(item => item.method === 'turn/interrupt' && item.params.turnId === 'late-turn'), 'the already-paused turn must be interrupted as soon as its ID is known');
    } finally {
      startResponse.resolve({ turn: { id: 'late-turn' } });
      await runtime.close();
      assert.equal((await running).status, 'interrupted');
      store.close();
    }
  });
}

test('a retried tool call stays deduplicated when its persistent runtime is reconstructed', async () => {
  const { store, snapshot, agent } = sessionFixture();
  const sessionId = snapshot.session.id;
  store.updateSession(sessionId, { status: 'running' });
  let hooks!: RuntimeHooks;
  const factory = (_participant: Participant, callbacks: RuntimeHooks): AgentRuntime => {
    hooks = callbacks;
    return {
      run: async () => ({ turnId: 'unused', status: 'completed' }),
      steer: async () => true, interrupt: async () => {}, close: async () => {},
    };
  };
  const original = new Scheduler(store, factory);
  const restored = new Scheduler(store, factory);
  const initialize = (scheduler: Scheduler, participant: Participant) =>
    (scheduler as unknown as { getRuntime(agent: Participant): AgentRuntime }).getRuntime(participant);
  try {
    initialize(original, agent);
    hooks.onThread('durable-thread-id');
    const first = await hooks.onTool('send_group_message', { body: 'One contribution.' }, 'durable-call-id');
    initialize(restored, store.getParticipant(sessionId, agent.id));
    const replay = await hooks.onTool('send_group_message', { body: 'One contribution.' }, 'durable-call-id');
    assert.deepEqual(replay, first);
    assert.equal(store.snapshot(sessionId).messages.filter(message => message.senderId === agent.id).length, 1);
  } finally {
    await original.shutdown(); await restored.shutdown(); store.close();
  }
});

test('resume during interrupt completion preserves the canceled round and starts a fresh round', async () => {
  const { store, snapshot } = sessionFixture();
  const sessionId = snapshot.session.id;
  const firstStarted = deferred<void>();
  const interrupted = deferred<RuntimeTurnResult>();
  let turnCount = 0;
  const scheduler = new Scheduler(store, (_agent, hooks) => ({
    run: async () => {
      const turnId = `test-turn-${++turnCount}`;
      hooks.onTurnStarted(turnId);
      if (turnCount === 1) { firstStarted.resolve(); return interrupted.promise; }
      return { turnId, status: 'completed' };
    },
    steer: async () => true,
    // App Server acknowledges interrupt before turn/completed arrives.
    interrupt: async () => {}, close: async () => {},
  }));
  try {
    await scheduler.control(sessionId, 'start');
    await firstStarted.promise;
    await scheduler.control(sessionId, 'pause');
    const canceled = store.snapshot(sessionId).rounds[0];
    assert.equal(canceled.status, 'interrupted');
    assert.deepEqual(canceled.opportunities.map(item => item.status), ['failed', 'skipped', 'skipped']);
    await scheduler.control(sessionId, 'resume');
    interrupted.resolve({ turnId: 'test-turn-1', status: 'interrupted' });
    for (let attempt = 0; attempt < 50 && store.getSession(sessionId).status !== 'idle'; attempt++) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    const resumed = store.snapshot(sessionId);
    assert.deepEqual(resumed.rounds.find(round => round.id === canceled.id), canceled, 'old turn completion must not rewrite the interrupted round');
    assert.equal(resumed.rounds.length, 2, 'resume must advance again after the canceled scheduler generation exits');
    assert.equal(resumed.rounds[1].status, 'completed');
    assert.equal(resumed.session.status, 'idle');
  } finally {
    interrupted.resolve({ turnId: 'test-turn-1', status: 'interrupted' });
    await scheduler.shutdown(); store.close();
  }
});

test('public web fetch pins DNS while supporting Node all-address and single-address lookups', async t => {
  const approvedAddress = { address: '93.184.216.34', family: 4 };
  const lookups: string[] = [];
  t.mock.method(dns, 'lookup', async (hostname: string) => { lookups.push(hostname); return [approvedAddress]; });
  syncBuiltinESMExports();
  let pinnedLookupChecked = false;
  t.mock.method(http, 'get', ((_url: URL, options: any, onResponse: (response: unknown) => void) => {
    const request = new EventEmitter() as EventEmitter & { destroy(error: Error): void };
    request.destroy = error => { request.emit('error', error); request.emit('close'); };
    queueMicrotask(() => {
      try {
        options.lookup('research.example', { all: true }, (error: Error | null, addresses: unknown) => {
          assert.equal(error, null);
          assert.deepEqual(addresses, [approvedAddress], 'Node autoSelectFamily requires an address array');
        });
        options.lookup('research.example', { all: false }, (error: Error | null, address: string, family: number) => {
          assert.equal(error, null); assert.equal(address, approvedAddress.address); assert.equal(family, 4);
        });
        pinnedLookupChecked = true;
        const response = Object.assign(Readable.from([Buffer.from('<p>A useful paper.</p>')]), {
          statusCode: 200, headers: { 'content-type': 'text/html' },
        });
        response.on('end', () => request.emit('close'));
        onResponse(response);
      } catch (error) { request.destroy(error as Error); }
    });
    return request;
  }) as typeof http.get);
  try {
    const result = await webFetch('http://research.example/paper');
    assert.equal(result.text, 'A useful paper.');
    assert.equal(result.url, 'http://research.example/paper');
    assert.deepEqual(lookups, ['research.example']);
    assert.equal(pinnedLookupChecked, true);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
