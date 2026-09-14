import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishPreparedCorpus } from '../src/server/prepared-corpus.js';
import { parseHostedManifest } from '../src/server/paper-source.js';
import { preparedPaperDirectory } from '../src/server/paper-cache.js';
import { isPreparedPaperList } from '../src/server/arxiv.js';
import { experimentDirectory } from '../src/server/experiment-files.js';

test('completed bulk corpora publish a hosting manifest, fixed list and verified reuse marker', async () => {
  const data = mkdtempSync(join(tmpdir(), 'mindspace-publish-corpus-'));
  const root = experimentDirectory(data, 'source');
  const papers = Array.from({ length: 2000 }, (_, i) => ({ number: i + 1, title: `Paper ${i + 1}, "AI"\nresearch`, url: `https://arxiv.org/abs/2609.${String(i + 1).padStart(5, '0')}` }));
  papers[0].url = 'https://arxiv.org/abs/hep-th/9901001';
  mkdirSync(join(root, 'papers'), { recursive: true });
  writeFileSync(join(root, 'papers.jsonl'), papers.map(p => JSON.stringify(p)).join('\n'));
  try {
    for (const paper of papers.slice(0, -1)) writeFileSync(join(root, 'papers', `${String(paper.number).padStart(4, '0')}.pdf`), '%PDF- fixture');
    await assert.rejects(publishPreparedCorpus(data, 'source', papers), /ENOENT/);
    assert.equal(existsSync(join(root, 'manifest.csv')), false);
    assert.equal(existsSync(join(data, 'corpora/download-experiment.json')), false);
    writeFileSync(join(root, 'papers/2000.pdf'), '%PDF- fixture');
    await publishPreparedCorpus(data, 'source', papers);
    const manifest = parseHostedManifest(readFileSync(join(root, 'manifest.csv'), 'utf8'));
    assert.deepEqual(manifest, papers.map(({ title, url }) => ({ title, url })));
    assert(isPreparedPaperList(JSON.parse(readFileSync(join(data, 'corpora/ai-2000.json'), 'utf8')).papers));
    assert.equal(await preparedPaperDirectory(data, 'new-experiment', papers[0]), root);
    assert.equal(await preparedPaperDirectory(data, 'new-experiment', { number: 1, url: papers[1].url }), undefined);
  } finally { rmSync(data, { recursive: true, force: true }); }
});
