// Entrypoint: one process, one store, one ephemeral port.
//
//   1. Listen on port 0 — never a fixed port, the pod already uses the
//      env's port.
//   2. Register that port with the env: POST {"port": N} to
//      $MAKEFUN_ENV_URL/register, with backoff. A 400 (late or
//      duplicate) is fatal; a 409 (already registered) is fine.
//   3. Long-poll GET $MAKEFUN_ENV_URL/done until the suite says it is
//      finished, then stop the server and exit 0.
//   4. No env URL at all: exit 1 with a plain message.
//
// Handlers catch request errors internally, so the process stays up as
// long as the suite is still running.

import { buildServer } from './app.ts';
import { Store } from './store.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const PROGRAM = 'git-forge';

function fatal(reason: string): never {
  process.stderr.write(`${PROGRAM}: ${reason}\n`);
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((wake) => setTimeout(wake, ms));
}

interface PostResult {
  status: number;
  text: string;
}

async function postJsonBody(url: string, payload: unknown, timeoutMs: number): Promise<PostResult> {
  const abort = new AbortController();
  const guard = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const reply = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: abort.signal,
    });
    return { status: reply.status, text: await reply.text() };
  } finally {
    clearTimeout(guard);
  }
}

async function registerPort(port: number): Promise<void> {
  let delayMs = 250;
  const deadline = Date.now() + 90_000;
  for (;;) {
    let attempt: PostResult;
    try {
      attempt = await postJsonBody(`${ENV_URL}/register`, { port }, 5_000);
    } catch (err) {
      attempt = { status: 0, text: err instanceof Error ? err.message : String(err) };
    }
    if (attempt.status === 200 || attempt.status === 409) return;
    if (attempt.status === 400) fatal(`registration refused: ${attempt.text}`);
    if (Date.now() >= deadline) fatal(`could not register within 90s: ${attempt.status} ${attempt.text}`);
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, 2_000);
  }
}

async function waitUntilDone(): Promise<void> {
  for (;;) {
    try {
      const abort = new AbortController();
      const guard = setTimeout(() => abort.abort(), 60_000);
      const reply = await fetch(`${ENV_URL}/done`, { signal: abort.signal });
      clearTimeout(guard);
      if (reply.ok) {
        const payload = (await reply.json()) as { done?: boolean };
        if (payload.done === true) return;
      }
    } catch {
      // The env is not answering yet; poll again.
    }
    await sleep(1_000);
  }
}

async function start(): Promise<void> {
  if (ENV_URL === '') fatal('MAKEFUN_ENV_URL is not set');
  const store = new Store();
  const server = buildServer(store, SHOP_TOKEN);
  await new Promise<void>((ready) => {
    server.listen(0, '127.0.0.1', () => ready());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') fatal('could not bind an ephemeral port');
  await registerPort(bound.port);
  await waitUntilDone();
  await new Promise<void>((closed) => {
    server.close(() => closed());
  });
}

await start();
