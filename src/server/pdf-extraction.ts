import { execFile, fork } from 'node:child_process';
import { rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const MAX_HOSTED_PDF_BYTES = 150_000_000;
export async function extractPdf(pdf: string, textPath: string, options: { timeoutMs?: number; memoryMb?: number; worker?: URL } = {}): Promise<{ pages: number; textTruncated: boolean }> {
  if ((await stat(pdf)).size > MAX_HOSTED_PDF_BYTES) throw new Error('PDF saved, but exceeds the 150 MB extraction limit');
  return new Promise((resolve, reject) => {
    const worker = fork(fileURLToPath(options.worker ?? new URL('./pdf-extractor.mjs', import.meta.url)), [pdf, textPath], {
      execArgv: ['--max-old-space-size=192', '--max-semi-space-size=16'],
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let result: { pages: number; textTruncated: boolean } | undefined;
    let failure: Error | undefined;
    let checking = false;
    const stop = (error: Error) => { failure ??= error; worker.kill('SIGKILL'); };
    const deadline = setTimeout(() => stop(new Error('PDF saved, but extraction timed out')), options.timeoutMs ?? 120000);
    // External ArrayBuffers are outside V8's heap cap. The parent supervises
    // resident memory too, even while a parser blocks the child event loop.
    const memory = setInterval(() => {
      if (checking || !worker.pid) return;
      checking = true;
      execFile('ps', ['-o', 'rss=', '-p', String(worker.pid)], { timeout: 1000 }, (error, stdout) => {
        checking = false;
        if (error) { if (worker.exitCode === null && worker.signalCode === null) stop(new Error('Cannot supervise PDF parser memory')); return; }
        if (Number(stdout.trim()) > (options.memoryMb ?? 512) * 1024) stop(new Error('PDF saved, but extraction exceeded its memory limit'));
      });
    }, 200);
    worker.on('message', message => {
      const value = message as { pages?: number; textTruncated?: boolean; error?: string };
      if (value.error) failure = new Error(value.error);
      else if (Number.isSafeInteger(value.pages) && value.pages! > 0 && typeof value.textTruncated === 'boolean') result = { pages: value.pages!, textTruncated: value.textTruncated };
    });
    worker.once('error', error => { failure = error; });
    worker.once('close', async code => {
      clearTimeout(deadline); clearInterval(memory);
      if (worker.pid) await rm(`${textPath}.${worker.pid}.tmp`, { force: true }).catch(() => {});
      if (failure || code !== 0 || !result) reject(failure ?? new Error('PDF saved, but isolated extraction failed'));
      else resolve(result);
    });
  });
}
