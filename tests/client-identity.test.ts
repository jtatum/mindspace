import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { api, ApiError, downloadSession, readIdentity, saveIdentity, withIdentityRecovery } from '../src/client/api.js';
import { subscribeSessionEvents } from '../src/client/session-events.js';
import type { Identity } from '../src/shared/types.js';

const savedIdentity: Identity = { id: 'old-human', name: 'Observer', token: 'old-token' };
const replacement: Identity = { id: 'new-human', name: 'Observer', token: 'new-token' };

function setup(t: TestContext) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  saveIdentity(savedIdentity);
  localStorage.setItem('mindspace.session', 'old-session');
  const state = { identity: readIdentity(), invalidations: 0 };
  const invalidate = () => { state.identity = null; state.invalidations++; };
  const run = <T,>(request: () => Promise<T>, identity = state.identity) => withIdentityRecovery(identity, () => state.identity, invalidate, request);
  return { state, run, invalidate };
}

test('startup 401 clears the saved identity and session so a replacement can enter', async t => {
  const ctx = setup(t);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Create or restore your browser identity first' }, { status: 401 }));
  await assert.rejects(ctx.run(() => api('/sessions', ctx.state.identity)), failure => failure instanceof ApiError && failure.status === 401);
  assert.equal(ctx.state.identity, null, 'App can show its identity dialog again');
  assert.equal(ctx.state.invalidations, 1);
  assert.equal(readIdentity(), null);
  assert.equal(localStorage.getItem('mindspace.session'), null);

  saveIdentity(replacement); ctx.state.identity = replacement;
  t.mock.method(globalThis, 'fetch', async () => Response.json([]));
  assert.deepEqual(await ctx.run(() => api('/sessions', ctx.state.identity)), []);
  assert.deepEqual(readIdentity(), replacement);
});

test('network failures, forbidden requests, and server errors preserve the saved identity', async t => {
  const ctx = setup(t);
  for (const failure of [new TypeError('Failed to fetch'), new ApiError('Forbidden', 403), new ApiError('Unavailable', 503)]) {
    await assert.rejects(ctx.run(async () => { throw failure; }), error => error === failure);
    assert.deepEqual(ctx.state.identity, savedIdentity);
    assert.deepEqual(readIdentity(), savedIdentity);
    assert.equal(localStorage.getItem('mindspace.session'), 'old-session');
  }
  await assert.rejects(ctx.run(async () => { throw new ApiError('Anonymous request rejected', 401); }, null));
  assert.equal(ctx.state.invalidations, 0, 'unauthenticated requests cannot invalidate a saved identity');
});

test('a delayed 401 cannot clear a newer in-memory or saved identity', async t => {
  const ctx = setup(t);
  let reject!: (failure: Error) => void;
  const pending = ctx.run(() => new Promise<void>((_resolve, no) => { reject = no; }));
  saveIdentity(replacement); ctx.state.identity = replacement;
  localStorage.setItem('mindspace.session', 'new-session');
  reject(new ApiError('Old token rejected', 401));
  await assert.rejects(pending, { status: 401 });
  assert.equal(ctx.state.invalidations, 0);
  assert.deepEqual(ctx.state.identity, replacement);
  assert.deepEqual(readIdentity(), replacement);
  assert.equal(localStorage.getItem('mindspace.session'), 'new-session');
});

test('simultaneous 401 responses invalidate the current identity only once', async t => {
  const ctx = setup(t);
  const reject: Array<(failure: Error) => void> = [];
  const requests = [0, 1].map(() => ctx.run(() => new Promise<void>((_resolve, no) => { reject.push(no); })));
  const failures = requests.map(request => assert.rejects(request, { status: 401 }));
  for (const fail of reject) fail(new ApiError('Old token rejected', 401));
  await Promise.all(failures);
  assert.equal(ctx.state.invalidations, 1);
  assert.equal(ctx.state.identity, null);
  assert.equal(readIdentity(), null);
});

test('an invalid current identity leaves another tab’s replacement storage intact', async t => {
  const ctx = setup(t);
  saveIdentity(replacement);
  localStorage.setItem('mindspace.session', 'new-session');
  await assert.rejects(ctx.run(async () => { throw new ApiError('Old token rejected', 401); }));
  assert.equal(ctx.state.identity, null);
  assert.deepEqual(readIdentity(), replacement);
  assert.equal(localStorage.getItem('mindspace.session'), 'new-session');
});

test('late successes and new calls using an old identity cannot restore session state', async t => {
  const ctx = setup(t);
  let resolve!: (value: string) => void;
  const pending = ctx.run(() => new Promise<string>(yes => { resolve = yes; }));
  ctx.state.identity = replacement; saveIdentity(replacement);
  resolve('old-session');
  await assert.rejects(pending, { name: 'AbortError' });
  let called = false;
  await assert.rejects(ctx.run(async () => { called = true; }, savedIdentity), { name: 'AbortError' });
  assert.equal(called, false);
  assert.deepEqual(readIdentity(), replacement);
});

test('a 401 during an active stream refresh stops the stream and its recovery loop', async t => {
  const ctx = setup(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  class Source extends EventTarget { closed = false; close() { this.closed = true; } }
  const source = new Source();
  let signal: AbortSignal | null | undefined;
  const fetch = t.mock.method(globalThis, 'fetch', async (_url: string, options?: RequestInit) => {
    signal = options?.signal;
    return new Response('Unauthorized', { status: 401 });
  });
  const received: unknown[] = [];
  const stop = subscribeSessionEvents({
    sessionId: 'old-session',
    getCursor: () => 3,
    isCurrent: () => ctx.state.identity?.token === savedIdentity.token,
    fetchSnapshot: signal => withIdentityRecovery(savedIdentity, () => ctx.state.identity, () => { ctx.invalidate(); stop(); }, () => api('/sessions/old-session', savedIdentity, { signal })),
    receiveSnapshot: value => { received.push(value); },
    setConnected: () => {},
    createEventSource: () => source,
  });
  t.after(stop);
  source.dispatchEvent(new Event('open'));
  t.mock.timers.tick(100);
  // Allow fetch, response parsing, and the subscription's rejection handler to settle.
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(ctx.state.identity, null);
  assert.equal(source.closed, true);
  assert.equal(signal?.aborted, true);
  assert.deepEqual(received, []);
  t.mock.timers.tick(60000);
  assert.equal(fetch.mock.callCount(), 1, 'invalid credentials must not be retried indefinitely');
});

test('export failures preserve HTTP status and also recover an invalid identity', async t => {
  const ctx = setup(t);
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 401 }));
  await assert.rejects(ctx.run(() => downloadSession('old-session', 'Experiment', savedIdentity)), { status: 401 });
  assert.equal(ctx.state.identity, null);
  assert.equal(readIdentity(), null);
});
