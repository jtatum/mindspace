import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../src/server/store.js';
import { CodexRuntime } from '../src/server/runtime/codex.js';
import type { Activity } from '../src/shared/types.js';

const input = { title: 'Scale', task: 'Read papers', agents: ['Fox', 'Horse', 'Pig'].map(name => ({ name, instructions: '' })) };

test('paper text reaches the agent but is omitted from activity storage and runtime history', async () => {
  const store = new Store(':memory:');
  try {
    const snapshot = store.createSession(input, store.createIdentity('Human'), 'simulation');
    const agent = snapshot.participants.find(p => p.kind === 'agent')!;
    const text = 'Evidence '.repeat(2200);
    let reply: any;
    const runtime = new CodexRuntime(agent, {
      onActivity: activity => store.upsertActivity(activity), onUsage() {}, onThread() {}, onTurnStarted() {},
      onTool: async () => ({ path: 'papers/0001.txt', text, nextOffset: text.length, hasMore: true }),
    }, '/unused');
    (runtime as any).rpc = { send: (value: any) => { reply = value.result; } };
    await (runtime as any).handle({ id: 1, method: 'item/tool/call', params: { tool: 'read_shared_file', arguments: { path: 'papers/0001.txt' }, callId: 'read' } });
    assert.equal(JSON.parse(reply.contentItems[0].text).text, text);
    await (runtime as any).handle({ method: 'item/completed', params: { turnId: 'turn', item: { id: 'read', type: 'dynamicToolCall', tool: 'read_shared_file', arguments: { path: 'papers/0001.txt' }, contentItems: reply.contentItems, success: true } } });
    assert(JSON.stringify(store.snapshot(snapshot.session.id).activities).length < 1500);
    assert(JSON.stringify([...(runtime as any).items.values()]).length < 1500);
    // Previously saved raw rows must also be compact before SQLite returns them.
    const activity = store.snapshot(snapshot.session.id).activities[0] as Activity;
    (store as any).db.prepare('UPDATE activities SET data=? WHERE id=?').run(JSON.stringify({ ...activity, result: reply.contentItems }), activity.id);
    assert(JSON.stringify(store.snapshot(snapshot.session.id).activities).length < 1500);
  } finally { store.close(); }
});

test('session export yields individual records while preserving complete reviews and JSON shape', () => {
  const store = new Store(':memory:');
  try {
    const snapshot = store.createSession(input, store.createIdentity('Human'), 'simulation', Array.from({ length: 12 }, (_, i) => ({ title: `Paper ${i}`, url: `https://arxiv.org/abs/2609.${String(i).padStart(5, '0')}` })));
    const agents = snapshot.participants.filter(p => p.kind === 'agent');
    const review = 'x'.repeat(190000);
    for (let number = 1; number <= 12; number++) store.recordPaperReview(snapshot.session.id, agents[(number - 1) % 3].id, number, 'reviewed', review);
    const chunks = [...store.streamExport(snapshot.session.id)];
    assert(chunks.every(chunk => Buffer.byteLength(chunk) < 200000));
    const exported = JSON.parse(chunks.join(''));
    assert.equal(exported.papers.length, 12);
    assert(exported.papers.every((p: any) => p.review === review));
    const { papers, ...rest } = exported;
    assert.deepEqual(rest, store.snapshot(snapshot.session.id));
  } finally { store.close(); }
});
