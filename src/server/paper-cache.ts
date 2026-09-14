import { access, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { experimentDirectory, listSharedFiles, safePath } from './experiment-files.js';
import type { Paper } from '../shared/types.js';
import { hostedPdfUrl, papersBaseUrl } from './paper-source.js';
import { allowPrivatePaperHost, downloadPaperFile } from './paper-download.js';
import { extractPdf, MAX_HOSTED_PDF_BYTES } from './pdf-extraction.js';
import { copyPreparedPaper, paperStorageAllowance } from './paper-storage.js';
let queue: Promise<unknown> = Promise.resolve();
let nextFetchAt = 0;
const inFlight = new Map<string, Promise<CachedPaper>>();
export interface CachedPaper { pdfPath: string; textPath: string; pages: number; textTruncated: boolean }

async function cache(dataDir: string, sessionId: string, paper: Pick<Paper, 'number' | 'url'>): Promise<CachedPaper> {
  if (!Number.isSafeInteger(paper.number) || paper.number < 1) throw new Error('Invalid paper number');
  const id = /^https:\/\/arxiv\.org\/abs\/(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)$/.exec(paper.url)?.[1];
  if (!id) throw new Error('Only saved arXiv paper links can be cached');
  const root = experimentDirectory(dataDir, sessionId);
  listSharedFiles(root); // Validate the experiment directory before accessing it.
  const directory = join(root, 'papers');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stem = String(paper.number).padStart(4, '0');
  const pdfPath = `papers/${stem}.pdf`; const textPath = `papers/${stem}.txt`;
  safePath(root, pdfPath); safePath(root, textPath);
  const metadata = safePath(root, `papers/${stem}.json`);
  try {
    const result = JSON.parse(await readFile(metadata, 'utf8')) as CachedPaper;
    await access(join(root, pdfPath)); await access(join(root, textPath));
    return result;
  } catch { /* Resume a missing or unfinished paper. Completed PDFs are reused. */ }
  // Match the actual source experiment's immutable list, not a mutable fixture.
  const source = await preparedPaperDirectory(dataDir, sessionId, paper);
  if (source) {
    try {
      await copyPreparedPaper(safePath(source, pdfPath), join(root, pdfPath));
      try {
        await copyPreparedPaper(safePath(source, textPath), join(root, textPath));
        await copyPreparedPaper(safePath(source, `papers/${stem}.json`), metadata);
        return JSON.parse(await readFile(metadata, 'utf8')) as CachedPaper;
      } catch { /* PDF is available while extraction may still be running. */ }
    } catch { /* No prepared local PDF yet. */ }
  }
  const pdf = join(root, pdfPath);
  try { await access(pdf); }
  catch {
    const base = papersBaseUrl();
    const downloadUrl = base ? await hostedPdfUrl(base, paper) : `https://arxiv.org/pdf/${id}`;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, nextFetchAt - Date.now())));
    nextFetchAt = Date.now() + 3100;
    const temporary = join(directory, `.${stem}-${randomUUID()}.part`);
    try {
      const maxBytes = Math.min(base ? MAX_HOSTED_PDF_BYTES : 50000000, await paperStorageAllowance(directory));
      await downloadPaperFile(downloadUrl, temporary, { maxBytes, timeoutMs: base ? 300000 : 90000, allowPrivate: base ? allowPrivatePaperHost(base) : false });
      const handle = await open(temporary, 'r');
      try {
        const header = Buffer.alloc(1024);
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        if (!header.subarray(0, bytesRead).includes(Buffer.from('%PDF-'))) throw new Error('Paper server did not return a PDF');
      } finally { await handle.close(); }
      await rename(temporary, pdf);
    } catch (error) {
      nextFetchAt = Date.now() + 60000;
      throw new Error(`PDF download failed; completed papers are preserved. ${error instanceof Error ? error.message : 'Retry later.'}`);
    } finally { await rm(temporary, { force: true }); }
  }
  // Resumed PDFs still need room for text/metadata, even without a new download.
  await paperStorageAllowance(directory);
  const extraction = await extractPdf(pdf, join(root, textPath));
  const result = { pdfPath, textPath, ...extraction };
  await writeFile(metadata, JSON.stringify(result), { mode: 0o600 });
  return result;
}

export async function preparedPaperDirectory(dataDir: string, sessionId: string, paper: Pick<Paper, 'number' | 'url'>): Promise<string | undefined> {
  try {
    const prepared = JSON.parse(await readFile(join(dataDir, 'corpora', 'download-experiment.json'), 'utf8'));
    if (prepared.sessionId === sessionId) return;
    const source = experimentDirectory(dataDir, prepared.sessionId);
    const entries = (await readFile(safePath(source, 'papers.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const matches = entries.filter(entry => entry.number === paper.number);
    if (matches.length === 1 && matches[0].url === paper.url) return source;
  } catch { /* Missing or invalid source provenance: download the requested paper. */ }
}

export function cachePaper(dataDir: string, sessionId: string, paper: Pick<Paper, 'number' | 'url'>): Promise<CachedPaper> {
  const key = `${experimentDirectory(dataDir, sessionId)}:${paper.number}`;
  const existing = inFlight.get(key); if (existing) return existing;
  const result = queue.then(() => cache(dataDir, sessionId, paper));
  queue = result.catch(() => {});
  inFlight.set(key, result);
  void result.finally(() => inFlight.delete(key)).catch(() => {});
  return result;
}
