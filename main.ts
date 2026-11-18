// Entrypoint: a single process holding one store on one ephemeral port.
//
//   1. Listen on port 0 (never a fixed port: the pod already uses the
//      env's port).
//   2. Register the chosen port with the env — POST {"port": N} to
//      $MAKEFUN_ENV_URL/register, with backoff. A 400 (late or duplicate)
//      is fatal; a 409 (already registered) is fine.
//   3. Long-poll GET $MAKEFUN_ENV_URL/done until the suite reports it is
//      finished, then stop the server and exit 0.
//   4. No env URL at all: exit 1 with a plain message.
//
// The app catches request errors internally, so the process stays alive
// for as long as the suite is still running.

import { createApp } from './app.ts';
import { Store } from './store.ts';

const ENV = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const NAME = 'git-forge';

function die(reason: string): never {
  process.stderr.write(`${NAME}: ${reason}\n`);
  process.exit(1);
}

interface PostOutcome {
  status: number;
  text: string;
}

async function postJson(url: string, payload: unknown, timeoutMs: number): Promise<PostOutcome> {
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

async function register(port: number): Promise<void> {
  let waitMs = 250;
  const cutoff = Date.now() + 90_000;
  for (;;) {
    let attempt: PostOutcome;
    try {
      attempt = await postJson(`${ENV}/register`, { port }, 5_000);
    } catch (err) {
      attempt = { status: 0, text: err instanceof Error ? err.message : String(err) };
    }
    if (attempt.status === 200 || attempt.status === 409) return;
    if (attempt.status === 400) die(`registration refused: ${attempt.text}`);
    if (Date.now() >= cutoff) die(`could not register within 90s: ${attempt.status} ${attempt.text}`);
    await new Promise((wake) => setTimeout(wake, waitMs));
    waitMs = Math.min(waitMs * 2, 2_000);
  }
}

async function awaitDone(): Promise<void> {
  for (;;) {
    try {
      const abort = new AbortController();
      const guard = setTimeout(() => abort.abort(), 60_000);
      const reply = await fetch(`${ENV}/done`, { signal: abort.signal });
      clearTimeout(guard);
      if (reply.ok) {
        const payload = (await reply.json()) as { done?: boolean };
        if (payload.done === true) return;
      }
    } catch {
      // The env is not answering yet; poll again.
    }
    await new Promise((wake) => setTimeout(wake, 1_000));
  }
}

async function boot(): Promise<void> {
  if (ENV === '') die('MAKEFUN_ENV_URL is not set');
  const store = new Store();
  const server = createApp(store, TOKEN);
  await new Promise<void>((ready) => {
    server.listen(0, '127.0.0.1', () => ready());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') die('could not bind an ephemeral port');
  await register(bound.port);
  await awaitDone();
  await new Promise<void>((closed) => {
    server.close(() => closed());
  });
}

await boot();
