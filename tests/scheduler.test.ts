import assert from 'node:assert/strict';
import test from 'node:test';
import { Scheduler, type SchedulerClock } from '../src/server/scheduler.js';
import { Store } from '../src/server/store.js';
import type { AgentRuntime, RuntimeHooks, RuntimeInput, RuntimeTurnResult } from '../src/server/runtime/types.js';
import type { Participant, Settings } from '../src/shared/types.js';

async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
async function until(predicate: () => boolean, explanation: string) {
  for (let i = 0; i < 100 && !predicate(); i++) await Promise.resolve();
  assert.ok(predicate(), explanation);
}

class ManualClock implements SchedulerClock {
  private time = Date.parse('2026-09-13T12:00:00.000Z');
  private nextId = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();
  now = () => this.time;
  setTimeout = (callback: () => void, ms: number) => {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.time + ms, callback });
    return id;
  };
  clearTimeout = (id: number) => { this.timers.delete(id); };
  async advance(ms: number) {
    const end = this.time + ms;
    let count = 0;
    while (true) {
      const next = [...this.timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      assert.ok(count++ < 1000, 'scheduler must not spin indefinitely at one clock instant');
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
      await flush();
    }
    this.time = end;
    await flush();
  }
}

interface AgentInput {
  event: 'group_round_opportunity' | 'incoming_direct_messages';
  groupMessages: Array<{ id: string; body: string; senderId: string; senderKind: string }>;
  directMessages: Array<{ id: string; body: string; senderId: string; senderKind: string }>;
}
interface Invocation { agentId: string; turnId: string; input: AgentInput; runtime: ControlledRuntime }
class ControlledRuntime implements AgentRuntime {
  private current: { turnId: string; resolve: (result: RuntimeTurnResult) => void } | undefined;
  steers: AgentInput[] = [];
  interrupts = 0;
  closed = false;
  acceptsSteering = true;
  steerBarrier?: Promise<boolean>;
  interruptCompletesTurn = true;
  closeBarrier?: Promise<void>;
  constructor(readonly agent: Participant, readonly hooks: RuntimeHooks, private calls: Invocation[]) {
    hooks.onThread(`context:${agent.id}`);
  }
  async run(input: RuntimeInput): Promise<RuntimeTurnResult> {
    assert.equal(this.current, undefined, 'there must never be two concurrent turns on one agent');
    const turnId = `turn:${this.calls.length + 1}:${this.agent.id}`;
    const promise = new Promise<RuntimeTurnResult>(resolve => { this.current = { turnId, resolve }; });
    this.calls.push({ agentId: this.agent.id, turnId, input: JSON.parse(input.text), runtime: this });
    this.hooks.onTurnStarted(turnId);
    return promise;
  }
  async steer(input: RuntimeInput) {
    assert.ok(this.current, 'steering requires a running turn');
    this.steers.push(JSON.parse(input.text));
    return this.steerBarrier ?? this.acceptsSteering;
  }
  finish(status: RuntimeTurnResult['status'] = 'completed', error?: string) {
    assert.ok(this.current, 'the fake runtime must have a turn to finish');
    const { turnId, resolve } = this.current;
    this.current = undefined;
    resolve({ turnId, status, error });
  }
  async interrupt() { this.interrupts++; if (this.interruptCompletesTurn && this.current) this.finish('interrupted'); }
  async close() { this.closed = true; if (this.closeBarrier) await this.closeBarrier; if (this.current) this.finish('interrupted'); }
  tool(name: string, args: unknown, callId = `call:${this.calls.length}:${name}`) { return this.hooks.onTool(name, args, callId); }
}

