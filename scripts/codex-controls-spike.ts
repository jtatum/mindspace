import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CodexRuntime } from '../src/server/runtime/codex.js';
import type { Participant } from '../src/shared/types.js';

const directory = resolve('.mindspace', 'spike', `controls-${randomUUID()}`);
await mkdir(directory, { recursive: true, mode: 0o700 });
const agent: Participant = { id: randomUUID(), sessionId: 'controls-spike', name: 'Fox', kind: 'agent', color: '#aaa', instructions: 'Follow the latest direct human instructions. Keep responses short.', model: 'gpt-5.6-terra', effort: 'high', webFetch: false, status: 'idle', threadId: null, tokensUsed: null, groupCursor: 0 };
let mode: 'steer' | 'interrupt' = 'steer'; let acted = false;
let accepted = false; let controlError: unknown; const calls: any[] = [];
const runtime = new CodexRuntime(agent, {
  onThread: id => { agent.threadId = id; }, onUsage: () => {}, onActivity: () => {},
  onTool: async (name, args) => { calls.push({ name, args }); return { sent: true }; },
  onTurnStarted: () => {
    if (acted) return; acted = true;
    setImmediate(() => {
      void (mode === 'steer'
        ? runtime.steer({ messageId: randomUUID(), text: 'Latest human instruction: replace the earlier task. Call send_group_message with exactly "steered" as the body, then end immediately. Do not produce the earlier classification.' }).then(value => { accepted = value; })
        : runtime.interrupt()).catch(error => { controlError = error; });
    });
  },
}, directory);
const watchdog = setTimeout(() => { console.error('Control spike exceeded its 120-second budget'); void runtime.close(); }, 120000);
try {
  const steered = await runtime.run({ messageId: randomUUID(), text: 'Consider several possible taxonomies for research papers about retrieval and group-agent collaboration. Wait for any incoming human steering before deciding what to publish. Use the group tool for the final decision.' });
  assert.equal(controlError, undefined);
  assert(accepted, 'The active turn did not accept steering');
  assert.equal(steered.status, 'completed', steered.error);
  assert(calls.some(call => call.name === 'send_group_message' && call.args.body === 'steered'), 'Agent did not act on the steering input');
  console.log('PASS: active-turn steering accepted and reflected in the tool output');
  mode = 'interrupt'; acted = false;
  const interrupted = await runtime.run({ messageId: randomUUID(), text: 'Begin considering a second taxonomy. A human may pause this turn.' });
  assert.equal(interrupted.status, 'interrupted', interrupted.error);
  console.log('PASS: live active-turn interruption');
  const report = { date: new Date().toISOString(), model: agent.model, effort: agent.effort, passed: ['active-turn steering accepted', 'steering changes explicit chat output', 'live interruption'] };
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
} finally { clearTimeout(watchdog); await runtime.close(); }
