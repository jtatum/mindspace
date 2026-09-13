import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { subscribeSessionEvents } from '../src/client/session-events.js';

type Snapshot = { eventSeq: number };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class FakeSource extends EventTarget {
  closed = false;
  constructor(readonly url: string) { super(); }
  close() { this.closed = true; }
  emit(type: string) { this.dispatchEvent(new Event(type)); }
}
function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sources: FakeSource[] = [];
  const requests: Array<ReturnType<typeof deferred<Snapshot>> & { signal: AbortSignal }> = [];
  const received: Snapshot[] = [];
  const connected: boolean[] = [];
  const state = { cursor: 5, current: true };
  const dispose = subscribeSessionEvents({
    sessionId: 'session-1',
    getCursor: () => state.cursor,
    isCurrent: () => state.current,
    fetchSnapshot: signal => {
      const request = { ...deferred<Snapshot>(), signal };
      requests.push(request);
      return request.promise;
    },
    receiveSnapshot: value => { received.push(value); state.cursor = value.eventSeq; },
    setConnected: value => { connected.push(value); },
    createEventSource: url => { const source = new FakeSource(url); sources.push(source); return source; },
  });
  t.after(dispose);
  return { sources, requests, received, connected, state, dispose, tick: (milliseconds: number) => t.mock.timers.tick(milliseconds) };
}
async function settle() { await Promise.resolve(); await Promise.resolve(); }

test('stream events coalesce, including updates received during a snapshot request', async t => {
  const ctx = setup(t);
  assert.equal(ctx.sources[0].url, '/api/sessions/session-1/events?after=5');
  ctx.sources[0].emit('open');
  ctx.sources[0].emit('update');
  ctx.sources[0].emit('message');
  ctx.tick(99);
  assert.equal(ctx.requests.length, 0);
  ctx.tick(1);
  assert.equal(ctx.requests.length, 1);
  ctx.sources[0].emit('update');
  ctx.sources[0].emit('message');
  ctx.tick(100);
  assert.equal(ctx.requests.length, 1, 'only one request may be in flight');
  ctx.requests[0].resolve({ eventSeq: 10 });
  await settle();
  ctx.tick(99);
  assert.equal(ctx.requests.length, 1);
  ctx.tick(1);
  assert.equal(ctx.requests.length, 2, 'events during a fetch need one follow-up snapshot');
  ctx.requests[1].resolve({ eventSeq: 12 });
  await settle();
  assert.equal(ctx.state.cursor, 12);
  assert.deepEqual(ctx.connected, [false, true], 'snapshot success does not report stream connectivity');
});

test('stream failure refreshes authentication before reconnecting from the latest snapshot cursor', async t => {
  const ctx = setup(t);
  ctx.sources[0].emit('error');
  assert.equal(ctx.sources[0].closed, true, 'disable native retry with its missing or expired cookie');
  ctx.tick(999);
  assert.equal(ctx.requests.length, 0);
  ctx.tick(1);
  assert.equal(ctx.requests.length, 1);
  assert.equal(ctx.sources.length, 1, 'wait for authenticated refresh before opening another stream');
  ctx.requests[0].resolve({ eventSeq: 42 });
  await settle();
  assert.equal(ctx.sources[1].url, '/api/sessions/session-1/events?after=42');
  assert.equal(ctx.connected.at(-1), false, 'working bearer authentication is not a working event stream');
  ctx.sources[0].emit('open');
  ctx.sources[0].emit('update');
  assert.equal(ctx.connected.at(-1), false, 'failed source callbacks cannot mark its replacement connected');
  ctx.sources[1].emit('open');
  assert.equal(ctx.connected.at(-1), true);
});

