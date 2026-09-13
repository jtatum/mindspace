import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexRuntime } from '../src/server/runtime/codex.js';
import { Scheduler } from '../src/server/scheduler.js';
import { Store } from '../src/server/store.js';

test('runtime distinguishes initialization failure from ambiguous turn submission', async () => {
  const store = new Store(':memory:');
  const human = store.createIdentity('Observer');
  const snapshot = store.createSession({ title: 'Input recovery', task: 'Classify papers', agents: ['Fox', 'Horse', 'Pig'].map(name => ({ name, instructions: '' })) }, human, 'simulation');
  const agent = snapshot.participants.find(p => p.kind === 'agent')!;
  const hooks = { onActivity() {}, onThread() {}, onUsage() {}, onTurnStarted() {}, onTool: async () => ({}) };
  try {
    const uninitialized = new CodexRuntime(agent, hooks, '/unused');
    (uninitialized as any).initialization = Promise.reject(new Error('Login missing'));
    const before = await uninitialized.run({ text: 'An addressed DM', messageId: 'input-1' });
    assert.equal(before.status, 'failed'); assert.equal(before.inputState, 'not-submitted');
    const submitted = new CodexRuntime(agent, hooks, '/unused');
    (submitted as any).initialization = Promise.resolve();
    (submitted as any).rpc = { request: async () => { throw new Error('Connection lost after send'); }, close: async () => {} };
    const after = await submitted.run({ text: 'An addressed DM', messageId: 'input-2' });
    assert.equal(after.status, 'failed'); assert.equal(after.inputState, 'uncertain');
  } finally { store.close(); }
});

test('DMs definitely not submitted stay pending for resume after configuration is repaired', async () => {
  const store = new Store(':memory:');
  const human = store.createIdentity('Observer');
  const snapshot = store.createSession({ title: 'Retry initialization', task: 'Classify papers', agents: ['Fox', 'Horse', 'Pig'].map(name => ({ name, instructions: '' })) }, human, 'simulation');
  const agent = snapshot.participants.find(p => p.kind === 'agent')!;
  store.sendMessage(snapshot.session.id, human.id, { recipientId: agent.id, body: 'Please retain this DM', requestId: 'human-dm' });
  const scheduler = new Scheduler(store, () => ({
    run: async () => ({ turnId: '', status: 'failed', error: 'Initialization unavailable', inputState: 'not-submitted' }),
    steer: async () => false, interrupt: async () => {}, close: async () => {},
  }));
  try {
    store.updateSession(snapshot.session.id, { status: 'running' });
    await (scheduler as any).runAgent(snapshot.session.id, agent.id, 'dm');
    assert.equal(store.getSession(snapshot.session.id).status, 'paused');
    assert.equal(store.pendingDeliveries(snapshot.session.id, agent.id).length, 1);
    assert.equal(store.snapshot(snapshot.session.id).deliveries[0].state, 'pending');
  } finally { await scheduler.shutdown(); store.close(); }
});
