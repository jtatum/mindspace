import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { experimentDirectory, listSharedFiles, safePath } from './experiment-files.js';
import type { Paper } from '../shared/types.js';
import { hostedPdfUrl, papersBaseUrl } from './paper-source.js';
import { MAX_PAPER_TEXT_CHARACTERS } from './file-limits.js';
const run = promisify(execFile);
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
  // Reuse the prepared corpus across experiments, matching both number and URL.
  try {
    const prepared = JSON.parse(await readFile(join(dataDir, 'corpora', 'download-experiment.json'), 'utf8'));
    const corpus = JSON.parse(await readFile(join(dataDir, 'corpora', 'ai-2000.json'), 'utf8'));
    if (prepared.sessionId !== sessionId && corpus.papers?.[paper.number - 1]?.url === paper.url) {
      const source = experimentDirectory(dataDir, prepared.sessionId);
      await copyFile(join(source, pdfPath), join(root, pdfPath));
      try {
        await copyFile(join(source, textPath), join(root, textPath));
        await copyFile(join(source, 'papers', `${stem}.json`), metadata);
        return JSON.parse(await readFile(metadata, 'utf8')) as CachedPaper;
      } catch { /* PDF is available while extraction may still be running. */ }
    }
  } catch { /* No prepared local PDF yet. */ }
  const pdf = join(root, pdfPath);
  try { await access(pdf); }
  catch {
    const base = papersBaseUrl();
    const downloadUrl = base ? await hostedPdfUrl(base, paper) : `https://arxiv.org/pdf/${id}`;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, nextFetchAt - Date.now())));
    nextFetchAt = Date.now() + 3100;
    const temporary = join(directory, `.${stem}-${randomUUID()}.part`);
    try {
      const protocols = base ? '=http,https' : '=https';
      await run('curl', ['--fail', '--silent', '--show-error', '--location', '--proto', protocols, '--proto-redir', protocols, '--max-redirs', '3', '--max-time', base ? '300' : '90', '--max-filesize', base ? '500000000' : '50000000', '--output', temporary, downloadUrl], { timeout: base ? 305000 : 95000, maxBuffer: 10000 });
      const bytes = await readFile(temporary);
      if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('Paper server did not return a PDF');
      await rename(temporary, pdf);
    } catch (error) {
      nextFetchAt = Date.now() + 60000;
      throw new Error(`PDF download failed; completed papers are preserved. ${error instanceof Error ? error.message : 'Retry later.'}`);
    } finally { await rm(temporary, { force: true }); }
  }
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfResources = new URL('../../', import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs'));
  const loadingTask = getDocument({ data: new Uint8Array(await readFile(pdf)), disableFontFace: true, useSystemFonts: false, standardFontDataUrl: fileURLToPath(new URL('standard_fonts/', pdfResources)), cMapUrl: fileURLToPath(new URL('cmaps/', pdfResources)), cMapPacked: true });
  const document = await loadingTask.promise;
  try {
    let text = ''; let extractedCharacters = 0; const pages = document.numPages; let truncated = pages > 300;
    for (let number = 1; number <= Math.min(pages, 300); number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const pageText = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('');
      extractedCharacters += pageText.trim().length;
      text += `\n\n--- Page ${number} ---\n${pageText}`;
      page.cleanup();
      if (text.length > MAX_PAPER_TEXT_CHARACTERS) { text = text.slice(0, MAX_PAPER_TEXT_CHARACTERS); truncated = true; break; }
    }
    if (!extractedCharacters) throw new Error('PDF saved, but no readable text was extracted. It may require OCR.');
    const result = { pdfPath, textPath, pages, textTruncated: truncated };
    await writeFile(join(root, textPath), text, { mode: 0o600 });
    await writeFile(metadata, JSON.stringify(result), { mode: 0o600 });
    return result;
  } finally { await loadingTask.destroy(); }
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
