// Entrypoint: one process, one store, one port.
//
//   1. Listen on an ephemeral port (never a fixed one: the pod already
//      uses the env's port).
//   2. Register that port with the env: POST {"port": N} to
//      $MAKEFUN_ENV_URL/register, retrying with backoff; a 400 (late or
//      duplicate) is fatal, a 409 (already registered) is fine.
//   3. Long-poll GET $MAKEFUN_ENV_URL/done until the suite says it is
//      finished, then shut the server down and exit 0.
//   4. No env URL at all: exit 1 with a plain message.
//
// A heartbeat thread on the side makes sure the process does not die on
// its own while the suite is still running: any request error is caught
// inside the app, and the server keeps listening until the env says done.

import { createApp } from './app.ts';
import { Store } from './store.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const ENTRY_NAME = 'git-forge';

function fail(message: string): never {
  process.stderr.write(`${ENTRY_NAME}: ${message}\n`);
  process.exit(1);
}

async function postJson(url: string, body: unknown, timeoutMs: number): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { status: res.status, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

async function register(port: number): Promise<void> {
  let delayMs = 250;
  const deadline = Date.now() + 90_000;
  for (;;) {
    let outcome: { status: number; text: string };
    try {
      outcome = await postJson(`${ENV_URL}/register`, { port }, 5_000);
    } catch (err) {
      outcome = { status: 0, text: err instanceof Error ? err.message : String(err) };
    }
    if (outcome.status === 200) return;
    if (outcome.status === 409) return;
    if (outcome.status === 400) fail(`registration refused: ${outcome.text}`);
    if (Date.now() >= deadline) fail(`could not register within 90s: ${outcome.status} ${outcome.text}`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    delayMs = Math.min(delayMs * 2, 2_000);
  }
}

async function waitForDone(): Promise<void> {
  for (;;) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      const res = await fetch(`${ENV_URL}/done`, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        const data = (await res.json()) as { done?: boolean };
        if (data.done === true) return;
      }
    } catch {
      // The env is not answering yet; poll again.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

async function main(): Promise<void> {
  if (ENV_URL === '') fail('MAKEFUN_ENV_URL is not set');
  const store = new Store();
  const server = createApp(store, SHOP_TOKEN);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') fail('could not bind an ephemeral port');
  await register(address.port);
  await waitForDone();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

await main();
