import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { promisify } from 'node:util';
import { isPublicAddress } from './web-fetch.js';

const run = promisify(execFile);
export function allowPrivatePaperHost(base: string): boolean {
  const hostname = new URL(base).hostname.replace(/^\[|\]$/g, '');
  // Literal addresses/localhost explicitly identify the operator's endpoint.
  return !!isIP(hostname) || hostname === 'localhost' || process.env.MINDSPACE_PAPERS_ALLOW_PRIVATE === 'true';
}

export async function downloadPaperFile(urlString: string, destination: string, options: { maxBytes: number; timeoutMs: number; allowPrivate?: boolean }) {
  const url = new URL(urlString);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid paper download URL');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const addresses = await Promise.race([
    lookup(hostname, { all: true }),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Paper host DNS lookup timed out')), 10000); }),
  ]).finally(() => clearTimeout(timer));
  if (!addresses.length || (!options.allowPrivate && addresses.some(address => !isPublicAddress(address.address)))) throw new Error('Paper host resolves to a private address; configure MINDSPACE_PAPERS_ALLOW_PRIVATE=true only for an intended private corpus server');
  const address = addresses[0];
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const pinned = address.family === 6 ? `[${address.address}]` : address.address;
  // Do not follow redirects: the configured corpus endpoint is the only grant.
  // Pin DNS and bypass environment proxies so the checked address is used.
  const { stdout } = await run('curl', ['--fail', '--silent', '--show-error', '--noproxy', '*', '--proto', '=http,https', '--resolve', `${url.hostname}:${port}:${pinned}`, '--max-time', String(options.timeoutMs / 1000), '--max-filesize', String(options.maxBytes), '--output', destination, '--write-out', '%{http_code}', url.href], { encoding: 'utf8', maxBuffer: 10000, timeout: options.timeoutMs + 5000 });
  if (!/^2\d\d$/.test(stdout.trim())) throw new Error(`Paper server returned HTTP ${stdout.trim()}; redirects are not allowed. Configure a direct corpus URL.`);
}
