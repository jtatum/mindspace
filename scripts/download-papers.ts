import { access, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { cachePaper } from '../src/server/paper-cache.js';
import { experimentDirectory } from '../src/server/experiment-files.js';
const sessionId = process.argv[2];
if (!sessionId) throw new Error('Usage: npm run papers:download -- <experiment-id>. Pause the experiment before bulk downloading.');
const dataDir = resolve(process.env.MINDSPACE_DATA_DIR || '.mindspace');
const directory = experimentDirectory(dataDir, sessionId);
const papers = (await readFile(join(directory, 'papers.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const failures: Array<{ number: number; error: string }> = [];
async function progress(running: boolean, currentPaper: number) {
  const files = await readdir(join(directory, 'papers')).catch(() => [] as string[]);
  const value = { sessionId, total: papers.length, downloaded: files.filter(name => /^\d+\.pdf$/.test(name)).length, extracted: files.filter(name => /^\d+\.json$/.test(name)).length, running, currentPaper, failures, updatedAt: new Date().toISOString() };
  await writeFile(join(directory, 'download-status.tmp'), JSON.stringify(value, null, 2));
  await rename(join(directory, 'download-status.tmp'), join(directory, 'download-status.json'));
  return value;
}
await progress(true, 0);
for (const paper of papers) {
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const saved = await cachePaper(dataDir, sessionId, paper);
      console.log(`${paper.number}/${papers.length} ${saved.pdfPath}${saved.textTruncated ? ' (text extraction truncated)' : ''}`);
      failure = undefined; break;
    } catch (error) {
      failure = error;
      // Extraction failures do not prevent collecting the remaining PDFs.
      const pdfExists = await access(join(directory, 'papers', `${String(paper.number).padStart(4, '0')}.pdf`)).then(() => true, () => false);
      if (pdfExists) break;
      console.error(`Paper ${paper.number}, attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`);
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 60000 * (attempt + 1)));
    }
  }
  if (failure) failures.push({ number: paper.number, error: failure instanceof Error ? failure.message : String(failure) });
  await progress(true, paper.number);
  // Avoid repeatedly hitting an unavailable upstream service. A rerun resumes.
  if (failures.length >= 3 && failures.slice(-3).every((entry, index) => entry.number === paper.number - 2 + index)) {
    console.error('Stopped after three consecutive failures. Rerun to resume.'); break;
  }
}
const final = await progress(false, papers.length);
if (final.downloaded < papers.length) process.exitCode = 1;
console.log(JSON.stringify(final));
