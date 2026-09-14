import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
export async function fetchArxivListing(url: string): Promise<string> {
  const parsed = new URL(url);
  if (parsed.origin !== 'https://arxiv.org' || parsed.pathname !== '/search/') throw new Error('Only arXiv search listings are allowed');
  const { stdout } = await run('curl', ['--fail', '--silent', '--show-error', '--max-time', '60', '--max-filesize', '1000000', url], { encoding: 'utf8', maxBuffer: 1000000, timeout: 65000 });
  return stdout;
}
