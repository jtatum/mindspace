import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp, type ControlAction } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import type { CreateSessionInput, Identity, Message, RuntimeHealth, SessionEvent, Snapshot } from '../src/shared/types.js';

const input: CreateSessionInput = { title: 'Test experiment', task: 'Classify papers.', agents: ['A', 'B', 'C'].map(name => ({ name, instructions: '' })) };
const health: RuntimeHealth = { mode: 'simulation', available: true, model: 'gpt-5.6-terra', effort: 'high' };

test('joined humans can rename experiments; observers cannot, and only the title changes', async () => {
  const ctx = await setup();
  try {
    const base = `/api/sessions/${ctx.snapshot.session.id}`;
    const observer = ctx.store.createIdentity('Observer');
    assert.equal((await ctx.app.inject({ method: 'PATCH', url: base, payload: { title: 'New' } })).statusCode, 401);
    assert.equal((await ctx.app.inject({ method: 'PATCH', url: base, headers: { authorization: `Bearer ${observer.token}` }, payload: { title: 'New' } })).statusCode, 403);
    for (const payload of [{ title: ' ' }, { title: 'x'.repeat(161) }, { title: 'New', task: 'Overwrite' }]) {
      assert.equal((await ctx.app.inject({ method: 'PATCH', url: base, headers: ctx.headers, payload })).statusCode, 400);
    }
    const renamed = await ctx.app.inject({ method: 'PATCH', url: base, headers: ctx.headers, payload: { title: '  AI landscape  ' } });
    assert.equal(renamed.statusCode, 200);
    assert.deepEqual(renamed.json<Snapshot>().session, { ...ctx.snapshot.session, title: 'AI landscape' });
    assert.equal(ctx.store.listSessions()[0].title, 'AI landscape');
    assert.equal(ctx.store.eventsAfter(ctx.snapshot.session.id, ctx.snapshot.eventSeq).at(-1)?.type, 'session.updated');
  } finally { await ctx.close(); }
});
async function setup() {
  const store = new Store(':memory:');
  const seen: Message[] = [];
  const controls: Array<{ sessionId: string; action: ControlAction; agentId?: string }> = [];
  const app = await buildApp({ store, health, scheduler: {
    onMessage: message => { seen.push(message); },
    control: (id, action, agentId) => { controls.push({ sessionId: id, action, agentId }); store.updateSession(id, { status: action === 'pause' ? 'paused' : 'running' }); },
    shutdown: () => {},
  } });
  const identityResponse = await app.inject({ method: 'POST', url: '/api/identities', payload: { name: 'Human' } });
  const identity = identityResponse.json<Identity>();
  const headers = { authorization: `Bearer ${identity.token}` };
  const response = await app.inject({ method: 'POST', url: '/api/sessions', headers, payload: input });
  assert.equal(response.statusCode, 201, response.body);
  return { store, app, identity, headers, seen, controls, identityResponse, snapshot: response.json<Snapshot>(), close: async () => { await app.close(); store.close(); } };
}

test('HTTP identities authorize commands; unjoined humans can observe but must join to send', async () => {
  const ctx = await setup();
  try {
    const { app, snapshot, headers, identityResponse } = ctx;
    assert.equal((await app.inject('/api/health')).statusCode, 200);
    assert.equal((await app.inject('/api/sessions')).statusCode, 401);
    const cookie = String(identityResponse.headers['set-cookie']);
    assert.match(cookie, /HttpOnly; SameSite=Strict/);
    assert.equal((await app.inject({ url: '/api/sessions', headers: { cookie: cookie.split(';')[0] } })).statusCode, 200);
    const second = (await app.inject({ method: 'POST', url: '/api/identities', payload: { name: 'Observer' } })).json<Identity>();
    const secondHeaders = { authorization: `Bearer ${second.token}` };
    const base = `/api/sessions/${snapshot.session.id}`;
    assert.equal((await app.inject({ url: base, headers: secondHeaders })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: `${base}/messages`, headers: secondHeaders, payload: { body: 'Hello', requestId: 'hello' } })).statusCode, 403);
    const joined = await app.inject({ method: 'POST', url: `${base}/join`, headers: secondHeaders });
    assert.equal(joined.json().id, second.id);
    const message = await app.inject({ method: 'POST', url: `${base}/messages`, headers: secondHeaders, payload: { body: 'Hello', requestId: 'hello' } });
    assert.equal(message.statusCode, 201);
    assert.equal(message.json().senderId, second.id);
    assert.equal(ctx.seen.length, 1);
    assert.equal((await app.inject({ url: `${base}/export`, headers })).json<Snapshot>().messages.length, 2);
  } finally { await ctx.close(); }
});

