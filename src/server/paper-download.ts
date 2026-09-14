import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { isPublicAddress } from './web-fetch.js';

const run = promisify(execFile);
let curlSupport: Promise<void> | undefined;
async function requireBoundedCurl() {
  curlSupport ??= (async () => {
    const { stdout } = await run('curl', ['--disable', '--version'], { encoding: 'utf8', maxBuffer: 10000, timeout: 5000 });
    const version = /^curl (\d+)\.(\d+)\./.exec(stdout);
    if (!version || Number(version[1]) < 8 || (Number(version[1]) === 8 && Number(version[2]) < 4)) throw new Error('Paper downloads require curl 8.4 or newer to bound unknown-length responses');
  })();
  try { await curlSupport; } catch (error) { curlSupport = undefined; throw error; }
}
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
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const pinned = addresses.map(address => address.family === 6 ? `[${address.address}]` : address.address).join(',');
  // Literal addresses already select the checked destination. In particular,
  // curl cannot parse a bracketed IPv6 literal as the host of a --resolve entry.
  const resolveArgs = isIP(hostname) ? [] : ['--resolve', `${url.hostname}:${port}:${pinned}`];
  await requireBoundedCurl();
  // Do not follow redirects: the configured corpus endpoint is the only grant.
  // Pin DNS and bypass environment proxies so the checked address is used.
  const { stdout } = await run('curl', ['--disable', '--fail', '--silent', '--show-error', '--noproxy', '*', '--proto', '=http,https', ...resolveArgs, '--max-time', String(options.timeoutMs / 1000), '--max-filesize', String(options.maxBytes), '--output', destination, '--write-out', '%{http_code}', url.href], { encoding: 'utf8', maxBuffer: 10000, timeout: options.timeoutMs + 5000 });
  if (!/^2\d\d$/.test(stdout.trim())) throw new Error(`Paper server returned HTTP ${stdout.trim()}; redirects are not allowed. Configure a direct corpus URL.`);
  if ((await stat(destination)).size > options.maxBytes) throw new Error('Paper response exceeded the download byte limit');
}
