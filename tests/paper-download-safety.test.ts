import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync, rmSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { downloadPaperFile } from '../src/server/paper-download.js';
import { fetchHostedPapers } from '../src/server/paper-source.js';
import { cachePaper, preparedPaperDirectory } from '../src/server/paper-cache.js';
import { experimentDirectory } from '../src/server/experiment-files.js';
import { extractPdf, MAX_HOSTED_PDF_BYTES, processResidentBytes } from '../src/server/pdf-extraction.js';
import { copyPreparedPaper, paperStorageAllowance, PAPER_FREE_SPACE_FLOOR } from '../src/server/paper-storage.js';
import { MAX_SHARED_TEXT_BYTES } from '../src/server/file-limits.js';
import { downloadPapers } from '../scripts/download-papers.js';

test('hosted manifest and PDF requests never follow redirects to another endpoint', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mindspace-redirect-'));
  // A user curlrc must not silently re-enable redirect following.
  writeFileSync(join(directory, '.curlrc'), 'location\n');
  const previousCurlHome = process.env.CURL_HOME;
  t.after(() => {
    if (previousCurlHome === undefined) delete process.env.CURL_HOME;
    else process.env.CURL_HOME = previousCurlHome;
  });
  process.env.CURL_HOME = directory;
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url!);
    res.writeHead(302, { location: '/private' }); res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}/`;
  try {
    await assert.rejects(fetchHostedPapers(base), /redirects are not allowed/);
    await assert.rejects(downloadPaperFile(`${base}papers/0001.pdf`, join(directory, 'paper.pdf'), { maxBytes: 10000, timeoutMs: 1000, allowPrivate: true }), /redirects are not allowed/);
    assert.deepEqual(hits, ['/manifest.csv', '/papers/0001.pdf']);
    await assert.rejects(downloadPaperFile(`${base}private`, join(directory, 'private'), { maxBytes: 1000, timeoutMs: 1000 }), /private address/);
    assert.equal(hits.length, 2, 'unapproved private addresses are rejected before HTTP');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});

test('literal IPv6 corpus endpoints download without a DNS override', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mindspace-ipv6-'));
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url!);
    res.end('%PDF- IPv6 fixture');
  });
  try {
    server.listen(0, '::1'); await once(server, 'listening');
    const { port } = server.address() as { port: number };
    const destination = join(directory, 'paper.pdf');
    const url = `http://[::1]:${port}/papers/0001.pdf`;
    await downloadPaperFile(url, destination, { maxBytes: 1000, timeoutMs: 2000, allowPrivate: true });
    assert.equal(readFileSync(destination, 'utf8'), '%PDF- IPv6 fixture');
    await assert.rejects(downloadPaperFile(url, destination, { maxBytes: 1000, timeoutMs: 2000 }), /private address/);
    assert.deepEqual(hits, ['/papers/0001.pdf']);
  } finally {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('prepared PDF reuse trusts the source experiment list rather than the current fixture', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mindspace-provenance-'));
  const source = experimentDirectory(directory, 'old-experiment');
  const paper = { number: 1, url: 'https://arxiv.org/abs/2609.00001' };
  try {
    mkdirSync(source, { recursive: true }); mkdirSync(join(directory, 'corpora'));
    writeFileSync(join(directory, 'corpora/download-experiment.json'), JSON.stringify({ sessionId: 'old-experiment' }));
    writeFileSync(join(directory, 'corpora/ai-2000.json'), JSON.stringify({ papers: [paper] }));
    writeFileSync(join(source, 'papers.jsonl'), JSON.stringify({ number: 1, url: 'https://arxiv.org/abs/2609.99999' }));
    assert.equal(await preparedPaperDirectory(directory, 'new-experiment', paper), undefined);
    writeFileSync(join(source, 'papers.jsonl'), JSON.stringify(paper));
    assert.equal(await preparedPaperDirectory(directory, 'new-experiment', paper), source);
    writeFileSync(join(source, 'papers.jsonl'), `${JSON.stringify(paper)}\n${JSON.stringify(paper)}`);
    assert.equal(await preparedPaperDirectory(directory, 'new-experiment', paper), undefined, 'ambiguous source numbers cannot be reused');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('OCR failures do not stop later PDF downloads, but three download failures still stop', async t => {
  t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {});
  for (const extractionOnly of [true, false]) {
    const directory = mkdtempSync(join(tmpdir(), 'mindspace-batch-'));
    const root = experimentDirectory(directory, 'batch');
    const papers = Array.from({ length: 5 }, (_, i) => ({ number: i + 1, url: `https://arxiv.org/abs/2609.0000${i + 1}` }));
    mkdirSync(join(root, 'papers'), { recursive: true });
    writeFileSync(join(root, 'papers.jsonl'), papers.map(paper => JSON.stringify(paper)).join('\n'));
    const visited: number[] = [];
    let prepared = false;
    try {
      const result = await downloadPapers(directory, 'batch', {
        sleep: async () => {},
        prepare: async () => { prepared = true; },
        cache: async (_dataDir, _sessionId, paper) => {
          visited.push(paper.number);
          const pdfPath = `papers/${String(paper.number).padStart(4, '0')}.pdf`;
          if (extractionOnly || paper.number > 3) writeFileSync(join(root, pdfPath), '%PDF- fixture');
          if (paper.number <= 3) throw new Error(extractionOnly ? 'Requires OCR' : 'Download unavailable');
          return { pdfPath, textPath: pdfPath.replace('.pdf', '.txt'), pages: 1, textTruncated: false };
        },
      });
      assert.equal(result.currentPaper, extractionOnly ? 5 : 3);
      assert.equal(prepared, extractionOnly, 'only complete downloads are published');
      assert.equal(visited.includes(5), extractionOnly);
      assert.deepEqual(result.failures.map(f => f.stage), Array(3).fill(extractionOnly ? 'extraction' : 'download'));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

test('isolated PDF extraction rejects oversized inputs and enforces memory and time limits', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mindspace-parser-'));
  const pdf = join(directory, 'paper.pdf'); const text = join(directory, 'paper.txt');
  const worker = join(directory, 'blocked.mjs');
  try {
    writeFileSync(pdf, '%PDF-'); truncateSync(pdf, MAX_HOSTED_PDF_BYTES + 1);
    await assert.rejects(extractPdf(pdf, text), /150 MB/);
    truncateSync(pdf, 5);
    writeFileSync(worker, 'setInterval(() => {}, 1000);');
    await assert.rejects(extractPdf(pdf, text, { worker: pathToFileURL(worker), memoryMb: 1, timeoutMs: 5000 }), /memory limit/);
    await assert.rejects(extractPdf(pdf, text, { worker: pathToFileURL(worker), timeoutMs: 30 }), /timed out/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('paper storage bounds cumulative files and reserves free space and extraction overhead', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mindspace-storage-'));
  const overhead = MAX_SHARED_TEXT_BYTES + 65536;
  try {
    writeFileSync(join(root, '0001.pdf'), 'a'.repeat(100));
    writeFileSync(join(root, '.interrupted.part'), 'b'.repeat(50));
    const budget = { quotaBytes: overhead + 200, freeBytes: PAPER_FREE_SPACE_FLOOR + overhead + 1000 };
    assert.equal(await paperStorageAllowance(root, budget), 50);
    writeFileSync(join(root, '0002.pdf'), 'c'.repeat(50));
    await assert.rejects(paperStorageAllowance(root, budget), /storage limit/);
    await assert.rejects(paperStorageAllowance(root, { quotaBytes: overhead + 1000, freeBytes: PAPER_FREE_SPACE_FLOOR + overhead }), /storage limit/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('interrupted prepared copies never install partial PDFs and can be retried', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mindspace-copy-'));
  const source = join(root, 'source.pdf'); const destination = join(root, 'papers', '0001.pdf');
  mkdirSync(join(root, 'papers')); writeFileSync(source, '%PDF- complete');
  try {
    await assert.rejects(copyPreparedPaper(source, destination, async (_source, partial) => {
      writeFileSync(partial, '%PDF- partial'); throw new Error('Interrupted copy');
    }), /Interrupted copy/);
    assert.equal(existsSync(destination), false);
    assert.deepEqual(readdirSync(join(root, 'papers')), []);
    await copyPreparedPaper(source, destination);
    assert.equal(readFileSync(destination, 'utf8'), '%PDF- complete');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resident memory supervision works without ps in PATH', async t => {
  const previous = process.env.PATH;
  t.after(() => { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; });
  process.env.PATH = '';
  assert(await processResidentBytes(process.pid) > 0);
});

test('resuming a saved PDF reserves extraction capacity before starting the parser', async t => {
  const data = mkdtempSync(join(tmpdir(), 'mindspace-retry-capacity-'));
  const root = experimentDirectory(data, 'retry');
  const previous = process.env.MINDSPACE_PAPER_CACHE_MAX_BYTES;
  t.after(() => { if (previous === undefined) delete process.env.MINDSPACE_PAPER_CACHE_MAX_BYTES; else process.env.MINDSPACE_PAPER_CACHE_MAX_BYTES = previous; });
  process.env.MINDSPACE_PAPER_CACHE_MAX_BYTES = '1024';
  mkdirSync(join(root, 'papers'), { recursive: true });
  writeFileSync(join(root, 'papers/0001.pdf'), '%PDF- saved before an extraction failure');
  try {
    await assert.rejects(cachePaper(data, 'retry', { number: 1, url: 'https://arxiv.org/abs/2609.00001' }), /storage limit/);
    assert.equal(existsSync(join(root, 'papers/0001.txt')), false);
    assert.equal(existsSync(join(root, 'papers/0001.json')), false);
    assert.equal(existsSync(join(root, 'papers/0001.pdf')), true);
  } finally { rmSync(data, { recursive: true, force: true }); }
});

test('a dual-stack hostname reaches an IPv4-only server and chunked responses obey the byte cap', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mindspace-multi-address-'));
  const server = createServer((req, res) => {
    if (req.url === '/large') { res.writeHead(200, { 'Transfer-Encoding': 'chunked' }); res.end('x'.repeat(100000)); }
    else res.end('%PDF- IPv4 listener');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const { port } = server.address() as { port: number };
  const base = `http://localhost:${port}`;
  try {
    await downloadPaperFile(`${base}/paper`, join(directory, 'paper.pdf'), { maxBytes: 1024, timeoutMs: 5000, allowPrivate: true });
    assert.equal(readFileSync(join(directory, 'paper.pdf'), 'utf8'), '%PDF- IPv4 listener');
    await assert.rejects(downloadPaperFile(`${base}/large`, join(directory, 'large.pdf'), { maxBytes: 1024, timeoutMs: 5000, allowPrivate: true }), /maximum file size|exceeded|63/i);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});