test('restored bearer identities renew the event-stream cookie without changing session state', async () => {
  const ctx = await setup();
  try {
    const base = `/api/sessions/${ctx.snapshot.session.id}`;
    const before = ctx.store.snapshot(ctx.snapshot.session.id);
    assert.equal((await ctx.app.inject(`${base}/events`)).statusCode, 401);
    for (const cookie of [undefined, 'mindspace_token=expired']) {
      const response = await ctx.app.inject({ url: base, headers: { ...ctx.headers, ...(cookie ? { cookie } : {}) } });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['set-cookie'], `mindspace_token=${ctx.identity.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.deepEqual(response.json<Snapshot>(), before);
      assert.deepEqual(ctx.store.snapshot(ctx.snapshot.session.id), before, 'restoring authentication must preserve the participant and audit record');
    }
  } finally { await ctx.close(); }
});

test('invalid bearer credentials cannot renew cookies or fall back to a valid cookie', async () => {
  const ctx = await setup();
  try {
    for (const authorization of ['Bearer invalid', 'Basic invalid', `Bearer ${ctx.identity.token} extra`]) {
      const response = await ctx.app.inject({
        url: '/api/sessions', headers: { authorization, cookie: `mindspace_token=${ctx.identity.token}` },
      });
      assert.equal(response.statusCode, 401);
      assert.equal(response.headers['set-cookie'], undefined);
    }
  } finally { await ctx.close(); }
});

for (const authentication of ['bearer', 'cookie'] as const) {
  test(`${authentication} observers must join the target session before any control reaches the scheduler`, async () => {
    const ctx = await setup();
    try {
      const identityResponse = await ctx.app.inject({ method: 'POST', url: '/api/identities', payload: { name: 'Observer' } });
      const observer = identityResponse.json<Identity>();
      const headers = authentication === 'bearer'
        ? { authorization: `Bearer ${observer.token}` }
        : { cookie: String(identityResponse.headers['set-cookie']).split(';')[0] };
      ctx.store.createSession(input, observer, 'simulation'); // Membership elsewhere grants no controls here.
      const sessionId = ctx.snapshot.session.id;
      const base = `/api/sessions/${sessionId}`;
      const agentId = ctx.snapshot.participants.find(participant => participant.kind === 'agent')!.id;
      const actions: Array<{ action: ControlAction; agentId?: string }> = [
        { action: 'start' }, { action: 'pause' }, { action: 'resume' }, { action: 'next-round' },
        { action: 'pause-agent', agentId }, { action: 'resume-agent', agentId },
      ];
      const before = ctx.store.snapshot(sessionId);
      assert.equal((await ctx.app.inject({ url: base, headers })).statusCode, 200, 'unjoined observation remains available');
      for (const payload of actions) {
        const response = await ctx.app.inject({ method: 'POST', url: `${base}/control`, headers, payload });
        assert.equal(response.statusCode, 403, `${payload.action} must require membership in the target session`);
      }
      assert.deepEqual(ctx.controls, [], 'rejected controls must never invoke the scheduler');
      assert.deepEqual(ctx.store.snapshot(sessionId), before, 'rejected controls must not change state, events, or membership');

      assert.equal((await ctx.app.inject({ method: 'POST', url: `${base}/join`, headers })).statusCode, 200);
      assert.equal(ctx.store.getParticipant(sessionId, observer.id).kind, 'human');
      for (const payload of actions) {
        const response = await ctx.app.inject({ method: 'POST', url: `${base}/control`, headers, payload });
        assert.equal(response.statusCode, 200, `a joined human may invoke ${payload.action}`);
      }
      assert.deepEqual(ctx.controls, actions.map(({ action, agentId }) => ({ sessionId, action, agentId })));
    } finally { await ctx.close(); }
  });
}

test('API validates browser origins, payloads, agent controls and DM ownership', async () => {
  const ctx = await setup();
  try {
    const { app, headers, snapshot, store } = ctx;
    const base = `/api/sessions/${snapshot.session.id}`;
    const payload = { body: 'Hello', requestId: 'hello' };
    assert.equal((await app.inject({ method: 'POST', url: `${base}/messages`, headers: { ...headers, origin: 'https://evil.example' }, payload })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/identities', headers: { origin: 'https://evil.example' }, payload: { name: 'X' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: `${base}/messages`, headers: { ...headers, origin: 'http://localhost:5173' }, payload })).statusCode, 201);
    assert.equal((await app.inject({ method: 'POST', url: `${base}/messages`, headers, payload: { ...payload, senderId: snapshot.participants[1].id } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: `${base}/control`, headers, payload: { action: 'pause-agent' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: `${base}/control`, headers, payload: { action: 'pause-agent', agentId: ctx.identity.id } })).statusCode, 400);
    const [a, b] = snapshot.participants.filter(p => p.kind === 'agent');
    const dm = store.sendMessage(snapshot.session.id, a.id, { recipientId: b.id, body: 'Peer discussion', requestId: 'peer' });
    const visible = (await app.inject({ url: base, headers })).json<Snapshot>();
    assert.ok(visible.messages.some(message => message.id === dm.id));
    assert.equal((await app.inject({ method: 'POST', url: `${base}/messages`, headers, payload: { ...payload, conversationId: dm.conversationId } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: `${base}/messages`, headers, payload: { body: 'Changed retry', requestId: 'hello' } })).statusCode, 409);
    assert.equal((await app.inject({ method: 'POST', url: '/api/sessions', headers, payload: { ...input, agents: [] } })).statusCode, 400);
  } finally { await ctx.close(); }
});

function encodePayload(payload: unknown, encoding: 'utf8' | 'escaped') {
  const json = JSON.stringify(payload);
  return encoding === 'utf8' ? json : json.replace(/[\u0080-\uffff]/g, unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

for (const encoding of ['utf8', 'escaped'] as const) {
  test(`maximum-length Unicode messages survive ${encoding} JSON encoding`, async () => {
    const ctx = await setup();
    try {
      const body = '🦊'.repeat(40000);
      const requestId = '🦊'.repeat(200);
      const payload = encodePayload({ body, requestId }, encoding);
      assert.ok(Buffer.byteLength(payload) > 128 * 1024, 'exercise the former transport cap');
      const response = await ctx.app.inject({ method: 'POST', url: `/api/sessions/${ctx.snapshot.session.id}/messages`, headers: { ...ctx.headers, 'content-type': 'application/json' }, payload });
      assert.equal(response.statusCode, 201, response.body);
      assert.equal(response.json<Message>().body, body);
      assert.equal(ctx.store.snapshot(ctx.snapshot.session.id).messages.at(-1)!.body, body);
      assert.equal(ctx.seen.length, 1);
    } finally { await ctx.close(); }
  });

  test(`maximum-length five-agent sessions survive ${encoding} JSON encoding`, async () => {
    const ctx = await setup();
    try {
      const input: CreateSessionInput = {
        title: '🦊'.repeat(160), task: '🦊'.repeat(40000),
        agents: Array.from({ length: 5 }, (_, index) => ({ name: `${index}${'🦊'.repeat(79)}`, instructions: '🦊'.repeat(16000), webFetch: true })),
        settings: { roundDelayMs: 3600000, turnTimeoutMs: 1800000, maxRounds: 10000, maxTurns: 100000, maxTokens: 100000000, maxDurationMs: 604800000 },
      };
      const payload = encodePayload(input, encoding);
      assert.ok(Buffer.byteLength(payload) > (encoding === 'escaped' ? 1024 : 128) * 1024);
      const response = await ctx.app.inject({ method: 'POST', url: '/api/sessions', headers: { ...ctx.headers, 'content-type': 'application/json' }, payload });
      assert.equal(response.statusCode, 201, response.body);
      const snapshot = ctx.store.snapshot(response.json<Snapshot>().session.id);
      assert.equal(snapshot.session.title, input.title);
      assert.equal(snapshot.session.task, input.task);
      assert.equal(snapshot.messages[0].body, input.task);
      assert.deepEqual(snapshot.participants.filter(p => p.kind === 'agent').map(({ name, instructions, webFetch }) => ({ name, instructions, webFetch })), input.agents);
    } finally { await ctx.close(); }
  });
}

test('Unicode display names use the same character limit in validation and storage', async () => {
  const ctx = await setup();
  try {
    const name = '🦊'.repeat(80);
    const response = await ctx.app.inject({ method: 'POST', url: '/api/identities', payload: { name } });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(ctx.store.authenticate(response.json<Identity>().token)!.name, name);
    assert.equal((await ctx.app.inject({ method: 'POST', url: '/api/identities', payload: { name: `${name}🦊` } })).statusCode, 400);
  } finally { await ctx.close(); }
});

test('field limits still reject oversized text below the transport cap without mutation', async () => {
  const ctx = await setup();
  try {
    const before = ctx.store.snapshot(ctx.snapshot.session.id);
    const sessions = ctx.store.listSessions();
    for (const character of ['a', '🦊']) {
      for (const payload of [{ body: character.repeat(40001), requestId: 'over-body' }, { body: 'Hello', requestId: character.repeat(201) }]) {
        const response = await ctx.app.inject({ method: 'POST', url: `/api/sessions/${ctx.snapshot.session.id}/messages`, headers: ctx.headers, payload });
        assert.equal(response.statusCode, 400, response.body);
      }
      for (const payload of [
        { ...input, task: character.repeat(40001) },
        { ...input, title: character.repeat(161) },
        { ...input, agents: input.agents.map(agent => ({ ...agent, instructions: character.repeat(16001) })) },
        { ...input, agents: input.agents.map(agent => ({ ...agent, name: character.repeat(81) })) },
      ]) {
        const response = await ctx.app.inject({ method: 'POST', url: '/api/sessions', headers: ctx.headers, payload });
        assert.equal(response.statusCode, 400, response.body);
      }
    }
    assert.deepEqual(ctx.store.snapshot(ctx.snapshot.session.id), before);
    assert.deepEqual(ctx.store.listSessions(), sessions);
    assert.deepEqual(ctx.seen, []);
  } finally { await ctx.close(); }
});

test('requests above the 2 MiB transport cap are rejected without mutation', async () => {
  const ctx = await setup();
  try {
    const before = ctx.store.snapshot(ctx.snapshot.session.id);
    const payload = JSON.stringify({ body: 'Hello', requestId: 'over-transport' }).padEnd(2 * 1024 * 1024 + 1, ' ');
    const response = await ctx.app.inject({ method: 'POST', url: `/api/sessions/${ctx.snapshot.session.id}/messages`, headers: { ...ctx.headers, 'content-type': 'application/json' }, payload });
    assert.equal(response.statusCode, 413, response.body);
    assert.deepEqual(ctx.store.snapshot(ctx.snapshot.session.id), before);
    assert.deepEqual(ctx.seen, []);
  } finally { await ctx.close(); }
});

test('DNS-rebinding hosts cannot mint identities or read even public API routes', async () => {
  const ctx = await setup();
  try {
    const hostileHeaders = { host: 'attacker.example:3001', origin: 'http://attacker.example:3001' };
    const identity = await ctx.app.inject({ method: 'POST', url: '/api/identities', headers: hostileHeaders, payload: { name: 'Attacker' } });
    assert.equal(identity.statusCode, 403, 'matching Host and Origin must not grant an attacker a browser identity');
    assert.equal(identity.headers['set-cookie'], undefined);
    assert.equal(identity.json().token, undefined);
    assert.match(identity.json().error, /loopback host/);
    for (const url of ['/api/health', '/api/sessions', `/api/sessions/${ctx.snapshot.session.id}`, `/api/sessions/${ctx.snapshot.session.id}/export`, 'http://attacker.example:3001/api/health']) {
      const response = await ctx.app.inject({ url, headers: { ...ctx.headers, ...hostileHeaders, 'x-forwarded-host': 'localhost:3001' } });
      assert.equal(response.statusCode, 403, `${url} must check Host before public-route or identity exemptions`);
    }
    for (const host of ['localhost.attacker.example', '127.0.0.1.attacker.example', 'localhost:65536', 'localhost:0', '127.1:3001', '127.0.0.1@attacker.example']) {
      assert.equal((await ctx.app.inject({ url: '/api/health', headers: { host } })).statusCode, 403, `${host} must not be treated as an approved authority`);
    }
  } finally { await ctx.close(); }
});

test('explicit loopback hosts support direct requests and the Vite development proxy', async () => {
  const ctx = await setup();
  try {
    for (const host of ['localhost', 'localhost:5173', '127.0.0.1:3001', '[::1]:3001']) {
      assert.equal((await ctx.app.inject({ url: '/api/health', headers: { host } })).statusCode, 200);
      const identity = await ctx.app.inject({ method: 'POST', url: '/api/identities', headers: { host, origin: `http://${host}` }, payload: { name: 'Local observer' } });
      assert.equal(identity.statusCode, 201, `same-origin local creation should work at ${host}`);
    }
    // Vite preserves the original Host by default; also support a rewritten target Host.
    for (const host of ['127.0.0.1:5173', '127.0.0.1:3001']) {
      assert.equal((await ctx.app.inject({ method: 'POST', url: '/api/identities', headers: { host, origin: 'http://127.0.0.1:5173' }, payload: { name: 'Development observer' } })).statusCode, 201);
    }
  } finally { await ctx.close(); }
});

