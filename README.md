# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/weareracingboy12-cloud/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/weareracingboy12-cloud/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node 22 process, standard library only —
no dependencies, no install step, no git binary.

One server speaks all four surfaces the make.fun suite drives:

- **git smart HTTP** at `/{owner}/{repo}.git` — `info/refs`, `git-upload-pack`
  (protocol v2 with a v0 fallback) and `git-receive-pack` (v0, report-status,
  side-band-64k, delete-refs). Fast-forward only; a non-fast-forward update is
  refused per ref with `ng <ref> non-fast-forward`. Packs are written plain
  (no deltas); incoming packs are read with OFS/REF delta resolution.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents
  (base64 files and directory listings), labels, issues and comments, pull
  requests with files and squash merges. JSON always, `X-GitHub-Request-Id`
  on every reply, Bearer token auth (401 without it), 404 never 403 for
  another owner's repository.
- **GraphQL v4** at `/api/graphql` — `viewer`, `repository` (with `issue`,
  `issues`, `pullRequest`, `pullRequests`), `node(id:)`, `__type`
  introspection, and the `createIssue`, `closeIssue`, `createPullRequest`,
  `mergePullRequest` and `addComment` mutations, including batched operation
  documents in one body. Global ids are opaque and stable across reads.
- **MCP** at `/mcp` — JSON-RPC 2.0 Streamable HTTP, revision 2026-07-28
  (`server/discover`) with the legacy `initialize` handshake as a fallback,
  and six tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`) acting on the same store as
  REST.

## Running

```
node main.ts
```

The process binds an ephemeral port, registers it with the env at
`$MAKEFUN_ENV_URL/register`, then polls `$MAKEFUN_ENV_URL/done` until the
trial is over and exits 0. `MAKEFUN_SHOP_TOKEN` is the bearer token the
entry accepts.

## Layout

- `main.ts` — the entry lifecycle: bind, register, wait for done, exit.
- `app.ts` — the HTTP server and route dispatch.
- `store.ts` — the in-memory store: repositories, git objects and refs,
  issues, pull requests, labels, and the deterministic clock and counters.
- `gitobj.ts` — SHA-1 object ids, commit/tree parsing and building,
  pack reading and writing, pkt-line framing.
- `githttp.ts` — the smart-HTTP handlers (advertisements, ls-refs, fetch,
  receive-pack).
- `rest.ts` — the REST v3 handlers.
- `graphql.ts` — a small GraphQL document parser and executor.
- `mcp.ts` — the MCP JSON-RPC handlers and tools.

## Determinism

The forge keeps no wall-clock time and draws no randomness: timestamps and
request ids come from monotonic counters seeded at a fixed epoch, so a
replayed trial reaches the same state.
