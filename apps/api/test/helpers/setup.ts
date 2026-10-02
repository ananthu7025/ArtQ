// Vitest setup for every API test file.
//
// supertest serves a request from `server.listen(0)` (wildcard address) and then connects to 127.0.0.1:<port>. On macOS
// a wildcard bind succeeds even when another program already listens on 127.0.0.1 with the same port, and the
// connection then reaches THAT program: local developer tools (IDE language servers, an HTTP proxy) hold many 127.0.0.1
// ports in the ephemeral range. Symptoms were random 400s ("This is an explicit proxy server. Does not respond to
// relative URIs."), "socket hang up" and wrong responses in roughly 1 of 5 compose runs (diagnosed 2026-10-02,
// tasklist 1.8). Linux refuses the overlapping bind, so CI never saw it.
// Fix: reach supertest's wildcard servers over IPv6 loopback, where those IPv4-only listeners cannot answer.
import { createRequire } from 'node:module';
import type { Server } from 'node:http';

const require = createRequire(import.meta.url);
const { Test } = require('supertest') as { Test: { prototype: { serverAddress(app: Server, path: string): string } } };
const serverAddress = Test.prototype.serverAddress;
Test.prototype.serverAddress = function (this: unknown, app: Server, path: string): string {
  const url = serverAddress.call(this, app, path);
  const addr = app.address();
  return addr !== null && typeof addr === 'object' && addr.address === '::' ? url.replace('://127.0.0.1:', '://[::1]:') : url;
};