function setup(settings: Partial<Settings> = {}) {
  const store = new Store(':memory:');
  const human = store.createIdentity('Human observer');
  const snapshot = store.createSession({ title: 'Collaboration', task: 'Evaluate paper categories.', agents: ['Analyst', 'Critic', 'Synthesist'].map(name => ({ name, instructions: '' })), settings: { roundDelayMs: 1000, turnTimeoutMs: 5000, maxDurationMs: 100000, ...settings } }, human, 'simulation');
  const agents = snapshot.participants.filter(p => p.kind === 'agent');
  const calls: Invocation[] = [];
  const clock = new ManualClock();
  const scheduler = new Scheduler(store, (agent, hooks) => new ControlledRuntime(agent, hooks, calls), clock);
  const sessionId = snapshot.session.id;
  return {
    store, human, agents, calls, clock, scheduler, sessionId,
    state: () => store.snapshot(sessionId),
    async start() { await scheduler.control(sessionId, 'start'); await until(() => calls.length > 0, 'a first round opportunity should start'); },
    async finish(index: number, status: RuntimeTurnResult['status'] = 'completed', error?: string) {
      await until(() => calls.length > index, `turn ${index + 1} should start`);
      calls[index].runtime.finish(status, error);
      await flush();
    },
    send(body: string, recipientId?: string, requestId = `human:${calls.length}:${body}`) {
      const message = store.sendMessage(sessionId, human.id, { body, recipientId, requestId });
      scheduler.onMessage(message);
      return message;
    },
    async close() { await scheduler.shutdown(); await flush(); store.close(); },
  };
}

test('rounds give each agent latest committed group state and rotate the first speaker', async () => {
  const ctx = setup();
  try {
    await ctx.start();
    const [a, b, c] = ctx.agents;
    assert.equal(ctx.calls[0].agentId, a.id);
    assert.deepEqual(ctx.calls[0].input.groupMessages.map(message => message.body), ['Evaluate paper categories.']);
    await ctx.calls[0].runtime.tool('send_group_message', { body: 'Propose methods, datasets, and evaluation categories.' });
    await ctx.finish(0);
    assert.equal(ctx.calls[1].agentId, b.id);
    assert.equal(ctx.calls[1].input.groupMessages.at(-1)?.body, 'Propose methods, datasets, and evaluation categories.');
    await ctx.finish(1);
    assert.equal(ctx.calls[2].agentId, c.id);
    assert.equal(ctx.calls[2].input.groupMessages.at(-1)?.body, 'Propose methods, datasets, and evaluation categories.');
    await ctx.finish(2);
    assert.equal(ctx.state().session.status, 'cooldown');
    assert.deepEqual(ctx.state().rounds[0].opportunities.map(opportunity => opportunity.status), ['spoke', 'passed', 'passed']);
    await ctx.clock.advance(999);
    assert.equal(ctx.calls.length, 3);
    await ctx.clock.advance(1);
    assert.equal(ctx.calls[3].agentId, b.id);
    await ctx.finish(3); await ctx.finish(4); await ctx.finish(5);
    assert.deepEqual(ctx.calls.slice(3).map(call => call.agentId), [b.id, c.id, a.id]);
    assert.equal(ctx.state().session.status, 'idle');
    assert.ok(ctx.state().rounds.every(round => round.status === 'completed'));
  } finally { await ctx.close(); }
});

test('an all-pass quiet round sleeps without allocating more turns', async () => {
  const ctx = setup();
  try {
    await ctx.start();
    await ctx.finish(0); await ctx.finish(1); await ctx.finish(2);
    assert.equal(ctx.state().session.status, 'idle');
    assert.equal(ctx.state().session.nextRoundAt, null);
    await ctx.clock.advance(10000);
    assert.equal(ctx.calls.length, 3);
    assert.equal(ctx.state().session.turnCount, 3);
    assert.equal(ctx.state().messages.length, 1, 'passing creates activity, not artificial chat messages');
  } finally { await ctx.close(); }
});

test('peer DMs run concurrently across agents while a busy agent retains one later round opportunity', async () => {
  const ctx = setup();
  try {
    await ctx.start();
    const [a, b, c] = ctx.agents;
    await ctx.calls[0].runtime.tool('send_dm', { recipient_id: b.id, body: 'Please challenge my categories.' });
    await ctx.clock.advance(75);
    assert.equal(ctx.calls.length, 2);
    assert.equal(ctx.calls[1].agentId, b.id);
    assert.equal(ctx.calls[1].input.event, 'incoming_direct_messages');
    assert.deepEqual(ctx.calls[1].input.directMessages.map(message => [message.body, message.senderId, message.senderKind]), [['Please challenge my categories.', a.id, 'agent']]);
    await ctx.calls[0].runtime.tool('send_group_message', { body: 'My proposal is now ready.' });
    await ctx.finish(0);
    assert.equal(ctx.calls.length, 2, 'B must finish its existing DM turn before its group opportunity');
    await ctx.finish(1);
    assert.equal(ctx.calls[2].agentId, b.id);
    assert.equal(ctx.calls[2].input.event, 'group_round_opportunity');
    assert.equal(ctx.calls[2].input.directMessages.length, 0, 'accepted DMs are not silently replayed');
    assert.equal(ctx.calls[2].input.groupMessages.at(-1)?.body, 'My proposal is now ready.');
    await ctx.finish(2); await ctx.finish(3);
    assert.equal(ctx.calls[3].agentId, c.id);
    assert.equal(ctx.calls[3].input.directMessages.length, 0, 'an unrelated agent never receives the peer DM');
    assert.deepEqual(ctx.state().rounds[0].opportunities.map(opportunity => opportunity.agentId), [a.id, b.id, c.id]);
    assert.equal(ctx.state().deliveries[0].state, 'accepted');
  } finally { await ctx.close(); }
});