test('failed recovery uses exponential delays capped at 30 seconds and resets only on stream open', async t => {
  const ctx = setup(t);
  ctx.sources[0].emit('error');
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    const previousCount = ctx.requests.length;
    ctx.tick(delay - 1);
    assert.equal(ctx.requests.length, previousCount);
    ctx.tick(1);
    assert.equal(ctx.requests.length, previousCount + 1);
    ctx.requests.at(-1)!.reject(new Error('Authentication or server unavailable'));
    await settle();
    assert.equal(ctx.sources.length, 1);
  }
  ctx.tick(30000);
  ctx.requests.at(-1)!.resolve({ eventSeq: 50 });
  await settle();
  ctx.sources[1].emit('error');
  const previousCount = ctx.requests.length;
  ctx.tick(29999);
  assert.equal(ctx.requests.length, previousCount, 'successful HTTP refresh must not reset failing SSE backoff');
  ctx.tick(1);
  ctx.requests.at(-1)!.resolve({ eventSeq: 51 });
  await settle();
  ctx.sources[2].emit('open');
  ctx.sources[2].emit('error');
  ctx.tick(999);
  assert.equal(ctx.requests.length, previousCount + 1);
  ctx.tick(1);
  assert.equal(ctx.requests.length, previousCount + 2, 'a stream that opened resets the retry delay');
});

test('stream failure aborts an event refresh and ignores its late result while recovery proceeds', async t => {
  const ctx = setup(t);
  ctx.sources[0].emit('open');
  ctx.tick(100);
  ctx.sources[0].emit('update');
  ctx.sources[0].emit('error');
  assert.equal(ctx.requests[0].signal.aborted, true);
  ctx.tick(1000);
  assert.equal(ctx.requests.length, 2);
  ctx.requests[0].resolve({ eventSeq: 999 });
  await settle();
  assert.deepEqual(ctx.received, [], 'a superseded response cannot advance the reconnect cursor');
  ctx.requests[1].resolve({ eventSeq: 7 });
  await settle();
  assert.equal(ctx.sources[1].url, '/api/sessions/session-1/events?after=7');
  ctx.tick(1000);
  assert.equal(ctx.requests.length, 2, 'old dirty events must not leave extra refreshes queued');
});

test('a failed event snapshot recovers the stream and leaves connectivity false until it opens', async t => {
  const ctx = setup(t);
  ctx.sources[0].emit('open');
  ctx.tick(100);
  ctx.requests[0].reject(new Error('Offline'));
  await settle();
  assert.equal(ctx.sources[0].closed, true);
  assert.equal(ctx.connected.at(-1), false);
  ctx.tick(1000);
  ctx.requests[1].resolve({ eventSeq: 8 });
  await settle();
  assert.equal(ctx.sources.length, 2);
  assert.equal(ctx.connected.at(-1), false);
});

for (const pending of ['refresh', 'reconnect'] as const) {
  test(`disposal cancels a pending ${pending} timer`, t => {
    const ctx = setup(t);
    ctx.sources[0].emit(pending === 'refresh' ? 'open' : 'error');
    ctx.dispose();
    ctx.tick(60000);
    assert.equal(ctx.sources[0].closed, true);
    assert.equal(ctx.requests.length, 0);
    assert.equal(ctx.sources.length, 1);
  });
}

test('disposal aborts recovery and ignores late snapshots and stream callbacks', async t => {
  const ctx = setup(t);
  ctx.sources[0].emit('error');
  ctx.tick(1000);
  ctx.dispose();
  assert.equal(ctx.requests[0].signal.aborted, true);
  const previousConnected = [...ctx.connected];
  ctx.requests[0].resolve({ eventSeq: 999 });
  ctx.sources[0].emit('open');
  ctx.sources[0].emit('error');
  await settle();
  ctx.tick(60000);
  assert.deepEqual(ctx.received, []);
  assert.deepEqual(ctx.connected, previousConnected);
  assert.equal(ctx.sources.length, 1);
  assert.equal(ctx.requests.length, 1);
});

test('session switches ignore stale responses and events even before effect cleanup runs', async t => {
  const ctx = setup(t);
  ctx.sources[0].emit('open');
  ctx.tick(100);
  ctx.state.current = false;
  const previousConnected = [...ctx.connected];
  ctx.requests[0].resolve({ eventSeq: 999 });
  ctx.sources[0].emit('open');
  ctx.sources[0].emit('update');
  ctx.sources[0].emit('error');
  await settle();
  ctx.tick(60000);
  assert.deepEqual(ctx.received, []);
  assert.deepEqual(ctx.connected, previousConnected);
  assert.equal(ctx.requests.length, 1);
  assert.equal(ctx.sources.length, 1);
});
