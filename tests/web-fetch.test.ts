import assert from 'node:assert/strict';
import test from 'node:test';
import { isPublicAddress, webFetch } from '../src/server/web-fetch.js';

test('public-page fetch rejects local, private, link-local, shared and IPv6 mapped destinations', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '100.127.255.255', '198.18.0.1', '224.0.0.1', '255.255.255.255', '::1', '::', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1', 'fd12::1', '2001:db8::1', '2002:7f00:1::', 'not-an-ip']) {
    assert.equal(isPublicAddress(address), false, `${address} must never reach local or private services`);
  }
  for (const address of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '192.169.0.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isPublicAddress(address), true, `${address} should remain reachable as a public address`);
  }
});

test('unsafe URL schemes, credentials and service ports are rejected before opening a connection', async () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com/', 'https://user:password@example.com/', 'http://127.0.0.1:8787/api/sessions', 'http://example.com:8080/']) {
    await assert.rejects(webFetch(url), /Only public HTTP\/HTTPS URLs on standard ports are allowed/);
  }
});
