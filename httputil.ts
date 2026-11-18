// Shared HTTP plumbing for every surface: the single response shape the
// handlers return, small JSON answers, and whole-body reading. The app
// itself adds X-GitHub-Request-Id to each reply before it goes out.

import type { IncomingMessage } from 'node:http';

export interface HttpResult {
  status: number;
  contentType: string;
  body: Buffer;
  headers?: Record<string, string>;
}

/** The standard 404 JSON answer. */
export function notFound(message = 'Not Found'): HttpResult {
  return jsonResult(404, { message });
}

/** The standard 401 JSON answer. */
export function unauthorized(message = 'Unauthorized'): HttpResult {
  return jsonResult(401, { message });
}

/** A JSON answer: the payload stringified with one trailing newline. */
export function jsonResult(status: number, body: unknown, headers: Record<string, string> = {}): HttpResult {
  const text = JSON.stringify(body);
  const out: HttpResult = {
    status,
    contentType: 'application/json; charset=utf-8',
    body: Buffer.from(`${text}\n`, 'utf8'),
    headers,
  };
  return out;
}

/** Slurp a request body whole, refusing anything over `maxBytes`
 * (1 MiB unless the caller says otherwise). */
export function readBody(req: IncomingMessage, maxBytes = 1 << 20): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (piece: Buffer) => {
      total += piece.length;
      if (total > maxBytes) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(piece);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
