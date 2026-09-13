import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import https from 'node:https';
import http from 'node:http';

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)));
  }
  // Restrict IPv6 to global unicast, excluding documentation and mapped addresses.
  const ip = address.toLowerCase();
  return isIP(ip) === 6 && /^[23][0-9a-f]{3}:/.test(ip) && !ip.startsWith('2001:db8:') && !ip.startsWith('2001:0:') && !ip.startsWith('2002:');
}

export async function webFetch(rawUrl: string): Promise<{ url: string; text: string; truncated: boolean; fetchedAt: string }> {
  const deadline = Date.now() + 15000;
  let url = new URL(rawUrl);
  for (let redirects = 0; redirects <= 4; redirects++) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw new Error('Only public HTTP/HTTPS URLs on standard ports are allowed');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Fetch timed out');
    const addresses = await Promise.race([lookup(hostname, { all: true }), new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('DNS lookup timed out')), remaining); timer.unref(); })]);
    if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw new Error('Local and private network destinations are not allowed');
    const address = addresses[0];
    const response = await new Promise<{ status: number; location?: string; contentType: string; body: string; truncated: boolean }>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).get(url, {
        headers: { 'User-Agent': 'Mindspace/0.1 public research fetch', Accept: 'text/html, text/plain, application/json, application/xml', 'Accept-Encoding': 'identity' },
        // Pin the validated DNS result for the connection, including on redirects.
        lookup: ((_host: string, opts: { all?: boolean }, callback: Function) => opts.all ? callback(null, [address]) : callback(null, address.address, address.family)) as any,
      }, res => {
        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status)) { res.resume(); resolve({ status, location: res.headers.location, contentType: '', body: '', truncated: false }); return; }
        const contentType = String(res.headers['content-type'] || '');
        if (!/(text\/|json|xml)/i.test(contentType)) { res.destroy(); reject(new Error('Only text, HTML, JSON, and XML pages are supported')); return; }
        let size = 0; const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1_000_000) { res.destroy(); reject(new Error('Page exceeds the 1 MB fetch limit')); return; }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status, contentType, body: Buffer.concat(chunks).toString('utf8'), truncated: false }));
        res.on('error', reject);
      });
      const timer = setTimeout(() => request.destroy(new Error('Fetch timed out')), Math.max(1, deadline - Date.now()));
      request.on('close', () => clearTimeout(timer)); request.on('error', reject);
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.location || redirects === 4) throw new Error('Too many redirects or missing redirect location');
      url = new URL(response.location, url); continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`Page returned HTTP ${response.status}`);
    let text = response.body;
    if (/html/i.test(response.contentType)) text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ').trim();
    return { url: url.href, text: text.slice(0, 24000), truncated: text.length > 24000, fetchedAt: new Date().toISOString() };
  }
  throw new Error('Fetch failed');
}
