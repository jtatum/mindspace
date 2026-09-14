import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePaperLinks, paperReviewExperiment } from '../src/server/arxiv.js';
import { Store } from '../src/server/store.js';
import { buildApp } from '../src/server/app.js';
import { experimentDirectory, listSharedFiles, readSharedFile, writeSharedFile } from '../src/server/experiment-files.js';
import { chatTools, CodexRuntime } from '../src/server/runtime/codex.js';
import { Scheduler } from '../src/server/scheduler.js';
import type { Identity, Snapshot } from '../src/shared/types.js';

const papers = Array.from({ length: 2000 }, (_, i) => ({ title: `AI paper ${i + 1}`, url: `https://arxiv.org/abs/2609.${String(i + 1).padStart(5, '0')}` }));
const input = paperReviewExperiment('2026-09-13T00:00:00Z');

test('reviewer tool callbacks read paper text and save review files with durable progress and revision protection', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mindspace-review-files-'));
  const store = new Store(join(directory, 'mindspace.sqlite'));
  const scheduler = new Scheduler(store, () => { throw new Error('No model should start'); }, undefined, directory);
  try {
    const snapshot = store.createSession(input, store.createIdentity('Human'), 'simulation', papers);
    const sessionId = snapshot.session.id;
    const agents = snapshot.participants.filter(p => p.kind === 'agent');
    store.updateSession(sessionId, { status: 'running' });
    const root = experimentDirectory(directory, sessionId);
    mkdirSync(join(root, 'papers'));
    writeFileSync(join(root, 'papers/0001.txt'), 'The method improves classification on the reported benchmark.');
    const dispatch = (agent: typeof agents[number]) => {
      let reply: any;
      const runtime = new CodexRuntime(agent, {
        onActivity() {}, onThread() {}, onUsage() {}, onTurnStarted() {},
        onTool: (name, args, callId) => (scheduler as any).tool(agent, name, args, callId),
      }, directory);
      (runtime as any).rpc = { send: (value: any) => { reply = value.result; } };
      return async (tool: string, args: unknown) => {
        await (runtime as any).handle({ id: 1, method: 'item/tool/call', params: { tool, arguments: args, callId: tool } });
        if (!reply.success) throw new Error(reply.contentItems[0].text);
        return JSON.parse(reply.contentItems[0].text);
      };
    };
    const fox = dispatch(agents[0]); const horse = dispatch(agents[1]);
    const pending = await fox('read_papers', { assigned_to_self: true, status: 'pending', limit: 3 });
    assert.deepEqual(pending.papers.map((p: any) => p.number), [1, 4, 7]);
    assert.match((await fox('read_shared_file', { path: 'papers/0001.txt' })).text, /classification/);
    const review = '# AI paper 1\n\nSource: https://arxiv.org/abs/2609.00001\n\nThe authors claim a benchmark improvement. External validity is untested.';
    const saved = await fox('write_shared_file', { path: 'reviews/0001.md', text: review, expected_revision: null });
    assert.equal(saved.status, 'reviewed');
    assert.equal(readFileSync(join(root, 'reviews/0001.md'), 'utf8'), review);
    assert.equal(store.paperProgress(sessionId).reviewed, 1);
    assert.equal((await fox('read_papers', { assigned_to_self: true, status: 'pending' })).papers[0].number, 4);
    assert.equal((await horse('read_shared_file', { path: 'reviews/0001.md' })).text, review);
    await assert.rejects(horse('write_shared_file', { path: 'reviews/0001.md', text: 'Clobber', expected_revision: saved.revision }), /assigned reviewer/);
    await assert.rejects(fox('write_shared_file', { path: 'reviews/0001.md', text: 'Stale', expected_revision: null }), /changed/);
    assert.equal(store.exportPapers(sessionId)[0].review, review, 'failed file write rolls back the queue change');
    await fox('write_shared_file', { path: 'reviews/0001.md', text: review + '\nUpdated evidence.', expected_revision: saved.revision });
    await horse('write_shared_file', { path: 'notes/themes.md', text: 'Compare classification benchmarks.', expected_revision: null });
    await scheduler.control(sessionId, 'pause');
    await assert.rejects(fox('write_shared_file', { path: 'notes/paused.md', text: 'No', expected_revision: null }), /paused/);
    const reopened = new Store(join(directory, 'mindspace.sqlite'));
    try {
      assert.equal(reopened.paperProgress(sessionId).reviewed, 1);
      assert.match(reopened.exportPapers(sessionId)[0].review!, /Updated evidence/);
    } finally { reopened.close(); }
  } finally { await scheduler.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('arXiv listing parser extracts titles/links, decodes text, deduplicates and rejects foreign links', () => {
  const entry = (href: string, title: string) => `<li class="arxiv-result"><p class="list-title"><a href="${href}">arXiv</a></p><p class="title is-5">${title}</p><p>Abstract text must not enter the corpus</p></li>`;
  const result = parsePaperLinks(entry('http://arxiv.org/abs/2609.00001v1', 'AI &amp;\n reasoning') + entry('https://arxiv.org/abs/2609.00001v2', 'Duplicate') + entry('http://127.0.0.1/abs/2609.00002', 'Foreign'));
  assert.deepEqual(result, [{ title: 'AI & reasoning', url: 'https://arxiv.org/abs/2609.00001v1' }]);
  assert.throws(() => parsePaperLinks('<h1>Rate limited</h1>'), /no usable/);
});

test('2,000-paper roster, reviews and shared list survive restart; ownership and bounded paging hold', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mindspace-papers-'));
  let store = new Store(join(directory, 'mindspace.sqlite'));
  try {
    const human = store.createIdentity('Human');
    const snapshot = store.createSession(input, human, 'simulation', papers);
    const agents = snapshot.participants.filter(p => p.kind === 'agent');
    assert.equal(agents.length, 3);
    assert.equal(new Set(agents.map(p => p.instructions)).size, 1);
    assert.deepEqual(agents.map(p => store.exportPapers(snapshot.session.id).filter(paper => paper.reviewerId === p.id).length), [667, 667, 666]);
    const page = store.readPapers(snapshot.session.id, { reviewerId: agents[0].id, status: 'pending', limit: 5 });
    assert.deepEqual(page.papers.map(p => p.number), [1, 4, 7, 10, 13]);
    assert.equal(page.hasMore, true);
    assert.throws(() => store.recordPaperReview(snapshot.session.id, agents[1].id, 1, 'reviewed', 'Wrong reviewer'), /assigned reviewer/);
    store.recordPaperReview(snapshot.session.id, agents[0].id, 1, 'reviewed', 'Abstract-based review');
    const sequence = store.snapshot(snapshot.session.id).eventSeq;
    store.recordPaperReview(snapshot.session.id, agents[0].id, 1, 'reviewed', 'Abstract-based review');
    assert.equal(store.snapshot(snapshot.session.id).eventSeq, sequence, 'same tool retry has no extra side effects');
    const root = experimentDirectory(directory, snapshot.session.id);
    assert.equal(readFileSync(join(root, 'papers.jsonl'), 'utf8').trim().split('\n').length, 2000);
    assert.equal(readFileSync(join(root, 'papers.csv'), 'utf8').trim().split('\n').length, 2001);
    store.close(); store = new Store(join(directory, 'mindspace.sqlite')); store.recover();
    assert.deepEqual(store.snapshot(snapshot.session.id).paperProgress, { total: 2000, pending: 1999, reviewed: 1, unavailable: 0 });
    assert.equal(store.readPapers(snapshot.session.id, { reviewerId: agents[0].id, status: 'pending' }).papers[0].number, 4);
    assert.throws(() => store.readPapers(snapshot.session.id, { limit: 2000 }), /Invalid/);
    const newcomer = store.addAgent(snapshot.session.id, { name: 'Owl', instructions: 'Find themes.', webFetch: true }, human.id);
    assert.equal(newcomer.paperReview, true);
    assert.equal(store.readPapers(snapshot.session.id, { reviewerId: newcomer.id }).papers.length, 0);
    assert.throws(() => store.recordPaperReview(snapshot.session.id, newcomer.id, 1, 'reviewed', 'Overwrite'), /assigned reviewer/);
    store.addAgent(snapshot.session.id, { name: 'Otter', instructions: 'Check evidence.', webFetch: true }, human.id);
    assert.throws(() => store.addAgent(snapshot.session.id, { name: 'Six', instructions: 'More.', webFetch: true }, human.id), /at most five/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('shared files prevent lost updates, protect imported lists, and reject traversal and symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'mindspace-files-'));
  try {
    const created = writeSharedFile(root, 'notes/fox.md', 'First draft', null);
    assert.throws(() => writeSharedFile(root, 'notes/fox.md', 'Clobber', null), /changed/);
    writeSharedFile(root, 'notes/fox.md', 'Second draft', created.revision);
    assert.throws(() => writeSharedFile(root, 'notes/fox.md', 'Stale draft', created.revision), /changed/);
    assert.equal(readSharedFile(root, 'notes/fox.md').text, 'Second draft');
    assert.throws(() => writeSharedFile(root, 'papers.jsonl', 'overwrite', null), /read-only/);
    assert.throws(() => writeSharedFile(root, '../outside', 'escape', null), /relative path/);
    symlinkSync(tmpdir(), join(root, 'escape'));
    assert.throws(() => writeSharedFile(root, 'escape/file', 'escape', null), /Symbolic/);
    const long = 'a'.repeat(21000); writeSharedFile(root, 'long.txt', long, null);
    assert.equal(readSharedFile(root, 'long.txt').text.length, 20000);
    assert.equal(readSharedFile(root, 'long.txt', 20000).text.length, 1000);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('workspace listings expose review directories and page beyond the first 200 files', () => {
  const root = mkdtempSync(join(tmpdir(), 'mindspace-list-files-'));
  try {
    mkdirSync(join(root, 'papers')); mkdirSync(join(root, 'reviews'));
    for (let i = 1; i <= 205; i++) writeFileSync(join(root, 'papers', `${String(i).padStart(4, '0')}.txt`), 'Paper');
    writeFileSync(join(root, 'reviews/0001.md'), 'Review');
    const first = listSharedFiles(root);
    assert.deepEqual(first.directories, ['papers', 'reviews']);
    assert.equal(first.files.length, 200); assert.equal(first.hasMore, true);
    assert.equal(listSharedFiles(root, { offset: first.nextOffset }).files.length, 6);
    assert.equal(listSharedFiles(root, { path: 'reviews' }).files[0].path, 'reviews/0001.md');
    assert.throws(() => listSharedFiles(root, { path: '../outside' }), /relative path/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('preset API requires authentication, exports full corpus, adds members only for joined humans, and leaves failed imports empty', async () => {
  const store = new Store(':memory:');
  let fails = false; let imports = 0;
  const app = await buildApp({ store, health: { mode: 'simulation', available: true, model: 'test', effort: 'high' }, scheduler: { control: () => {}, onMessage: () => {}, shutdown: () => {} }, arxivExperiment: async () => { imports++; if (fails) throw new Error('Rate limited'); return { input, papers }; } });
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/sessions/arxiv' })).statusCode, 401);
    assert.equal(imports, 0);
    const human = (await app.inject({ method: 'POST', url: '/api/identities', payload: { name: 'Human' } })).json<Identity>();
    const headers = { authorization: `Bearer ${human.token}` };
    const created = await app.inject({ method: 'POST', url: '/api/sessions/arxiv', headers });
    assert.equal(created.statusCode, 201, created.body);
    const snapshot = created.json<Snapshot>();
    assert.equal(snapshot.session.status, 'paused', 'client starts only after creation is acknowledged');
    assert.equal(snapshot.paperProgress?.total, 2000);
    const base = `/api/sessions/${snapshot.session.id}`;
    assert.equal((await app.inject({ url: `${base}/export`, headers })).json().papers.length, 2000);
    const other = store.createIdentity('Observer');
    const add = { method: 'POST' as const, url: `${base}/agents`, payload: { name: 'Owl', instructions: 'Synthesize reviews.' } };
    assert.equal((await app.inject({ ...add, headers: { authorization: `Bearer ${other.token}` } })).statusCode, 403);
    assert.equal((await app.inject({ ...add, headers })).statusCode, 201);
    assert.equal((await app.inject({ ...add, headers })).statusCode, 400, 'duplicate names rejected');
    fails = true;
    assert.equal((await app.inject({ method: 'POST', url: '/api/sessions/arxiv', headers })).statusCode, 502);
    assert.equal(store.listSessions().length, 1);
    const tools = chatTools(true, true).map(tool => tool.name);
    assert(tools.includes('read_papers') && tools.includes('write_shared_file') && tools.includes('record_paper_review'));
    assert(!chatTools(true).some(tool => tool.name === 'read_papers'));
  } finally { await app.close(); store.close(); }
});

test('existing local PDFs extract once and are reused without remote requests', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { cachePaper } = await import('../src/server/paper-cache.js');
  const directory = mkdtempSync(join(tmpdir(), 'mindspace-pdf-'));
  const root = experimentDirectory(directory, 'test-session');
  mkdirSync(join(root, 'papers'), { recursive: true });
  const stream = 'BT /F1 12 Tf 20 80 Td (Hello Mindspace) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n'; const offsets: number[] = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  writeFileSync(join(root, 'papers/0001.pdf'), pdf);
  try {
    const paper = { number: 1, url: 'https://arxiv.org/abs/2609.00001' };
    const result = await cachePaper(directory, 'test-session', paper);
    assert.equal(result.pages, 1);
    assert.match(readFileSync(join(root, result.textPath), 'utf8'), /Hello Mindspace/);
    assert.deepEqual(await cachePaper(directory, 'test-session', paper), result);
    await assert.rejects(cachePaper(directory, 'test-session', { number: 2, url: 'http://127.0.0.1/private' }), /saved arXiv/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