test('human DMs steer the active agent with sender provenance and a saved receipt', async () => {
  const ctx = setup();
  try {
    await ctx.start();
    const a = ctx.agents[0];
    const dm = ctx.send('Use fewer categories and consult the Critic.', a.id);
    await ctx.clock.advance(75);
    assert.equal(ctx.calls.length, 1, 'steering does not create another concurrent turn');
    assert.equal(ctx.calls[0].runtime.steers.length, 1);
    const input = ctx.calls[0].runtime.steers[0];
    assert.deepEqual(input.directMessages.map(message => [message.id, message.senderId, message.senderKind]), [[dm.id, ctx.human.id, 'human']]);
    assert.equal(ctx.state().deliveries[0].state, 'accepted');
    assert.equal(ctx.state().deliveries[0].turnId, ctx.calls[0].turnId);
    await ctx.finish(0);
    assert.equal(ctx.calls[1].input.directMessages.length, 0);
  } finally { await ctx.close(); }
});

test('a turn started by a peer DM remains steerable by a later human DM', async () => {
  const ctx = setup();
  try {
    await ctx.start();
    const b = ctx.agents[1];
    await ctx.calls[0].runtime.tool('send_dm', { recipient_id: b.id, body: 'Review the proposed method category.' });
    await ctx.clock.advance(75);
    assert.equal(ctx.calls[1].input.event, 'incoming_direct_messages');
    const steering = ctx.send('Focus the review on evaluation metrics instead.', b.id);
    await ctx.clock.advance(75);
    assert.equal(ctx.calls.length, 2);
    assert.equal(ctx.calls[1].runtime.steers.length, 1, 'mailbox draining must not lock out steering for the duration of a DM turn');
    assert.equal(ctx.calls[1].runtime.steers[0].directMessages[0].id, steering.id);
    assert.equal(ctx.state().deliveries.find(delivery => delivery.messageId === steering.id)?.state, 'accepted');
  } finally { await ctx.close(); }
});

test('a continuous DM stream cannot postpone initial delivery or active steering', async () => {
  const ctx = setup();
  try {
    ctx.store.updateSession(ctx.sessionId, { status: 'idle' });
    const agent = ctx.agents[0];
    for (let index = 0; index < 20; index++) {
      ctx.send(`Stream message ${index}`, agent.id);
      await ctx.clock.advance(50);
      if (index === 1) {
        assert.equal(ctx.calls.length, 1, 'the initial mailbox starts within its first 75 ms deadline');
        assert.equal(ctx.calls[0].input.directMessages.length, 2);
      }
    }
    assert.equal(ctx.calls.length, 1, 'subsequent batches steer the existing turn');
    assert.ok(ctx.calls[0].runtime.steers.length > 0, 'steering proceeds while messages continue arriving');
    await ctx.clock.advance(75);
    assert.equal(ctx.state().deliveries.filter(delivery => delivery.state === 'accepted').length, 20);
    assert.equal(ctx.store.pendingDeliveries(ctx.sessionId, agent.id).length, 0);
  } finally { await ctx.close(); }
});

