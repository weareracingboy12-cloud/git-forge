// Small shared HTTP helpers: the response shape every surface returns, and
// JSON answers. The app adds X-GitHub-Request-Id to every reply centrally.

import type { IncomingMessage } from 'node:http';

export interface HttpResult {
  status: number;
  contentType: string;
  body: Buffer;
  headers?: Record<string, string>;
}

export function jsonResult(status: number, body: unknown, headers: Record<string, string> = {}): HttpResult {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'), headers };
}

export function notFound(message = 'Not Found'): HttpResult {
  return jsonResult(404, { message });
}

export function unauthorized(message = 'Unauthorized'): HttpResult {
  return jsonResult(401, { message });
}

/** Read a request body whole, up to `maxBytes` (1 MiB by default). */
export function readBody(req: IncomingMessage, maxBytes = 1 << 20): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
