// SSRF-safe image fetcher (architecture.md §9.3), used only by the worker (catalogue import images).
//  - https only, port 443, no credentials in the URL
//  - every DNS answer is checked against private / loopback / link-local / CGNAT / reserved / multicast / metadata ranges
//    (IPv4 and IPv6, incl. IPv4-mapped, NAT64, 6to4 and Teredo) and the connection is made to the vetted IP itself
//    (TLS still verifies the original hostname), so DNS rebinding cannot swap the address
//  - at most 3 redirects, each hop re-validated; 5 s connect / 30 s total; 20 MB streaming cap; Content-Type image/*
import dns from 'node:dns/promises';
import type { ClientRequest, IncomingMessage } from 'node:http';
import https, { type RequestOptions } from 'node:https';
import net from 'node:net';

export const SAFE_FETCH_DEFAULTS = { maxBytes: 20 * 1024 * 1024, maxRedirects: 3, connectTimeoutMs: 5000, totalTimeoutMs: 30_000 } as const;

export type SafeFetchErrorCode = 'BAD_URL' | 'BLOCKED_ADDRESS' | 'DNS_FAILED' | 'TOO_MANY_REDIRECTS' | 'BAD_STATUS' | 'NOT_IMAGE' | 'TOO_LARGE' | 'TIMEOUT' | 'NETWORK';
export class SafeFetchError extends Error {
  constructor(readonly code: SafeFetchErrorCode, message: string) { super(`${code}: ${message}`); this.name = 'SafeFetchError'; }
}

const blocked = new net.BlockList();
for (const [net4, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net4, prefix, 'ipv4');
for (const [net6, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(net6, prefix, 'ipv6');

/** True only for globally routable unicast addresses. */
export function isPublicAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 0) return false;
  if (family === 4) return !blocked.check(ip, 'ipv4');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isPublicAddress(mapped[1]!);
  if (/^::ffff:/i.test(ip) || /^::(\d+\.){3}\d+$/.test(ip)) return false;           // hex-form mapped / deprecated compatible
  return !blocked.check(ip, 'ipv6');
}

/** Google Drive share links → direct download (only for drive.google.com). */
export function normaliseSourceUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new SafeFetchError('BAD_URL', 'not a URL'); }
  if (u.hostname === 'drive.google.com') {
    const id = /^\/file\/d\/([\w-]{10,})/.exec(u.pathname)?.[1] ?? (u.pathname === '/open' ? u.searchParams.get('id') : null);
    if (id && /^[\w-]+$/.test(id)) return `https://drive.google.com/uc?export=download&id=${id}`;
  }
  return u.toString();
}

function checkUrl(u: URL) {
  if (u.protocol !== 'https:') throw new SafeFetchError('BAD_URL', `only https is allowed (${u.protocol})`);
  if (u.username || u.password) throw new SafeFetchError('BAD_URL', 'credentials in URL are not allowed');
  if (u.port && u.port !== '443') throw new SafeFetchError('BAD_URL', `port ${u.port} is not allowed`);
  if (!u.hostname) throw new SafeFetchError('BAD_URL', 'missing host');
}

export type SafeFetchOptions = Partial<typeof SAFE_FETCH_DEFAULTS> & {
  /** DNS resolver returning every address for a host. */
  resolve?: (host: string) => Promise<string[]>;
  /** Opens the connection. Receives `host` = the vetted IP. Tests replace it; production uses https.request. */
  connect?: (opts: RequestOptions) => ClientRequest;
};

export type SafeFetchResult = { body: Buffer; contentType: string; finalUrl: string };

const defaultResolve = async (host: string) => (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address);

export async function safeFetch(rawUrl: string, o: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const opt = { ...SAFE_FETCH_DEFAULTS, ...o };
  const resolve = o.resolve ?? defaultResolve;
  const connect = o.connect ?? ((ro: RequestOptions) => https.request(ro));
  const deadline = Date.now() + opt.totalTimeoutMs;
  let url = new URL(normaliseSourceUrl(rawUrl));

  for (let hop = 0; ; hop++) {
    checkUrl(url);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let addresses: string[];
    if (net.isIP(host)) addresses = [host];
    else {
      try { addresses = await resolve(host); } catch (e) { throw new SafeFetchError('DNS_FAILED', `${host}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    if (addresses.length === 0) throw new SafeFetchError('DNS_FAILED', `${host}: no addresses`);
    const bad = addresses.find((a) => !isPublicAddress(a));
    if (bad) throw new SafeFetchError('BLOCKED_ADDRESS', `${host} resolves to ${bad}`);

    const res = await request(connect, {
      host: addresses[0]!, port: 443, method: 'GET', path: `${url.pathname}${url.search}`,
      ...(net.isIP(host) ? {} : { servername: host }),
      headers: { host: url.host, 'user-agent': 'ArtQ-Importer/1.0', accept: 'image/*' },
    }, opt.connectTimeoutMs, deadline);

    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      if (hop >= opt.maxRedirects) throw new SafeFetchError('TOO_MANY_REDIRECTS', `more than ${opt.maxRedirects} redirects`);
      url = new URL(res.headers.location, url);
      continue;
    }
    if (res.statusCode !== 200) { res.resume(); throw new SafeFetchError('BAD_STATUS', `HTTP ${res.statusCode}`); }
    const contentType = String(res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (!contentType.startsWith('image/')) { res.resume(); throw new SafeFetchError('NOT_IMAGE', `content-type ${contentType || '(none)'}`); }
    const declared = Number(res.headers['content-length']);
    if (Number.isFinite(declared) && declared > opt.maxBytes) { res.destroy(); throw new SafeFetchError('TOO_LARGE', `${declared} bytes declared`); }
    const body = await readCapped(res, opt.maxBytes, deadline);
    return { body, contentType, finalUrl: url.toString() };
  }
}

function request(connect: (o: RequestOptions) => ClientRequest, ro: RequestOptions, connectTimeoutMs: number, deadline: number): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = connect(ro);
    const fail = (e: SafeFetchError) => { req.destroy(); reject(e); };
    const total = setTimeout(() => fail(new SafeFetchError('TIMEOUT', 'total time exceeded')), Math.max(0, deadline - Date.now()));
    const conn = setTimeout(() => fail(new SafeFetchError('TIMEOUT', 'connect timed out')), connectTimeoutMs);
    req.on('socket', (s) => { if (!s.connecting) clearTimeout(conn); else s.once('connect', () => clearTimeout(conn)); });
    req.on('response', (res) => { clearTimeout(conn); clearTimeout(total); resolve(res); });
    req.on('error', (e) => { clearTimeout(conn); clearTimeout(total); reject(e instanceof SafeFetchError ? e : new SafeFetchError('NETWORK', e.message)); });
    req.end();
  });
}

function readCapped(res: IncomingMessage, max: number, deadline: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => { res.destroy(); reject(new SafeFetchError('TIMEOUT', 'total time exceeded')); }, Math.max(0, deadline - Date.now()));
    res.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) { clearTimeout(timer); res.destroy(); reject(new SafeFetchError('TOO_LARGE', `more than ${max} bytes`)); return; }
      chunks.push(c);
    });
    res.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    res.on('error', (e) => { clearTimeout(timer); reject(new SafeFetchError('NETWORK', e.message)); });
  });
}
