import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CodexRuntime, runtimeHealth } from '../src/server/runtime/codex.js';
import type { Activity, Participant } from '../src/shared/types.js';

const directory = resolve('.mindspace', 'spike', randomUUID());
await mkdir(directory, { recursive: true, mode: 0o700 });
const health = await runtimeHealth();
assert(health.available, health.message);
console.log(`Testing Codex ${health.version}, ${health.model}, reasoning ${health.effort}`);
const activities: Activity[] = []; const calls: Array<{ agent: string; tool: string; args: any }> = [];
const agents: Participant[] = ['A', 'B'].map(name => ({ id: randomUUID(), sessionId: 'spike', name, kind: 'agent', color: '#aaa', instructions: 'Follow the diagnostic task exactly. Keep all output short.', model: 'gpt-5.6-terra', effort: 'high', webFetch: false, status: 'idle', threadId: null, tokensUsed: null, groupCursor: 0 }));
const make = (agent: Participant) => new CodexRuntime(agent, {
  onThread: id => { agent.threadId = id; }, onUsage: tokens => { agent.tokensUsed = tokens; },
  onTurnStarted: () => {}, onActivity: item => { activities.push(item); },
  onTool: async (name, args) => { calls.push({ agent: agent.name, tool: name, args }); return { sent: true }; },
}, directory);
const runtimes = agents.map(make);
const markers = agents.map(() => randomUUID().slice(0, 8));
try {
  const results = await Promise.all(runtimes.map((runtime, index) => runtime.run({ messageId: randomUUID(), text: `Remember this marker in your own context: ${markers[index]}. Call send_group_message with exactly "ready ${markers[index]}" then end. Do not use other tools.` })));
  for (const result of results) assert.equal(result.status, 'completed', result.error);
  assert(calls.some(c => c.agent === 'A' && c.args.body === `ready ${markers[0]}`));
  assert(calls.some(c => c.agent === 'B' && c.args.body === `ready ${markers[1]}`));
  console.log('PASS: two concurrent independent agents and dynamic tool callbacks');
} finally { await Promise.all(runtimes.map(runtime => runtime.close())); }
const resumed = agents.map(make);
try {
  calls.length = 0;
  const results = await Promise.all(resumed.map(runtime => runtime.run({ messageId: randomUUID(), text: 'Recall your previously stored marker. Call send_group_message with exactly that marker and nothing else, then end.' })));
  for (const result of results) assert.equal(result.status, 'completed', result.error);
  for (let i = 0; i < agents.length; i++) assert(calls.some(c => c.agent === agents[i].name && c.args.body === markers[i]), `Agent ${agents[i].name} did not retain its independent context`);
  console.log('PASS: both contexts survive process restart');
  const report = { date: new Date().toISOString(), version: health.version, model: health.model, effort: health.effort, passed: ['concurrent agents', 'dynamic tools', 'separate contexts', 'process restart and resume'], activityKinds: [...new Set(activities.map(a => a.kind))], reasoningSummaryObserved: activities.some(a => a.kind === 'reasoning' && a.text.length > 0), agents: agents.map(a => ({ name: a.name, threadId: a.threadId, tokens: a.tokensUsed })) };
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await Promise.all(resumed.map(runtime => runtime.close())); }
