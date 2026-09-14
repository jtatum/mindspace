import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CodexRpc } from '../src/server/runtime/rpc.js';
import { prepareRuntime, TERRA_CATALOG } from '../src/server/runtime/config.js';
import { chatTools, CodexRuntime } from '../src/server/runtime/codex.js';
import { Store } from '../src/server/store.js';

test('runtime accepts every advertised paper tool and rejects paper tools for general agents', async () => {
  const store = new Store(':memory:');
  try {
    const human = store.createIdentity('Observer');
    const snapshot = store.createSession({ title: 'Tools', task: 'Review', agents: ['A', 'B', 'C'].map(name => ({ name, instructions: '' })) }, human, 'simulation');
    const agent = snapshot.participants.find(p => p.kind === 'agent')!;
    for (const paperReview of [true, false]) {
      const called: string[] = []; const replies: any[] = [];
      const runtime = new CodexRuntime({ ...agent, paperReview, webFetch: true }, {
        onActivity() {}, onUsage() {}, onThread() {}, onTurnStarted() {},
        onTool: async name => { called.push(name); return { ok: true }; },
      }, '/unused');
      (runtime as any).rpc = { send: (reply: any) => replies.push(reply) };
      for (const tool of chatTools(true, true)) {
        await (runtime as any).handle({ id: replies.length + 1, method: 'item/tool/call', params: { tool: tool.name, arguments: {}, callId: tool.name } });
        assert.equal(replies.at(-1).result.success, chatTools(true, paperReview).some(t => t.name === tool.name), tool.name);
      }
      assert.deepEqual(called, chatTools(true, paperReview).map(t => t.name));
    }
  } finally { store.close(); }
});

test('Terra requests expose exactly the supplied dynamic tools with isolated configuration', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mindspace-policy-'));
  let capture: (request: any) => void;
  const requestBody = new Promise<any>(resolve => { capture = resolve; });
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    assert.equal(request.headers.authorization, undefined, 'probe must not send credentials');
    capture(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`event: response.completed\ndata: ${JSON.stringify({
      type: 'response.completed', response: {
        id: 'local-policy-probe', status: 'completed', output: [],
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      },
    })}\n\n`);
  });
  let rpc: CodexRpc | undefined;
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    assert(address && typeof address !== 'string');
    const settings = await prepareRuntime('policy-probe', directory, { probeBaseUrl: `http://127.0.0.1:${address.port}/v1` });
    assert.deepEqual(Object.keys(settings.env).sort(), ['CODEX_HOME', 'HOME', 'PATH', 'TMPDIR']);
    assert.equal((await stat(settings.env.CODEX_HOME!)).mode & 0o777, 0o700);
    assert(!(await readdir(settings.env.CODEX_HOME!)).includes('auth.json'));
    rpc = new CodexRpc(settings.args, settings.env, settings.cwd);
    await rpc.initialize();
    const names = ['send_group_message', 'send_dm', 'read_group_messages', 'web_fetch', 'list_shared_files', 'read_shared_file', 'write_shared_file', 'read_papers', 'record_paper_review', 'cache_paper'];
    const started = await rpc.request('thread/start', {
      model: 'gpt-5.6-terra', cwd: settings.cwd, sandbox: 'read-only', approvalPolicy: 'never',
      ephemeral: true, baseInstructions: 'Mindspace isolated tool catalog probe.',
      dynamicTools: chatTools(true, true),
    });
    await rpc.request('turn/start', { threadId: started.thread.id, effort: 'high', input: [{ type: 'text', text: 'Pass.', text_elements: [] }] });
    const body = await requestBody;
    assert.equal(body.model, 'gpt-5.6-terra');
    assert.equal(body.reasoning.effort, 'high');
    assert.equal(body.reasoning.summary, 'auto');
    // New Codex models send tool definitions as additional_tools input items.
    const tools = [
      ...(body.tools || []),
      ...body.input.filter((item: any) => item.type === 'additional_tools').flatMap((item: any) => item.tools),
    ];
    const flatten = (items: any[]): string[] => items.flatMap(item => item.type === 'namespace' ? flatten(item.tools) : [item.name]);
    assert.deepEqual(flatten(tools).sort(), names.sort());
    const instructions = JSON.stringify(body.input.filter((item: any) => item.type !== 'additional_tools'));
    assert(!instructions.includes('<skills_instructions>'));
    assert(!instructions.includes('1password claude token'));
    assert(!instructions.includes('You can spawn sub-agents'));
  } finally {
    await rpc?.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('runtime catalog removes model-forced tools without replacing the requested model', async () => {
  const { models } = JSON.parse(await readFile(TERRA_CATALOG, 'utf8'));
  assert.equal(models.length, 1);
  assert.equal(models[0].slug, 'gpt-5.6-terra');
  for (const key of ['apply_patch_tool_type', 'tool_mode', 'multi_agent_version']) assert.equal(models[0][key], null);
  assert.equal(models[0].model_messages, undefined);
});

test('runtime refuses path traversal and non-local test endpoints', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mindspace-policy-'));
  try {
    await assert.rejects(prepareRuntime('../outside', directory), /identifier/);
    await assert.rejects(prepareRuntime('probe', directory, { probeBaseUrl: 'https://example.com/v1' }), /loopback/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('experiment agents share a working directory while retaining separate runtime homes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mindspace-shared-policy-'));
  try {
    const options = { sessionId: 'shared-experiment', probeBaseUrl: 'http://127.0.0.1:9999/v1' };
    const a = await prepareRuntime('agent-a', directory, options);
    const b = await prepareRuntime('agent-b', directory, options);
    assert.equal(a.cwd, b.cwd);
    assert.notEqual(a.env.CODEX_HOME, b.env.CODEX_HOME);
    assert(a.cwd.endsWith('/experiments/shared-experiment/shared'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
