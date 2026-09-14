import { access, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cachePaper } from '../src/server/paper-cache.js';
import { experimentDirectory } from '../src/server/experiment-files.js';
import { publishPreparedCorpus } from '../src/server/prepared-corpus.js';
export async function downloadPapers(dataDir: string, sessionId: string, options: { cache?: typeof cachePaper; sleep?: (ms: number) => Promise<void>; prepare?: typeof publishPreparedCorpus } = {}) {
  const cache = options.cache ?? cachePaper;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let consecutiveDownloadFailures = 0;
  let currentPaper = 0;
  const directory = experimentDirectory(dataDir, sessionId);
  const papers = (await readFile(join(directory, 'papers.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const failures: Array<{ number: number; error: string; stage: 'download' | 'extraction' }> = [];
  async function progress(running: boolean, currentPaper: number) {
    const files = await readdir(join(directory, 'papers')).catch(() => [] as string[]);
    const names = new Set(files);
    const count = (extension: string) => papers.filter(paper => names.has(`${String(paper.number).padStart(4, '0')}.${extension}`)).length;
    const value = { sessionId, total: papers.length, downloaded: count('pdf'), extracted: count('json'), running, currentPaper, failures, updatedAt: new Date().toISOString() };
    await writeFile(join(directory, 'download-status.tmp'), JSON.stringify(value, null, 2));
    await rename(join(directory, 'download-status.tmp'), join(directory, 'download-status.json'));
    return value;
  }
  await progress(true, 0);
  for (const paper of papers) {
    let failure: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const saved = await cache(dataDir, sessionId, paper);
        console.log(`${paper.number}/${papers.length} ${saved.pdfPath}${saved.textTruncated ? ' (text extraction truncated)' : ''}`);
        failure = undefined; break;
      } catch (error) {
        failure = error;
        // Extraction failures do not prevent collecting the remaining PDFs.
        const pdfExists = await access(join(directory, 'papers', `${String(paper.number).padStart(4, '0')}.pdf`)).then(() => true, () => false);
        if (pdfExists) break;
        console.error(`Paper ${paper.number}, attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`);
        if (attempt < 2) await sleep(60000 * (attempt + 1));
      }
    }
    const downloaded = await access(join(directory, 'papers', `${String(paper.number).padStart(4, '0')}.pdf`)).then(() => true, () => false);
    consecutiveDownloadFailures = failure && !downloaded ? consecutiveDownloadFailures + 1 : 0;
    if (failure) failures.push({ number: paper.number, error: failure instanceof Error ? failure.message : String(failure), stage: downloaded ? 'extraction' : 'download' });
    currentPaper = paper.number;
    await progress(true, paper.number);
    // Avoid repeatedly hitting an unavailable upstream service. A rerun resumes.
    if (consecutiveDownloadFailures >= 3) {
      console.error('Stopped after three consecutive download failures. Rerun to resume.'); break;
    }
  }
  const final = await progress(false, currentPaper);
  if (final.downloaded === final.total) await (options.prepare ?? publishPreparedCorpus)(dataDir, sessionId, papers);
  console.log(JSON.stringify(final));
  return final;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const sessionId = process.argv[2];
  if (!sessionId) throw new Error('Usage: npm run papers:download -- <experiment-id>. Pause the experiment before bulk downloading.');
  const final = await downloadPapers(resolve(process.env.MINDSPACE_DATA_DIR || '.mindspace'), sessionId);
  if (final.downloaded < final.total) process.exitCode = 1;
}