test('completing an original turn cannot rewind the group cursor advanced by steering', async () => {
  const ctx = setup();
  try {
    await ctx.start();
    const a = ctx.agents[0];
    const update = ctx.send('Add a distinct reproducibility category.');
    ctx.send('Consider the new group proposal while you work.', a.id);
    await ctx.clock.advance(75);
    assert.equal(ctx.calls[0].runtime.steers[0].groupMessages.at(-1)?.id, update.id);
    assert.equal(ctx.store.getParticipant(ctx.sessionId, a.id).groupCursor, update.sequence);
    await ctx.finish(0);
    assert.equal(ctx.store.getParticipant(ctx.sessionId, a.id).groupCursor, update.sequence, 'finishing the earlier input must retain the latest accepted cursor');
  } finally { await ctx.close(); }
});

test('a DM rejected during the end-of-turn race stays queued and is delivered on a fresh turn', async () => {
  const ctx = setup();
  try {
    await ctx.start();
    const a = ctx.agents[0];
    ctx.calls[0].runtime.acceptsSteering = false;
    const message = ctx.send('This arrived while the turn was finishing.', a.id);
    await ctx.clock.advance(75);
    assert.equal(ctx.store.pendingDeliveries(ctx.sessionId, a.id)[0].messageId, message.id);
    await ctx.finish(0);
    await ctx.clock.advance(75);
    const deliveryTurn = ctx.calls.find(call => call.input.event === 'incoming_direct_messages' && call.agentId === a.id);
    assert.ok(deliveryTurn, 'a rejected steering submission must start a later DM turn');
    assert.equal(deliveryTurn.input.directMessages[0].id, message.id);
    deliveryTurn.runtime.finish();
    await flush();
    assert.equal(ctx.store.pendingDeliveries(ctx.sessionId, a.id).length, 0);
    assert.equal(ctx.state().deliveries[0].state, 'accepted');
  } finally { await ctx.close(); }
});

test('pausing interrupts current work, queues new DMs, and resume delivers them once', async () => {
  const ctx = setup();
  try {
    await ctx.start();
    await ctx.scheduler.control(ctx.sessionId, 'pause');
    await flush();
    assert.equal(ctx.state().session.status, 'paused');
    assert.ok(ctx.calls[0].runtime.interrupts > 0);
    const b = ctx.agents[1];
    const dm = ctx.send('Wait for resume before reviewing this.', b.id);
    await ctx.clock.advance(2000);
    assert.equal(ctx.calls.length, 1);
    assert.equal(ctx.store.pendingDeliveries(ctx.sessionId, b.id).length, 1);
    await ctx.scheduler.control(ctx.sessionId, 'resume');
    await until(() => ctx.calls.length === 2, 'the queued DM should start work after resume');
    assert.equal(ctx.calls[1].agentId, b.id);
    assert.equal(ctx.calls[1].input.directMessages[0].id, dm.id);
    await ctx.finish(1);
    assert.equal(ctx.store.pendingDeliveries(ctx.sessionId, b.id).length, 0);
    assert.equal(ctx.state().deliveries[0].state, 'accepted');
    assert.equal(ctx.calls.filter(call => call.input.directMessages.some(message => message.id === dm.id)).length, 1);
  } finally { await ctx.close(); }
});

