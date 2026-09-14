import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { papersBaseUrl, parseHostedManifest, hostedPdfUrl } from '../src/server/paper-source.js';
import { fetchAiExperiment, isPreparedPaperList } from '../src/server/arxiv.js';

const manifest = 'number,title,arxiv_url,pdf_path,text_path\r\n' + Array.from({ length: 2000 }, (_, i) => {
  const stem = String(i + 1).padStart(4, '0');
  return `${i + 1},"AI, paper ""${i + 1}""",https://arxiv.org/abs/2609.${String(i + 1).padStart(5, '0')},papers/${stem}.pdf,papers/${stem}.txt\r\n`;
}).join('');

test('prepared fixtures require 2,000 distinct arXiv IDs regardless of version suffix', () => {
  const papers = parseHostedManifest(manifest).map(paper => ({ ...paper, url: `${paper.url}v1` }));
  assert.equal(isPreparedPaperList(papers), true, 'distinct versioned citations remain valid');
  const duplicate = papers.map(paper => ({ ...paper }));
  duplicate[1].url = duplicate[0].url.replace(/v1$/, 'v2');
  assert.equal(isPreparedPaperList(duplicate), false, 'two versions do not supply two distinct papers');
  duplicate[1].url = duplicate[0].url.replace(/v1$/, '');
  assert.equal(isPreparedPaperList(duplicate), false, 'versioned and versionless forms identify the same paper');
  assert.equal(isPreparedPaperList([...papers.slice(0, -1), { title: 'Malformed', url: null }]), false);
});

test('paper host normalization preserves directory paths and rejects ambiguous config', () => {
  assert.equal(papersBaseUrl('https://example.org/ai-papers'), 'https://example.org/ai-papers/');
  assert.equal(papersBaseUrl('http://localhost:8080/ai-papers/'), 'http://localhost:8080/ai-papers/');
  assert.equal(papersBaseUrl(''), undefined);
  for (const value of ['ftp://example.org', 'https://user:pass@example.org', 'https://example.org/?key=a', 'https://example.org/#a']) {
    assert.throws(() => papersBaseUrl(value), /HTTP/);
  }
});

test('hosted manifest handles CSV quoting and rejects partial, duplicate or misnumbered corpora', () => {
  const papers = parseHostedManifest(manifest);
  assert.equal(papers.length, 2000);
  assert.equal(papers[0].title, 'AI, paper "1"');
  assert.throws(() => parseHostedManifest(manifest.split('\r\n').slice(0, 2000).join('\r\n')), /2,000/);
  assert.throws(() => parseHostedManifest(manifest.replace('2609.00002', '2609.00001')), /row 2/);
  assert.throws(() => parseHostedManifest(manifest.replace('papers/0001.pdf', 'papers/0002.pdf')), /row 1/);
});

test('configured host supplies preset and PDF URLs; mismatch and host failure do not fall back to arXiv', async t => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!);
    if (req.url === '/ai-papers/manifest.csv') res.end(manifest);
    else { res.statusCode = 404; res.end('missing'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const previous = process.env.MINDSPACE_PAPERS_BASE_URL;
  t.after(() => { if (previous === undefined) delete process.env.MINDSPACE_PAPERS_BASE_URL; else process.env.MINDSPACE_PAPERS_BASE_URL = previous; });
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}/ai-papers/`;
  process.env.MINDSPACE_PAPERS_BASE_URL = base;
  const corpus = await fetchAiExperiment('/nonexistent');
  assert.equal(corpus.papers.length, 2000);
  assert.equal(await hostedPdfUrl(base, { number: 1, url: corpus.papers[0].url }), `${base}papers/0001.pdf`);
  await assert.rejects(hostedPdfUrl(base, { number: 1, url: corpus.papers[1].url }), /does not match/);
  assert.deepEqual(requests, ['/ai-papers/manifest.csv']);
  process.env.MINDSPACE_PAPERS_BASE_URL = `http://127.0.0.1:${address.port}/missing/`;
  await assert.rejects(fetchAiExperiment('/nonexistent'), /No experiment was created/);
});
