import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunLimits } from '../src/client/RunLimits.js';
import { DEFAULT_SETTINGS } from '../src/shared/types.js';
import { Store } from '../src/server/store.js';
import { buildApp } from '../src/server/app.js';
import { experimentDirectory, readSharedFile } from '../src/server/experiment-files.js';
import { MAX_PAPER_TEXT_CHARACTERS, MAX_SHARED_TEXT_BYTES } from '../src/server/file-limits.js';

test('settings show only active legacy/API limits and reserve None for unlimited runs', () => {
  const render = (settings = DEFAULT_SETTINGS) => renderToStaticMarkup(createElement(RunLimits, { settings }));
  assert.match(render(), /<dd>None<\/dd>/);
  const limits = { turnTimeoutMs: 300000, maxRounds: 300, maxTurns: 3000, maxTokens: 20000000, maxDurationMs: 604800000 };
  for (const [key, value] of Object.entries(limits)) {
    assert.doesNotMatch(render({ ...DEFAULT_SETTINGS, [key]: value }), /None/);
  }
  const html = render({ ...DEFAULT_SETTINGS, ...limits });
  for (const label of ['Turn timeout', 'Round limit', 'Turn limit', 'Token budget', 'Session time limit']) assert(html.includes(label));
  assert.match(html, /300 seconds/); assert.match(html, /10080 minutes/);
});

test('shared-file API pages the full workspace and can open reviews hidden behind cached papers', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mindspace-api-files-'));
  const store = new Store(join(directory, 'mindspace.sqlite'));
  const app = await buildApp({ store, dataDir: directory, health: { mode: 'simulation', available: true, model: 'test', effort: 'high' }, scheduler: { control() {}, onMessage() {}, shutdown() {} } });
  try {
    const human = store.createIdentity('Observer');
    const snapshot = store.createSession({ title: 'Large corpus', task: 'Review papers', agents: ['A', 'B', 'C'].map(name => ({ name, instructions: '' })) }, human, 'simulation');
    const root = experimentDirectory(directory, snapshot.session.id);
    mkdirSync(join(root, 'papers')); mkdirSync(join(root, 'reviews'));
    for (let i = 1; i <= 205; i++) writeFileSync(join(root, 'papers', `${String(i).padStart(4, '0')}.txt`), 'Paper');
    writeFileSync(join(root, 'reviews/0001.md'), 'Review');
    const get = (query = '') => app.inject({ url: `/api/sessions/${snapshot.session.id}/files${query}`, headers: { authorization: `Bearer ${human.token}` } });
    const first = (await get()).json();
    assert.equal(first.files.length, 200); assert.equal(first.hasMore, true);
    assert.deepEqual(first.directories, ['papers', 'reviews']);
    const next = (await get(`?offset=${first.nextOffset}`)).json();
    assert.equal(next.files.length, 7); assert.equal(next.hasMore, false);
    assert(next.files.some((file: { path: string }) => file.path === 'reviews/0001.md'));
    const reviews = (await get('?directory=reviews')).json();
    assert.equal(reviews.files[0].path, 'reviews/0001.md');
    assert.equal((await get('?path=reviews%2F0001.md')).json().text, 'Review');
    assert.equal((await get('?directory=..')).statusCode, 400);
    assert.equal((await get('?directory=reviews&path=README.md')).statusCode, 400);
  } finally { await app.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('the largest multibyte cached text stays readable through the final page', () => {
  const root = mkdtempSync(join(tmpdir(), 'mindspace-cjk-text-'));
  try {
    const text = '文'.repeat(MAX_PAPER_TEXT_CHARACTERS);
    assert.equal(Buffer.byteLength(text), MAX_SHARED_TEXT_BYTES);
    writeFileSync(join(root, 'paper.txt'), text);
    assert.equal(readSharedFile(root, 'paper.txt').text, text.slice(0, 20000));
    const last = readSharedFile(root, 'paper.txt', MAX_PAPER_TEXT_CHARACTERS - 10);
    assert.equal(last.text, '文'.repeat(10)); assert.equal(last.hasMore, false);
    writeFileSync(join(root, 'oversize.txt'), text + 'x');
    assert.throws(() => readSharedFile(root, 'oversize.txt'), /read limit/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
