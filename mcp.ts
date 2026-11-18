// MCP at /mcp: JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28.
//
//   `server/discover` answers the server's identity, capabilities and
//   supportedVersions in one msg (the modern era, no handshake, no
//   session); `initialize` + `notifications/initialized` is answered too,
//   for a client that predates discover. Every answer is one plain JSON
//   body (never an SSE stream). A body that is not JSON is HTTP 400 with
//   JSON-RPC -32700. An unknown def is -32602, never HTTP 500. A def
//   call without its required arguments is a def result with isError:
//   true. No Authorization header is HTTP 401. The six tools act on the
//   same store as REST, so a repository or issue made over MCP reads back
//   over REST with the same ids.

import { Store, VIEWER_LOGIN } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import { jsonResult, type HttpResult } from './httputil.ts';

const NAME = 'git-forge';
const VERSION = '1.0.0';

const VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const OLD_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/** The six tools, in a fixed order: tools/list is byte-identical every
 * time. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The repository name.' }, description: { type: 'string', description: 'A short description of the repository.' }, private: { type: 'boolean', description: 'Whether the repository is private.' } },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string', description: 'The repository owner login.' }, repo: { type: 'string', description: 'The repository name.' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string', description: 'The repository owner login.' }, repo: { type: 'string', description: 'The repository name.' }, title: { type: 'string', description: 'The issue title.' }, body: { type: 'string', description: 'The issue body.' } },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string', description: 'The repository owner login.' }, repo: { type: 'string', description: 'The repository name.' }, state: { type: 'string', description: 'open, closed or all.' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string', description: 'The repository owner login.' }, repo: { type: 'string', description: 'The repository name.' }, title: { type: 'string', description: 'The pull request title.' }, body: { type: 'string', description: 'The pull request body.' }, head: { type: 'string', description: 'The head branch name.' }, base: { type: 'string', description: 'The base branch name.' } },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string', description: 'The repository owner login.' }, repo: { type: 'string', description: 'The repository name.' }, pull_number: { type: 'integer', description: 'The pull request number.' } },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function replyOk(id: unknown, result: unknown): HttpResult {
  return jsonResult(200, { jsonrpc: '2.0', id: id ?? null, result });
}

function replyErr(id: unknown, code: number, message: string, status = 200): HttpResult {
  return jsonResult(status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function toolOk(payload: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
}

function toolErr(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function strArg(args: Record<string, unknown>, name: string): string {
  const payload = args[name];
  return typeof payload === 'string' ? payload : '';
}

function numArg(args: Record<string, unknown>, name: string): number | null {
  const payload = args[name];
  if (typeof payload === 'number' && Number.isInteger(payload)) return payload;
  if (typeof payload === 'string' && /^\d+$/.test(payload)) return Number(payload);
  return null;
}

function runTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const def = TOOLS.find((candidate) => candidate.name === name);
  if (def === undefined) throw new Error(`unknown tool ${name}`);
  const absent = def.inputSchema.required.filter((field) => args[field] === undefined || args[field] === null || args[field] === '');
  if (absent.length > 0) return toolErr(`absent required argument(s): ${absent.join(', ')}`);
  const owner = strArg(args, 'owner') || VIEWER_LOGIN;
  const repoName = strArg(args, 'repo') || strArg(args, 'name');
  switch (name) {
    case 'create_repo': {
      const wanted = strArg(args, 'name');
      if (store.getRepo(VIEWER_LOGIN, wanted) !== undefined) return toolErr(`repository ${wanted} already exists`);
      const repo = store.createRepo(VIEWER_LOGIN, wanted, {
        description: strArg(args, 'description'),
        private: args.private === true,
      });
      return toolOk(repoJson(repo));
    }
    case 'get_repo': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErr(`repository ${owner}/${repoName} not found`);
      return toolOk(repoJson(repo));
    }
    case 'create_issue': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErr(`repository ${owner}/${repoName} not found`);
      const issue = store.createIssue(repo, { title: strArg(args, 'title'), body: strArg(args, 'body') });
      return toolOk(issueJson(issue));
    }
    case 'list_issues': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErr(`repository ${owner}/${repoName} not found`);
      const state = strArg(args, 'state') || 'open';
      const issues = store.listIssues(repo, { state, perPage: 100, page: 1 });
      const payload = { issues: issues.map(issueJson) };
      return toolOk(payload);
    }
    case 'create_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErr(`repository ${owner}/${repoName} not found`);
      try {
        const pull = store.createPull(repo, {
          head: strArg(args, 'head'),
          base: strArg(args, 'base') || repo.defaultBranch,
          title: strArg(args, 'title'),
          body: strArg(args, 'body'),
        });
        return toolOk(pullJson(pull));
      } catch (err) {
        return toolErr(err instanceof Error ? err.message : 'cannot create pull request');
      }
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErr(`repository ${owner}/${repoName} not found`);
      const number = numArg(args, 'pull_number');
      if (number === null) return toolErr('pull_number is required');
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolErr(`pull request #${number} not found`);
      const sha = store.mergePull(repo, pull);
      if (sha === null) return toolErr(`pull request #${number} cannot be merged (conflict or already closed)`);
      return toolOk({ ...pullJson(pull), sha });
    }
    default:
      return toolErr(`unknown tool ${name}`);
  }
}

export function handleMcp(store: Store, bodyText: string, authorized: boolean): HttpResult {
  let decoded: unknown;
  try {
    decoded = JSON.parse(bodyText);
  } catch {
    return replyErr(null, -32700, 'Parse error', 400);
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    return replyErr(null, -32600, 'Invalid Request', 400);
  }
  const msg = decoded as Record<string, unknown>;
  const id = msg.id ?? null;
  const method = typeof msg.method === 'string' ? msg.method : '';
  if (method === '') return replyErr(id, -32600, 'Invalid Request: no method');

  // Authentication is decided before any def exists.
  if (!authorized) {
    return replyErr(id, -32000, 'Unauthorized', 401);
  }

  // Notifications carry no id and get no JSON-RPC answer.
  if (method.startsWith('notifications/')) {
    return { status: 202, contentType: 'application/json; charset=utf-8', body: Buffer.alloc(0) };
  }

  const params = (msg.params ?? {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    return replyOk(id, {
      supportedVersions: VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: NAME, version: VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: NAME, version: VERSION } },
    });
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = OLD_VERSIONS.includes(offered) ? offered : VERSIONS.includes(offered) ? offered : null;
    if (negotiated === null) return replyErr(id, -32602, `unsupported protocol version ${offered}`);
    return replyOk(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: NAME, version: VERSION },
    });
  }

  if (method === 'ping') {
    return replyOk(id, {});
  }

  if (method === 'tools/list') {
    return replyOk(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (name === '') return replyErr(id, -32602, 'tools/call needs a def name');
    if (TOOLS.every((def) => def.name !== name)) return replyErr(id, -32602, `unknown tool ${name}`);
    const result = runTool(store, name, args);
    return replyOk(id, result);
  }

  return replyErr(id, -32601, `method not found: ${method}`);
}
