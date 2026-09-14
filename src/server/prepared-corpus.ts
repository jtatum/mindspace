import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { experimentDirectory, safePath } from './experiment-files.js';
import { parseHostedManifest } from './paper-source.js';

async function atomicWrite(path: string, text: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export async function publishPreparedCorpus(dataDir: string, sessionId: string, papers: Array<{ number: number; title: string; url: string }>) {
  const root = experimentDirectory(dataDir, sessionId);
  const quote = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;
  const csv = 'number,title,arxiv_url,pdf_path,text_path\n' + papers.map(paper => {
    const stem = String(paper.number).padStart(4, '0');
    return [paper.number, paper.title, paper.url, `papers/${stem}.pdf`, `papers/${stem}.txt`].map(quote).join(',');
  }).join('\n') + '\n';
  const links = parseHostedManifest(csv); // Validate numbering, paths and all 2,000 unique sources.
  // Never advertise an incomplete corpus; extraction/OCR failures are separate.
  for (const paper of papers) {
    const path = safePath(root, `papers/${String(paper.number).padStart(4, '0')}.pdf`);
    const file = await open(path, 'r');
    try {
      const header = Buffer.alloc(1024);
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      if (!(await file.stat()).isFile() || !header.subarray(0, bytesRead).includes(Buffer.from('%PDF-'))) throw new Error(`Paper ${paper.number} is not a completed PDF`);
    } finally { await file.close(); }
  }
  await atomicWrite(safePath(root, 'manifest.csv'), csv);
  const directory = join(dataDir, 'corpora');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await atomicWrite(join(directory, 'ai-2000.json'), JSON.stringify({ papers: links }));
  // Publish provenance last: readers validate it against this source's saved list.
  await atomicWrite(join(directory, 'download-experiment.json'), JSON.stringify({ sessionId }));
}