test('SSE replays from a snapshot cursor then streams committed events without cross-session leakage', { timeout: 10000 }, async () => {
  const ctx = await setup();
  const controller = new AbortController();
  try {
    const { app, snapshot, store, identity } = ctx;
    const sessionId = snapshot.session.id;
    const missed = store.sendMessage(sessionId, identity.id, { body: 'Before connect', requestId: 'missed' });
    const unrelated = store.createSession(input, identity, 'simulation');
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    // A browser restored from localStorage has a bearer token but may have no cookie.
    const restored = await fetch(`${address}/api/sessions/${sessionId}`, { headers: ctx.headers, signal: controller.signal });
    assert.equal(restored.status, 200);
    const cookie = restored.headers.get('set-cookie');
    assert.ok(cookie, 'restoring the saved identity must also authenticate native EventSource');
    await restored.json();
    const response = await fetch(`${address}/api/sessions/${sessionId}/events?after=${snapshot.eventSeq}`, { headers: { cookie: cookie.split(';')[0] }, signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type')!, /text\/event-stream/);
    store.sendMessage(unrelated.session.id, identity.id, { body: 'Other session', requestId: 'unrelated' });
    const live = store.sendMessage(sessionId, identity.id, { body: 'After connect', requestId: 'live' });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const events: SessionEvent[] = [];
    while (events.length < 2) {
      const { value, done } = await reader.read();
      assert.equal(done, false);
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame.split('\n').find(line => line.startsWith('data: '));
        if (data) events.push(JSON.parse(data.slice(6)) as SessionEvent);
      }
    }
    assert.deepEqual(events.map(event => (event.data as Message).id), [missed.id, live.id]);
    assert.ok(events.every(event => event.sessionId === sessionId));
    assert.ok(events[1].sequence > events[0].sequence);
    controller.abort();
    await reader.cancel().catch(() => {});
  } finally { controller.abort(); await ctx.close(); }
});