for (const scope of ['session', 'agent', 'deadline'] as const) {
  for (const resumeTiming of ['before-completion', 'during-cleanup'] as const) {
    test(`${scope} resume ${resumeTiming} holds DMs until the interrupted turn and runtime cleanup both settle`, async () => {
      const ctx = setup({ turnTimeoutMs: 500 });
      let releaseClose!: () => void;
      const closeBarrier = new Promise<void>(resolve => { releaseClose = resolve; });
      try {
        await ctx.start();
        const first = ctx.calls[0];
        first.runtime.interruptCompletesTurn = false; // Interrupt acknowledgment precedes turn/completed.
        first.runtime.closeBarrier = closeBarrier;
        if (scope === 'deadline') await ctx.clock.advance(500);
        else await ctx.scheduler.control(ctx.sessionId, scope === 'session' ? 'pause' : 'pause-agent', scope === 'agent' ? first.agentId : undefined);
        const pausedDM = ctx.send('Handle this after resuming.', first.agentId);
        if (resumeTiming === 'during-cleanup') await ctx.finish(0, 'interrupted');
        await ctx.scheduler.control(ctx.sessionId, scope === 'session' ? 'resume' : 'resume-agent', scope === 'session' ? undefined : first.agentId);
        await ctx.clock.advance(75);
        const resumedDM = ctx.send('This arrived after Resume.', first.agentId);
        await ctx.clock.advance(100);
        assert.equal(first.runtime.steers.length, 0, 'an interrupted turn must never receive resumed mailbox inputs');
        assert.equal(ctx.store.pendingDeliveries(ctx.sessionId, first.agentId).length, 2);

        if (resumeTiming === 'before-completion') await ctx.finish(0, 'interrupted');
        await ctx.clock.advance(100);
        assert.equal(ctx.calls.filter(call => call.agentId === first.agentId).length, 1, 'the slot stays reserved until the old runtime finishes closing');
        assert.equal(ctx.store.pendingDeliveries(ctx.sessionId, first.agentId).length, 2, 'cleanup must not consume the pending mailbox');

        releaseClose();
        await flush();
        await ctx.clock.advance(100);
        const fresh = ctx.calls.find(call => call.agentId === first.agentId && call.turnId !== first.turnId);
        assert.ok(fresh, 'queued DMs must start a fresh turn after cleanup');
        assert.notEqual(fresh.runtime, first.runtime, 'an interrupted runtime must be replaced before reuse');
        assert.deepEqual(fresh.input.directMessages.map(message => message.id), [pausedDM.id, resumedDM.id]);
        assert.deepEqual(ctx.state().deliveries.map(delivery => [delivery.state, delivery.turnId]), [['accepted', fresh.turnId], ['accepted', fresh.turnId]]);
        assert.equal(ctx.calls.filter(call => call.agentId === first.agentId).length, 2, 'each queued message enters only one fresh turn');
      } finally { releaseClose(); await ctx.close(); }
    });
  }
}

for (const scope of ['session', 'agent', 'deadline'] as const) {
  for (const responseTiming of ['before-completion', 'after-completion'] as const) {
    test(`${scope} interruption leaves steering acknowledged ${responseTiming} uncertain and unreplayed`, async () => {
      const ctx = setup({ turnTimeoutMs: 500 });
      let acknowledge!: (accepted: boolean) => void;
      let releaseClose!: () => void;
      const closeBarrier = new Promise<void>(resolve => { releaseClose = resolve; });
      try {
        await ctx.start();
        const first = ctx.calls[0];
        first.runtime.interruptCompletesTurn = false;
        first.runtime.closeBarrier = closeBarrier;
        first.runtime.steerBarrier = new Promise<boolean>(resolve => { acknowledge = resolve; });
        const message = ctx.send('This submission may already have affected the agent.', first.agentId);
        await ctx.clock.advance(75);
        assert.equal(first.runtime.steers.length, 1);
        if (scope === 'deadline') await ctx.clock.advance(425);
        else await ctx.scheduler.control(ctx.sessionId, scope === 'session' ? 'pause' : 'pause-agent', scope === 'agent' ? first.agentId : undefined);
        if (responseTiming === 'before-completion') {
          acknowledge(true); await flush();
          assert.equal(ctx.state().deliveries[0].state, 'uncertain', 'interrupt acknowledgment cannot prove that the agent processed this input');
        }
        await ctx.finish(0, 'interrupted'); releaseClose(); await flush();
        if (responseTiming === 'after-completion') { acknowledge(true); await flush(); }
        assert.equal(ctx.state().deliveries[0].state, 'uncertain', 'a late success must not conceal an interrupted outcome');
        assert.equal(ctx.state().deliveries[0].turnId, first.turnId);
        await ctx.scheduler.control(ctx.sessionId, scope === 'session' ? 'resume' : 'resume-agent', scope === 'session' ? undefined : first.agentId);
        await ctx.clock.advance(100);
        assert.equal(ctx.store.pendingDeliveries(ctx.sessionId, first.agentId).length, 0);
        assert.equal(ctx.calls.filter(call => call.input.directMessages.some(input => input.id === message.id)).length, 0, 'Resume must not repeat a submission whose effects are unknown');
      } finally { acknowledge?.(true); releaseClose(); await flush(); await ctx.close(); }
    });
  }
}

