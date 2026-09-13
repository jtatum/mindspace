import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store } from '../src/server/store.js';
import type { Activity, CreateSessionInput, SessionEvent } from '../src/shared/types.js';

const input: CreateSessionInput = {
  title: 'Research collaboration', task: 'Categorize these papers together.',
  agents: ['Analyst', 'Critic', 'Synthesist'].map(name => ({ name, instructions: `Work as the ${name}.` })),
};

test('identities and sessions survive reopen with hashed credentials and explicit agent defaults', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mindspace-store-'));
  const path = join(directory, 'state.sqlite');
  let store = new Store(path);
  try {
    const identity = store.createIdentity('  Jay  ');
    const original = store.createSession(input, identity, 'codex');
    assert.equal(original.session.status, 'paused');
    assert.equal(original.messages.length, 1);
    assert.equal(original.messages[0].body, input.task);
    assert.ok(original.participants.filter(p => p.kind === 'agent').every(p => p.model === 'gpt-5.6-terra' && p.effort === 'high'));
    store.close();
    assert.equal(readFileSync(path).includes(identity.token), false);
    store = new Store(path);
    assert.deepEqual(store.authenticate(identity.token), { id: identity.id, name: 'Jay' });
    assert.equal(store.authenticate('invalid'), null);
    assert.deepEqual(store.snapshot(original.session.id), original);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('message, conversation, delivery and events commit together; retries bind sender and payload', () => {
  const store = new Store(':memory:');
  try {
    const human = store.createIdentity('Human');
    const snapshot = store.createSession(input, human, 'simulation');
    const sessionId = snapshot.session.id;
    const [a, b] = snapshot.participants.filter(p => p.kind === 'agent');
    const events: SessionEvent[] = [];
    store.on('event', event => {
      events.push(event);
      if (event.type === 'message.created') {
        const state = store.snapshot(sessionId);
        assert.equal(state.deliveries.length, 1, 'message listeners see the committed delivery too');
      }
    });
    const first = store.sendMessage(sessionId, a.id, { recipientId: b.id, body: 'Please review method A.', requestId: 'tool-call-1' });
    const count = events.length;
    assert.deepEqual(store.sendMessage(sessionId, a.id, { recipientId: b.id, body: first.body, requestId: 'tool-call-1' }), first);
    assert.equal(events.length, count, 'a replay does not emit a second message');
    assert.throws(() => store.sendMessage(sessionId, a.id, { recipientId: human.id, body: first.body, requestId: 'tool-call-1' }), /different message/);
    assert.equal(store.snapshot(sessionId).conversations.length, 2, 'a rejected retry rolls its new conversation back');
    assert.equal(events.length, count, 'rollback emits nothing');
    assert.equal(store.pendingDeliveries(sessionId, b.id)[0].messageId, first.id);
    assert.deepEqual(store.pendingDeliveries(sessionId, a.id), []);
    assert.equal(store.eventsAfter(sessionId, snapshot.eventSeq).length, count);
  } finally { store.close(); }
});

test('humans observe all DMs while agents receive only addressed messages and cannot impersonate', () => {
  const store = new Store(':memory:');
  try {
    const human = store.createIdentity('Human');
    const other = store.createIdentity('Observer');
    const snapshot = store.createSession(input, human, 'simulation');
    const sessionId = snapshot.session.id;
    const [a, b, c] = snapshot.participants.filter(p => p.kind === 'agent');
    const dm = store.sendMessage(sessionId, a.id, { recipientId: b.id, body: 'Private to agents A and B, visible to humans.', requestId: 'first' });
    assert.equal(store.snapshot(sessionId).messages.find(m => m.id === dm.id)?.body, dm.body);
    assert.equal(store.pendingDeliveries(sessionId, b.id).length, 1);
    assert.deepEqual(store.pendingDeliveries(sessionId, c.id), []);
    assert.throws(() => store.sendMessage(sessionId, c.id, { conversationId: dm.conversationId, body: 'Pretend I am A', requestId: 'second' }), /observe this DM/);
    store.joinSession(sessionId, other);
    assert.throws(() => store.sendMessage(sessionId, other.id, { conversationId: dm.conversationId, body: 'Pretend I am B', requestId: 'second' }), /observe this DM/);
    assert.throws(() => store.sendMessage(sessionId, c.id, { body: 'Leak DM via reply', replyTo: dm.id, requestId: 'third' }), /this conversation/);
    const ownDm = store.sendMessage(sessionId, other.id, { recipientId: a.id, body: 'Human steering', requestId: 'steer' });
    const reply = store.sendMessage(sessionId, a.id, { recipientId: other.id, body: 'Acknowledged', replyTo: ownDm.id, requestId: 'reply' });
    assert.equal(reply.conversationId, ownDm.conversationId, 'DM pair order is canonical');
    assert.equal(store.snapshot(sessionId).deliveries.length, 2, 'DMs to humans do not make agent deliveries');
  } finally { store.close(); }
});

test('creation rollback and session-bound membership reject partial or foreign writes', () => {
  const store = new Store(':memory:');
  try {
    assert.throws(() => store.createSession(input, { id: 'missing', name: 'Unknown' }, 'simulation'), /Unknown human/);
    assert.equal(store.listSessions().length, 0);
    const one = store.createIdentity('One');
    const two = store.createIdentity('Two');
    const first = store.createSession(input, one, 'simulation');
    const second = store.createSession(input, two, 'simulation');
    assert.throws(() => store.sendMessage(first.session.id, two.id, { body: 'not joined', requestId: 'x' }), /does not belong/);
    assert.throws(() => store.sendMessage(first.session.id, one.id, { recipientId: second.participants.find(p => p.kind === 'agent')!.id, body: 'foreign recipient', requestId: 'x' }), /does not belong/);
    assert.equal(store.snapshot(first.session.id).messages.length, 1);
    assert.ok(store.eventsAfter(first.session.id, 0).every(event => event.sessionId === first.session.id));
  } finally { store.close(); }
});

test('restart pauses work, interrupts incomplete activity and keeps ambiguous deliveries out of the mailbox', () => {
  const store = new Store(':memory:');
  try {
    const human = store.createIdentity('Human');
    const snapshot = store.createSession(input, human, 'simulation');
    const sessionId = snapshot.session.id;
    const [a, b] = snapshot.participants.filter(p => p.kind === 'agent');
    const time = new Date().toISOString();
    store.updateSession(sessionId, { status: 'running' });
    store.updateParticipant(sessionId, a.id, { status: 'thinking', threadId: 'persistent-context-a' });
    store.sendMessage(sessionId, human.id, { recipientId: a.id, body: 'Unfinished turn', requestId: 'a' });
    store.sendMessage(sessionId, human.id, { recipientId: b.id, body: 'Completed turn', requestId: 'b' });
    store.markDeliveries(store.pendingDeliveries(sessionId, a.id).map(d => d.id), 'accepted', 'active-turn');
    store.markDeliveries(store.pendingDeliveries(sessionId, b.id).map(d => d.id), 'accepted', 'finished-turn');
    const activity: Activity = { id: 'activity-a', sessionId, agentId: a.id, turnId: 'active-turn', kind: 'system', title: 'Turn', text: '', status: 'inProgress', createdAt: time, updatedAt: time };
    store.upsertActivity(activity);
    store.upsertActivity({ ...activity, id: `${b.id}:turn:finished-turn`, agentId: b.id, turnId: 'finished-turn', status: 'completed' });
    store.saveRound({ id: 'round-1', sessionId, number: 1, status: 'running', startedAt: time, completedAt: null, startSequence: 1, opportunities: [{ agentId: a.id, status: 'running', inputSequence: 1, turnId: 'active-turn' }, { agentId: b.id, status: 'pending', inputSequence: 0, turnId: null }] });
    store.recover();
    const recovered = store.snapshot(sessionId);
    assert.equal(recovered.session.status, 'paused');
    assert.equal(recovered.participants.find(p => p.id === a.id)?.threadId, 'persistent-context-a');
    assert.equal(recovered.activities.find(item => item.id === activity.id)?.status, 'interrupted');
    assert.equal(recovered.rounds[0].status, 'interrupted');
    assert.deepEqual(recovered.rounds[0].opportunities.map(o => o.status), ['failed', 'skipped']);
    assert.equal(recovered.deliveries.find(d => d.agentId === a.id)?.state, 'uncertain');
    assert.equal(recovered.deliveries.find(d => d.agentId === b.id)?.state, 'accepted');
    assert.deepEqual(store.pendingDeliveries(sessionId, a.id), []);
  } finally { store.close(); }
});

test('a completed user-message item cannot prove an accepted DM turn completed before a crash', () => {
  const store = new Store(':memory:');
  try {
    const human = store.createIdentity('Human');
    const snapshot = store.createSession(input, human, 'simulation');
    const sessionId = snapshot.session.id;
    const agent = snapshot.participants.find(participant => participant.kind === 'agent')!;
    store.updateSession(sessionId, { status: 'running' });
    store.sendMessage(sessionId, human.id, { recipientId: agent.id, body: 'Review this after the input is accepted.', requestId: 'before-crash' });
    store.markDeliveries(store.pendingDeliveries(sessionId, agent.id).map(delivery => delivery.id), 'accepted', 'unfinished-turn');
    const time = new Date().toISOString();
    store.upsertActivity({ id: `${agent.id}:user-message-item`, sessionId, agentId: agent.id, turnId: 'unfinished-turn', kind: 'system', title: 'userMessage', text: 'Input accepted', status: 'completed', createdAt: time, updatedAt: time });
    store.recover();
    const recovered = store.snapshot(sessionId);
    assert.equal(recovered.deliveries[0].state, 'uncertain', 'only the exact completed turn lifecycle marker proves consumption finished');
    assert.deepEqual(store.pendingDeliveries(sessionId, agent.id), [], 'ambiguous input is never silently replayed');
  } finally { store.close(); }
});
