// A fake API for UI tests: route handlers return [status, body]. Records every call.
export type Call = { method: string; path: string; query: URLSearchParams; body: unknown; auth: string | null };
export type Handler = (c: Call) => [number, unknown] | Promise<[number, unknown]>;

export function fakeServer(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v1/, '');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = { method: init?.method ?? 'GET', path, query: url.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.Authorization ?? null };
    calls.push(call);
    const h = routes[`${call.method} ${path}`];
    const [status, body] = h ? await h(call) : [404, { error: { code: 'NOT_FOUND', message: 'No route' } }];
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, calls, routes };
}

export const err = (status: number, code: string, message = code, details?: unknown): [number, unknown] => [status, { error: { code, message, ...(details === undefined ? {} : { details }) } }];
