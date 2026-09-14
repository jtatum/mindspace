import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowPrivatePaperHost, downloadPaperFile } from './paper-download.js';

export interface HostedPaper { title: string; url: string }

export function papersBaseUrl(value = process.env.MINDSPACE_PAPERS_BASE_URL): string | undefined {
  if (!value?.trim()) return undefined;
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('MINDSPACE_PAPERS_BASE_URL must be an HTTP(S) directory URL without credentials, query or fragment');
  }
  url.pathname = url.pathname.replace(/\/+$/, '') + '/';
  return url.href;
}

// The hosted manifest is the authority for numbered files: never pair a fresh
// arXiv search result with a PDF from a different, previously prepared corpus.
export function parseHostedManifest(csv: string): HostedPaper[] {
  const rows: string[][] = []; let row: string[] = []; let field = ''; let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (c === '"') {
      if (quoted && csv[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (c === ',' || c === '\n')) {
      row.push(field.replace(/\r$/, '')); field = '';
      if (c === '\n') { rows.push(row); row = []; }
    } else field += c;
  }
  if (quoted) throw new Error('Unclosed quote in hosted paper manifest');
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  const header = rows.shift();
  if (header?.join(',') !== 'number,title,arxiv_url,pdf_path,text_path' || rows.length !== 2000) {
    throw new Error('Hosted manifest must contain the expected header and all 2,000 papers');
  }
  const seen = new Set<string>();
  return rows.map((fields, i) => {
    const [number, title, url, pdf, text] = fields;
    const stem = String(i + 1).padStart(4, '0');
    if (fields.length !== 5 || number !== String(i + 1) || !title?.trim() || title.length > 2000 ||
        !/^https:\/\/arxiv\.org\/abs\/(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)$/.test(url) ||
        seen.has(url.replace(/v\d+$/, '')) || pdf !== `papers/${stem}.pdf` || text !== `papers/${stem}.txt`) {
      throw new Error(`Invalid or mismatched hosted paper manifest row ${i + 1}`);
    }
    seen.add(url.replace(/v\d+$/, ''));
    return { title, url };
  });
}

let cached: { base: string; expires: number; result: Promise<HostedPaper[]> } | undefined;
export function fetchHostedPapers(base: string): Promise<HostedPaper[]> {
  if (cached?.base === base && cached.expires > Date.now()) return cached.result;
  const result = (async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mindspace-manifest-'));
    try {
      const path = join(directory, 'manifest.csv');
      await downloadPaperFile(new URL('manifest.csv', base).href, path, { maxBytes: 5000000, timeoutMs: 30000, allowPrivate: allowPrivatePaperHost(base) });
      return parseHostedManifest(await readFile(path, 'utf8'));
    } finally { await rm(directory, { recursive: true, force: true }); }
  })();
  cached = { base, expires: Date.now() + 5 * 60000, result };
  void result.catch(() => { if (cached?.result === result) cached = undefined; });
  return result;
}

export async function hostedPdfUrl(base: string, paper: { number: number; url: string }): Promise<string> {
  const papers = await fetchHostedPapers(base);
  if (papers[paper.number - 1]?.url !== paper.url) throw new Error('Hosted corpus does not match this experiment’s paper; refusing to download a different paper');
  return new URL(`papers/${String(paper.number).padStart(4, '0')}.pdf`, base).href;
}
