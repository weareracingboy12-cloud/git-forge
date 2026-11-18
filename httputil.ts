// Plumbing every surface shares: one reply shape, small JSON replies,
// and reading a whole request body. The server stamps
// X-GitHub-Request-Id on each reply before it leaves.

import type { IncomingMessage } from 'node:http';

export interface Reply {
  status: number;
  contentType: string;
  body: Buffer;
  headers?: Record<string, string>;
}

/** The usual 404 JSON reply. */
export function replyNotFound(message = 'Not Found'): Reply {
  return jsonReply(404, { message });
}

/** The usual 401 JSON reply. */
export function replyUnauthorized(message = 'Unauthorized'): Reply {
  return jsonReply(401, { message });
}

/** A JSON reply: the value stringified, with one trailing newline. */
export function jsonReply(status: number, value: unknown, extra: Record<string, string> = {}): Reply {
  const text = JSON.stringify(value);
  return {
    status,
    contentType: 'application/json; charset=utf-8',
    body: Buffer.from(text + '\n', 'utf8'),
    headers: extra,
  };
}

/** Read a request body in full, refusing anything past `limit`
 * (one mebibyte by default). */
export function readRequestBody(req: IncomingMessage, limit = 1 << 20): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const pieces: Buffer[] = [];
    let seen = 0;
    req.on('data', (chunk: Buffer) => {
      seen += chunk.length;
      if (seen > limit) {
        reject(new Error('request body too large'));
        return;
      }
      pieces.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(pieces)));
    req.on('error', reject);
  });
}
