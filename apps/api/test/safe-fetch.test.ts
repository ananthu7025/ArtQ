// Task 1.11 ✅ fetcher refuses http://169.254.169.254, localhost, redirect-to-private, > 20 MB.
import http, { type RequestOptions } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isPublicAddress, normaliseSourceUrl, safeFetch, SafeFetchError } from '../src/lib/safe-fetch.js';

// A local HTTP server stands in for the remote host. `connect` receives the vetted IP (pinning is asserted) and is then
// routed to the local server; URLs, DNS answers and redirects go through the real validation.
let server: http.Server, port: number;
const routes: Record<string, (res: http.ServerResponse) => void> = {};
beforeAll(async () => {
  server = http.createServer((req, res) => { (routes[req.url ?? ''] ?? ((r) => { r.statusCode = 404; r.end(); }))(res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => { server.close(); });

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const PUBLIC_IP = '93.184.215.14';
const dnsTable: Record<string, string[]> = {
  'images.example.com': [PUBLIC_IP],
  'cdn.example.com': ['93.184.215.15'],
  'rebind.example.com': [PUBLIC_IP, '127.0.0.1'],
  'metadata.example.com': ['169.254.169.254'],
  'ipv6-private.example.com': ['fd00::1'],
  'mapped.example.com': ['::ffff:10.0.0.5'],
};
const connected: RequestOptions[] = [];
const opts = { resolve: async (h: string) => { if (!dnsTable[h]) throw new Error('ENOTFOUND'); return dnsTable[h]; },
  connect: (ro: RequestOptions) => { connected.push(ro); return http.request({ ...ro, host: '127.0.0.1', port }); } };
const fails = async (url: string, code: string, extra: object = {}) => {
  const e = await safeFetch(url, { ...opts, ...extra }).then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(SafeFetchError);
  expect((e as SafeFetchError).code).toBe(code);
  return e as SafeFetchError;
};

describe('isPublicAddress', () => {
  it.each([
    ['93.184.215.14', true], ['8.8.8.8', true], ['2606:4700:4700::1111', true],
    ['169.254.169.254', false], ['127.0.0.1', false], ['10.1.2.3', false], ['172.16.0.1', false], ['172.31.255.255', false],
    ['192.168.1.1', false], ['100.64.0.1', false], ['0.0.0.0', false], ['224.0.0.1', false], ['255.255.255.255', false],
    ['198.18.0.1', false], ['192.0.2.1', false], ['203.0.113.9', false],
    ['::1', false], ['::', false], ['fd00::1', false], ['fe80::1', false], ['ff02::1', false],
    ['::ffff:127.0.0.1', false], ['::ffff:10.0.0.5', false], ['::ffff:93.184.215.14', true], ['::ffff:7f00:1', false],
    ['64:ff9b::7f00:1', false], ['2002:7f00:1::', false], ['2001::1', false], ['2001:db8::1', false],
    ['not-an-ip', false], ['', false],
  ])('%s → %s', (ip, ok) => { expect(isPublicAddress(ip)).toBe(ok); });
});

describe('normaliseSourceUrl', () => {
  it.each([
    ['https://drive.google.com/file/d/1AbCdEfGhIjK_lmn-op/view?usp=sharing', 'https://drive.google.com/uc?export=download&id=1AbCdEfGhIjK_lmn-op'],
    ['https://drive.google.com/open?id=1AbCdEfGhIjK_lmn', 'https://drive.google.com/uc?export=download&id=1AbCdEfGhIjK_lmn'],
    ['https://evil.example/file/d/1AbCdEfGhIjK_lmn/view', 'https://evil.example/file/d/1AbCdEfGhIjK_lmn/view'],
    ['  https://images.example.com/a.png  ', 'https://images.example.com/a.png'],
  ])('%s', (input, out) => { expect(normaliseSourceUrl(input)).toBe(out); });
  it('rejects garbage', () => { expect(() => normaliseSourceUrl('not a url')).toThrow(SafeFetchError); });
});

describe('safeFetch', () => {
  it('fetches an image from a public host, connecting to the vetted IP with SNI for the hostname', async () => {
    routes['/a.png'] = (res) => { res.setHeader('content-type', 'image/png'); res.end(PNG); };
    connected.length = 0;
    const r = await safeFetch('https://images.example.com/a.png', opts);
    expect(r).toEqual({ body: PNG, contentType: 'image/png', finalUrl: 'https://images.example.com/a.png' });
    expect(connected[0]).toMatchObject({ host: PUBLIC_IP, port: 443, servername: 'images.example.com', path: '/a.png', headers: { host: 'images.example.com' } });
  });

  it.each([
    ['http://169.254.169.254/latest/meta-data/', 'BAD_URL'],                      // plain http
    ['https://169.254.169.254/latest/meta-data/', 'BLOCKED_ADDRESS'],             // metadata IP literal
    ['https://metadata.example.com/', 'BLOCKED_ADDRESS'],                          // hostname resolving to metadata
    ['https://localhost/a.png', 'DNS_FAILED'],                                     // not in the fake DNS…
    ['https://127.0.0.1/a.png', 'BLOCKED_ADDRESS'],
    ['https://[::1]/a.png', 'BLOCKED_ADDRESS'],
    ['https://ipv6-private.example.com/a.png', 'BLOCKED_ADDRESS'],
    ['https://mapped.example.com/a.png', 'BLOCKED_ADDRESS'],
    ['https://rebind.example.com/a.png', 'BLOCKED_ADDRESS'],                       // any private answer poisons the host
    ['https://images.example.com:8443/a.png', 'BAD_URL'],
    ['https://user:pw@images.example.com/a.png', 'BAD_URL'],
    ['ftp://images.example.com/a.png', 'BAD_URL'],
    ['file:///etc/passwd', 'BAD_URL'],
  ])('refuses %s (%s) without connecting', async (url, code) => {
    connected.length = 0;
    await fails(url, code);
    expect(connected).toEqual([]);
  });

  it('localhost is refused with the real system resolver too', async () => {
    const e = await safeFetch('https://localhost/a.png', { connect: opts.connect }).then(() => null, (x: unknown) => x);
    expect((e as SafeFetchError).code).toBe('BLOCKED_ADDRESS');
  });

  it('follows up to 3 redirects, re-validating every hop; a redirect to a private address is refused', async () => {
    routes['/r1'] = (res) => { res.statusCode = 302; res.setHeader('location', 'https://cdn.example.com/r2'); res.end(); };
    routes['/r2'] = (res) => { res.statusCode = 301; res.setHeader('location', '/a.png'); res.end(); };
    connected.length = 0;
    expect((await safeFetch('https://images.example.com/r1', opts)).finalUrl).toBe('https://cdn.example.com/a.png');
    expect(connected.map((c) => c.host)).toEqual([PUBLIC_IP, '93.184.215.15', '93.184.215.15']);

    routes['/to-metadata'] = (res) => { res.statusCode = 302; res.setHeader('location', 'https://169.254.169.254/latest/meta-data/'); res.end(); };
    routes['/to-internal-host'] = (res) => { res.statusCode = 307; res.setHeader('location', 'https://metadata.example.com/x'); res.end(); };
    routes['/to-http'] = (res) => { res.statusCode = 302; res.setHeader('location', 'http://images.example.com/a.png'); res.end(); };
    await fails('https://images.example.com/to-metadata', 'BLOCKED_ADDRESS');
    await fails('https://images.example.com/to-internal-host', 'BLOCKED_ADDRESS');
    await fails('https://images.example.com/to-http', 'BAD_URL');

    routes['/loop'] = (res) => { res.statusCode = 302; res.setHeader('location', '/loop'); res.end(); };
    connected.length = 0;
    await fails('https://images.example.com/loop', 'TOO_MANY_REDIRECTS');
    expect(connected).toHaveLength(4);                                    // the original + 3 redirects
  });

  it('refuses bodies over 20 MB, by Content-Length or while streaming without one', async () => {
    routes['/big-declared'] = (res) => { res.setHeader('content-type', 'image/jpeg'); res.setHeader('content-length', String(21 * 1024 * 1024)); res.end(); };
    await fails('https://images.example.com/big-declared', 'TOO_LARGE');
    routes['/big-streamed'] = (res) => {
      res.setHeader('content-type', 'image/jpeg');
      const chunk = Buffer.alloc(1024 * 1024);
      let sent = 0;
      const pump = () => { while (sent < 25) { sent++; if (!res.write(chunk)) { res.once('drain', pump); return; } } res.end(); };
      pump();
    };
    const e = await fails('https://images.example.com/big-streamed', 'TOO_LARGE');
    expect(e.message).toContain(String(20 * 1024 * 1024));
    routes['/exactly-limit'] = (res) => { res.setHeader('content-type', 'image/png'); res.end(Buffer.alloc(1024)); };
    expect((await safeFetch('https://images.example.com/exactly-limit', { ...opts, maxBytes: 1024 })).body).toHaveLength(1024);
  });

  it('non-image content, error statuses and slow servers fail', async () => {
    routes['/page'] = (res) => { res.setHeader('content-type', 'text/html'); res.end('<html>'); };
    routes['/missing'] = (res) => { res.statusCode = 404; res.end(); };
    routes['/slow'] = (res) => { res.setHeader('content-type', 'image/png'); res.write(PNG); setTimeout(() => res.end(), 2000); };
    await fails('https://images.example.com/page', 'NOT_IMAGE');
    await fails('https://images.example.com/missing', 'BAD_STATUS');
    await fails('https://images.example.com/slow', 'TIMEOUT', { totalTimeoutMs: 300 });
  });
});