for (const outcome of ['interrupted', 'failed', 'completed'] as const) {
  test(`${outcome} outcome reconciles acknowledged initial and steering inputs after a pause request`, async () => {
    const ctx = setup();
    try {
      await ctx.start();
      const agentId = ctx.agents[1].id;
      ctx.send('Start reviewing this.', agentId);
      await ctx.clock.advance(75);
      const direct = ctx.calls[1];
      ctx.send('Also consider this.', agentId);
      await ctx.clock.advance(75);
      assert.deepEqual(ctx.state().deliveries.map(delivery => delivery.state), ['accepted', 'accepted']);
      direct.runtime.interruptCompletesTurn = false;
      await ctx.scheduler.control(ctx.sessionId, 'pause-agent', agentId);
      direct.runtime.hooks.onTurnStarted(direct.turnId);
      assert.deepEqual(ctx.state().deliveries.map(delivery => delivery.state), ['uncertain', 'uncertain']);
      await ctx.finish(1, outcome);
      const expected = outcome === 'completed' ? 'accepted' : 'uncertain';
      assert.deepEqual(ctx.state().deliveries.map(delivery => delivery.state), [expected, expected]);
    } finally { await ctx.close(); }
  });
}

test('steering acknowledged after normal completion remains accepted', async () => {
  const ctx = setup();
  let acknowledge!: (accepted: boolean) => void;
  try {
    await ctx.start();
    const first = ctx.calls[0];
    first.runtime.steerBarrier = new Promise<boolean>(resolve => { acknowledge = resolve; });
    ctx.send('An input to the successfully completed turn.', first.agentId);
    await ctx.clock.advance(75);
    await ctx.finish(0);
    acknowledge(true); await flush();
    assert.equal(ctx.state().deliveries[0].state, 'accepted');
    assert.equal(ctx.state().deliveries[0].turnId, first.turnId);
  } finally { acknowledge?.(true); await flush(); await ctx.close(); }
});

test('steering explicitly rejected after interruption is retried once on a fresh turn', async () => {
  const ctx = setup();
  let rejectInput!: (accepted: boolean) => void;
  try {
    await ctx.start();
    const first = ctx.calls[0];
    first.runtime.steerBarrier = new Promise<boolean>(resolve => { rejectInput = resolve; });
    const message = ctx.send('The old runtime will reject this input.', first.agentId);
    await ctx.clock.advance(75);
    await ctx.scheduler.control(ctx.sessionId, 'pause'); await flush();
    rejectInput(false); await flush();
    assert.equal(ctx.state().deliveries[0].state, 'pending');
    await ctx.scheduler.control(ctx.sessionId, 'resume');
    await ctx.clock.advance(100);
    const fresh = ctx.calls.filter(call => call.input.directMessages.some(input => input.id === message.id));
    assert.equal(fresh.length, 1);
    assert.notEqual(fresh[0].turnId, first.turnId);
    assert.equal(ctx.state().deliveries[0].state, 'accepted');
    assert.equal(ctx.state().deliveries[0].turnId, fresh[0].turnId);
  } finally { rejectInput?.(false); await flush(); await ctx.close(); }
});

test('normal completion cannot confirm a steering input whose RPC outcome is unknown', async () => {
  const ctx = setup();
  let failReceipt!: (error: Error) => void;
  try {
    await ctx.start();
    const first = ctx.calls[0];
    first.runtime.steerBarrier = new Promise<boolean>((_resolve, reject) => { failReceipt = reject; });
    ctx.send('An input without a known receipt.', first.agentId);
    await ctx.clock.advance(75);
    await ctx.finish(0);
    failReceipt(new Error('Transport closed before the receipt')); await flush();
    assert.equal(ctx.state().deliveries[0].state, 'uncertain');
    assert.equal(ctx.store.pendingDeliveries(ctx.sessionId, first.agentId).length, 0);
    assert.equal(ctx.state().session.status, 'paused');
  } finally { failReceipt?.(new Error('Test ended')); await flush(); await ctx.close(); }
});

test('failed turns pause the session and record a failed opportunity rather than a pass or perpetual running slot', async () => {
  const ctx = setup();
  try {
    await ctx.start();
    await ctx.finish(0, 'failed', 'Harness connection lost');
    assert.equal(ctx.state().session.status, 'paused');
    assert.match(ctx.state().session.reason!, /Harness connection lost/);
    assert.equal(ctx.calls.length, 1);
    assert.equal(ctx.state().rounds[0].status, 'interrupted');
    const opportunity = ctx.state().rounds[0].opportunities[0];
    assert.equal(opportunity.status, 'failed');
    assert.equal(opportunity.turnId, ctx.calls[0].turnId);
    assert.ok(ctx.state().activities.some(activity => activity.status === 'failed' && activity.turnId === ctx.calls[0].turnId));
  } finally { await ctx.close(); }
});

