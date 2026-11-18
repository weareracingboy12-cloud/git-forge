// The HTTP server: one listener, four surfaces. Routing is by path:
//
//   GET  /healthz                                  the env's boot probe
//   /api/v3/...                                    REST v3 (rest.ts)
//   POST /api/graphql                             GraphQL v4 (graphql.ts)
//   /mcp                                          MCP JSON-RPC (mcp.ts)
//   /{owner}/{repo}.git/info/refs                 git advertisements
//   /{owner}/{repo}.git/git-upload-pack           git fetch / ls-refs
//   /{owner}/{repo}.git/git-receive-pack          git push
//   anything else                                 JSON 404
//
// Every send carries a non-empty X-GitHub-Request-Id. A handler that
// throws answers 500 instead of taking the server down: one bad request
// must never end the trial.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './githttp.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { jsonResult, notFound, readBody, unauthorized, type HttpResult } from './httputil.ts';

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** Whether the request carries the entry's bearer token. With no token
 * configured (a local run without MAKEFUN_SHOP_TOKEN), any non-empty
 * bearer token is accepted; a missing header is never accepted. */
function authed(req: IncomingMessage, expected: string): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  if (presented === '') return false;
  if (expected === '') return true;
  return presented === expected;
}

function send(res: ServerResponse, store: Store, answer: HttpResult): void {
  const headers: Record<string, string> = {
    'content-type': answer.contentType,
    'content-length': String(answer.body.length),
    'x-github-request-id': store.requestId(),
    ...(answer.headers ?? {}),
  };
  try {
    res.writeHead(answer.status, headers);
    res.end(answer.body);
  } catch {
    // The peer went away; nothing to write to.
  }
}

/** Parse a request payload as JSON when it is non-empty; null when it is
 * empty. Throws on malformed JSON. */
function jsonBody(raw: Buffer): unknown {
  const rawText = raw.toString('utf8');
  if (rawText.trim() === '') return null;
  return JSON.parse(rawText) as unknown;
}

export function createApp(store: Store, token: string): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        const route = pathOf(req);
        const params = queryOf(req);
        const origin = `http://${req.headers.host ?? '127.0.0.1'}`;

        // The env's boot probe: 200 {"ok":true}, no auth.
        if (method === 'GET' && route === '/healthz') {
          send(res, store, jsonResult(200, { ok: true }));
          return;
        }

        // REST v3.
        if (route === '/api/v3' || route.startsWith('/api/v3/')) {
          const tail = route === '/api/v3' ? '' : route.slice('/api/v3/'.length);
          const segments = tail === '' ? [] : tail.split('/').map(decode);
          let payload: unknown = null;
          let malformed = false;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            try {
              payload = jsonBody(await readBody(req));
            } catch {
              malformed = true;
            }
          }
          if (malformed) {
            send(res, store, jsonResult(400, { message: 'request body is not valid JSON' }));
            return;
          }
          send(
            res,
            store,
            handleRest({
              store,
              token,
              baseUrl: origin,
              method,
              segments,
              query: params,
              body: payload,
              authorized: authed(req, token),
            }),
          );
          return;
        }

        // GraphQL v4.
        if (route === '/api/graphql') {
          if (method !== 'POST') {
            send(res, store, jsonResult(405, { message: 'method not allowed' }));
            return;
          }
          if (!authed(req, token)) {
            send(res, store, unauthorized('Requires authentication'));
            return;
          }
          let payload: unknown;
          try {
            payload = jsonBody(await readBody(req));
          } catch {
            send(res, store, jsonResult(400, { message: 'request body is not valid JSON' }));
            return;
          }
          send(res, store, handleGraphql(store, payload));
          return;
        }

        // git smart HTTP: /{owner}/{repo}.git/...
        const match = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(route);
        if (match !== null) {
          const login = decode(match[1]!);
          const repo = decode(match[2]!);
          const svc = match[3]!;
          const proto = req.headers['git-protocol'];
          if (method === 'GET' && svc === 'info/refs') {
            const wanted = params.get('service') ?? '';
            send(res, store, handleInfoRefs(store, login, repo, wanted, proto));
            return;
          }
          if (method === 'POST' && svc === 'git-upload-pack') {
            const payload = await readBody(req, 64 << 20);
            send(res, store, handleUploadPack(store, login, repo, payload, proto));
            return;
          }
          if (method === 'POST' && svc === 'git-receive-pack') {
            const payload = await readBody(req, 64 << 20);
            send(res, store, handleReceivePack(store, login, repo, payload));
            return;
          }
          send(res, store, notFound());
          return;
        }
        // MCP.
        if (route === '/mcp') {
          if (method === 'DELETE') {
            send(res, store, { status: 204, contentType: 'application/json; charset=utf-8', body: Buffer.alloc(0) });
            return;
          }
          if (method !== 'POST') {
            send(res, store, jsonResult(405, { message: 'method not allowed' }));
            return;
          }
          const rawText = (await readBody(req, 1 << 20)).toString('utf8');
          send(res, store, handleMcp(store, rawText, authed(req, token)));
          return;
        }


        send(res, store, notFound());
      } catch (err) {
        try {
          send(res, store, jsonResult(500, { message: err instanceof Error ? err.message : 'internal error' }));
        } catch {
          // Nothing left to do for this request.
        }
      }
    })();
  });
}
