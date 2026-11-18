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
// Every reply carries a non-empty X-GitHub-Request-Id. A handler that
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

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Whether the request carries the entry's bearer token. When no token is
 * configured (a local run without MAKEFUN_SHOP_TOKEN), any non-empty bearer
 * token is accepted; a missing header is never accepted. */
function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  if (presented === '') return false;
  if (token === '') return true;
  return presented === token;
}

function send(res: ServerResponse, store: Store, result: HttpResult): void {
  const headers: Record<string, string> = {
    'content-type': result.contentType,
    'content-length': String(result.body.length),
    'x-github-request-id': store.requestId(),
    ...(result.headers ?? {}),
  };
  try {
    res.writeHead(result.status, headers);
    res.end(result.body);
  } catch {
    // The peer went away; nothing to write to.
  }
}

/** Parse a request body as JSON when it is non-empty; null when it is empty.
 * Throws on malformed JSON. */
function parseJsonBody(body: Buffer): unknown {
  const text = body.toString('utf8');
  if (text.trim() === '') return null;
  return JSON.parse(text) as unknown;
}

export function createApp(store: Store, token: string): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        const path = pathOf(req);
        const query = queryOf(req);
        const baseUrl = `http://${req.headers.host ?? '127.0.0.1'}`;

        // The env's boot probe: 200 {"ok":true}, no auth.
        if (method === 'GET' && path === '/healthz') {
          send(res, store, jsonResult(200, { ok: true }));
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const tail = path === '/api/v3' ? '' : path.slice('/api/v3/'.length);
          const segments = tail === '' ? [] : tail.split('/').map(decodeSegment);
          let body: unknown = null;
          let bodyError = false;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            try {
              body = parseJsonBody(await readBody(req));
            } catch {
              bodyError = true;
            }
          }
          if (bodyError) {
            send(res, store, jsonResult(400, { message: 'request body is not valid JSON' }));
            return;
          }
          send(
            res,
            store,
            handleRest({ store, token, baseUrl, method, segments, query, body, authorized: isAuthorized(req, token) }),
          );
          return;
        }

        // GraphQL v4.
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            send(res, store, jsonResult(405, { message: 'method not allowed' }));
            return;
          }
          if (!isAuthorized(req, token)) {
            send(res, store, unauthorized('Requires authentication'));
            return;
          }
          let body: unknown;
          try {
            body = parseJsonBody(await readBody(req));
          } catch {
            send(res, store, jsonResult(400, { message: 'request body is not valid JSON' }));
            return;
          }
          send(res, store, handleGraphql(store, body));
          return;
        }

        // MCP.
        if (path === '/mcp') {
          if (method === 'DELETE') {
            send(res, store, { status: 204, contentType: 'application/json; charset=utf-8', body: Buffer.alloc(0) });
            return;
          }
          if (method !== 'POST') {
            send(res, store, jsonResult(405, { message: 'method not allowed' }));
            return;
          }
          const text = (await readBody(req, 1 << 20)).toString('utf8');
          send(res, store, handleMcp(store, text, isAuthorized(req, token)));
          return;
        }

        // git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
        if (gitMatch !== null) {
          const owner = decodeSegment(gitMatch[1]!);
          const repoName = decodeSegment(gitMatch[2]!);
          const service = gitMatch[3]!;
          const gitProtocol = req.headers['git-protocol'];
          if (method === 'GET' && service === 'info/refs') {
            const serviceParam = query.get('service') ?? '';
            send(res, store, handleInfoRefs(store, owner, repoName, serviceParam, gitProtocol));
            return;
          }
          if (method === 'POST' && service === 'git-upload-pack') {
            const body = await readBody(req, 64 << 20);
            send(res, store, handleUploadPack(store, owner, repoName, body, gitProtocol));
            return;
          }
          if (method === 'POST' && service === 'git-receive-pack') {
            const body = await readBody(req, 64 << 20);
            send(res, store, handleReceivePack(store, owner, repoName, body));
            return;
          }
          send(res, store, notFound());
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