test('turn deadlines interrupt a stuck agent and preserve other agents round opportunities', async () => {
  const ctx = setup({ turnTimeoutMs: 500 });
  try {
    await ctx.start();
    await ctx.clock.advance(500);
    assert.ok(ctx.calls[0].runtime.interrupts > 0);
    assert.ok(ctx.calls[0].runtime.closed);
    assert.equal(ctx.state().participants.find(agent => agent.id === ctx.agents[0].id)?.status, 'paused');
    assert.equal(ctx.calls[1].agentId, ctx.agents[1].id);
    await ctx.finish(1); await ctx.finish(2);
    assert.deepEqual(ctx.state().rounds[0].opportunities.map(opportunity => opportunity.status), ['failed', 'passed', 'passed']);
    assert.equal(ctx.state().rounds[0].status, 'completed');
  } finally { await ctx.close(); }
});

test('retrying an already handled group message after idle does not allocate another round', async () => {
  const ctx = setup();
  try {
    await ctx.start();
    await ctx.finish(0); await ctx.finish(1); await ctx.finish(2);
    const message = ctx.send('Please reconsider the evaluation category.', undefined, 'repeat-safe');
    await until(() => ctx.calls.length === 4, 'a fresh human message wakes an idle session');
    await ctx.finish(3); await ctx.finish(4); await ctx.finish(5);
    assert.equal(ctx.state().session.status, 'idle');
    const retry = ctx.store.sendMessage(ctx.sessionId, ctx.human.id, { body: message.body, requestId: 'repeat-safe' });
    assert.equal(retry.id, message.id);
    ctx.scheduler.onMessage(retry);
    await flush();
    assert.equal(ctx.state().session.status, 'idle');
    assert.equal(ctx.calls.length, 6);
    assert.equal(ctx.state().rounds.length, 2);
  } finally { await ctx.close(); }
});

test('turn and token limits pause the entire session including DM-triggered work', async () => {
  const turnLimited = setup({ maxTurns: 2 });
  try {
    await turnLimited.start();
    await turnLimited.finish(0); await turnLimited.finish(1);
    assert.equal(turnLimited.calls.length, 2);
    assert.equal(turnLimited.state().session.status, 'paused');
    assert.match(turnLimited.state().session.reason!, /Turn limit/);
    turnLimited.send('This cannot bypass the limit through a DM.', turnLimited.agents[2].id);
    await turnLimited.clock.advance(1000);
    assert.equal(turnLimited.calls.length, 2);
  } finally { await turnLimited.close(); }
  const tokenLimited = setup({ maxTokens: 10 });
  try {
    await tokenLimited.start();
    tokenLimited.calls[0].runtime.hooks.onUsage(12);
    await flush();
    assert.equal(tokenLimited.state().session.status, 'paused');
    assert.match(tokenLimited.state().session.reason!, /Token limit/);
    assert.equal(tokenLimited.store.getParticipant(tokenLimited.sessionId, tokenLimited.agents[0].id).tokensUsed, 12);
    assert.ok(tokenLimited.calls[0].runtime.interrupts > 0);
  } finally { await tokenLimited.close(); }
});

test('a one-turn budget allows its admitted turn to finish when usage is reported', async () => {
  const ctx = setup({ maxTurns: 1, maxTokens: 100 });
  try {
    await ctx.start();
    ctx.calls[0].runtime.hooks.onUsage(2);
    await flush();
    assert.equal(ctx.state().session.status, 'running', 'reporting usage for an admitted turn must not consume a second turn slot');
    assert.equal(ctx.calls[0].runtime.interrupts, 0);
    await ctx.calls[0].runtime.tool('send_group_message', { body: 'The single budgeted turn can publish its result.' });
    await ctx.finish(0);
    assert.equal(ctx.state().session.status, 'paused');
    assert.match(ctx.state().session.reason!, /Turn limit/);
    assert.equal(ctx.calls.length, 1);
    assert.equal(ctx.state().rounds[0].opportunities[0].status, 'spoke');
  } finally { await ctx.close(); }
});
