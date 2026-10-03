// One cache decision for every response (architecture.md §6.1), made when the headers are written so no route can
// forget it: an allow-listed public GET that succeeds (200/304) is publicly cacheable for 60 s, without cookies; every
// other response (errors, personal routes, writes, health, preflights) is `private, no-store`. On allow-listed routes
// the request's cookies and Authorization are removed before any handler runs, so a cached body cannot depend on them.
import { isPublicCacheable, NO_STORE, PUBLIC_CACHE_CONTROL } from '@artq/shared';
import type { RequestHandler } from 'express';

export function cachePolicy(): RequestHandler {
  return (req, res, next) => {
    const isPublic = (req.method === 'GET' || req.method === 'HEAD') && /^\/v1\//i.test(req.path) && isPublicCacheable(req.path.slice(3));
    if (isPublic) { delete req.headers.cookie; delete req.headers.authorization; }
    const writeHead = res.writeHead;
    res.writeHead = function (this: typeof res, ...args: Parameters<typeof res.writeHead>) {
      const status = typeof args[0] === 'number' ? args[0] : res.statusCode;
      if (isPublic && (status === 200 || status === 304)) {
        res.setHeader('Cache-Control', PUBLIC_CACHE_CONTROL);
        res.removeHeader('Set-Cookie');
        const vary = String(res.getHeader('Vary') ?? '');
        if (!/accept-encoding/i.test(vary)) res.setHeader('Vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding');
      } else {
        res.setHeader('Cache-Control', NO_STORE);
      }
      return writeHead.apply(this, args);
    } as typeof res.writeHead;
    next();
  };
}
