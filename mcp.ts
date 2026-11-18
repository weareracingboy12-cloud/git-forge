// MCP at /mcp: JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28.
//
//   `server/discover` answers the server's identity, capabilities and
//   supportedVersions in one message (the modern era, no handshake, no
//   session); `initialize` + `notifications/initialized` is answered too,
//   for a client that predates discover. Every answer is one plain JSON
//   body (never an SSE stream). A body that is not JSON is HTTP 400 with
//   JSON-RPC -32700. An unknown tool is -32602, never HTTP 500. A tool
//   call without its required arguments is a tool result with isError:
//   true. No Authorization header is HTTP 401. The six tools act on the
//   same store as REST, so a repository or issue made over MCP reads back
//   over REST with the same ids.

import { Store, VIEWER } from './store.ts';
import { issueView, pullView, repoView } from './rest.ts';
import { jsonReply, type Reply } from './httputil.ts';

const SERVER_NAME = 'git-forge';
const SERVER_VERSION = '1.0.0';

const SUPPORTED_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolSpec {
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
const TOOL_CATALOG: ToolSpec[] = [
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

function okReply(id: unknown, result: unknown): Reply {
  return jsonReply(200, { jsonrpc: '2.0', id: id ?? null, result });
}

function errReply(id: unknown, code: number, message: string, status = 200): Reply {
  return jsonReply(status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function toolSuccess(payload: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
}

function toolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const payload = args[name];
  return typeof payload === 'string' ? payload : '';
}

function intArg(args: Record<string, unknown>, name: string): number | null {
  const payload = args[name];
  if (typeof payload === 'number' && Number.isInteger(payload)) return payload;
  if (typeof payload === 'string' && /^\d+$/.test(payload)) return Number(payload);
  return null;
}

function invokeTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const spec = TOOL_CATALOG.find((candidate) => candidate.name === name);
  if (spec === undefined) throw new Error(`unknown tool ${name}`);
  const absent = spec.inputSchema.required.filter((field) => args[field] === undefined || args[field] === null || args[field] === '');
  if (absent.length > 0) return toolFailure(`absent required argument(s): ${absent.join(', ')}`);
  const owner = stringArg(args, 'owner') || VIEWER;
  const repoName = stringArg(args, 'repo') || stringArg(args, 'name');
  switch (name) {
    case 'create_repo': {
      const wanted = stringArg(args, 'name');
      if (store.findRepo(VIEWER, wanted) !== undefined) return toolFailure(`repository ${wanted} already exists`);
      const repo = store.addRepo(VIEWER, wanted, {
        description: stringArg(args, 'description'),
        private: args.private === true,
      });
      return toolSuccess(repoView(repo));
    }
    case 'get_repo': {
      const repo = store.findRepo(owner, repoName);
      if (repo === undefined) return toolFailure(`repository ${owner}/${repoName} not found`);
      return toolSuccess(repoView(repo));
    }
    case 'create_issue': {
      const repo = store.findRepo(owner, repoName);
      if (repo === undefined) return toolFailure(`repository ${owner}/${repoName} not found`);
      const issue = store.addIssue(repo, { title: stringArg(args, 'title'), body: stringArg(args, 'body') });
      return toolSuccess(issueView(issue));
    }
    case 'list_issues': {
      const repo = store.findRepo(owner, repoName);
      if (repo === undefined) return toolFailure(`repository ${owner}/${repoName} not found`);
      const state = stringArg(args, 'state') || 'open';
      const issues = store.issuesOf(repo, { state, perPage: 100, page: 1 });
      return toolSuccess({ issues: issues.map(issueView) });
    }
    case 'create_pull_request': {
      const repo = store.findRepo(owner, repoName);
      if (repo === undefined) return toolFailure(`repository ${owner}/${repoName} not found`);
      try {
        const pull = store.openPull(repo, {
          head: stringArg(args, 'head'),
          base: stringArg(args, 'base') || repo.mainBranch,
          title: stringArg(args, 'title'),
          body: stringArg(args, 'body'),
        });
        return toolSuccess(pullView(pull));
      } catch (err) {
        return toolFailure(err instanceof Error ? err.message : 'cannot create pull request');
      }
    }
    case 'merge_pull_request': {
      const repo = store.findRepo(owner, repoName);
      if (repo === undefined) return toolFailure(`repository ${owner}/${repoName} not found`);
      const number = intArg(args, 'pull_number');
      if (number === null) return toolFailure('pull_number is required');
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolFailure(`pull request #${number} not found`);
      const sha = store.squashMerge(repo, pull);
      if (sha === null) return toolFailure(`pull request #${number} cannot be merged (conflict or already closed)`);
      return toolSuccess({ ...pullView(pull), sha });
    }
    default:
      return toolFailure(`unknown tool ${name}`);
  }
}

export function serveMcp(store: Store, bodyText: string, authorized: boolean): Reply {
  let decoded: unknown;
  try {
    decoded = JSON.parse(bodyText);
  } catch {
    return errReply(null, -32700, 'Parse error', 400);
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    return errReply(null, -32600, 'Invalid Request', 400);
  }
  const msg = decoded as Record<string, unknown>;
  const id = msg.id ?? null;
  const method = typeof msg.method === 'string' ? msg.method : '';
  if (method === '') return errReply(id, -32600, 'Invalid Request: no method');

  // Authentication is decided before any tool exists.
  if (!authorized) {
    return errReply(id, -32000, 'Unauthorized', 401);
  }

  // Notifications carry no id and get no JSON-RPC answer.
  if (method.startsWith('notifications/')) {
    return { status: 202, contentType: 'application/json; charset=utf-8', body: Buffer.alloc(0) };
  }

  const params = (msg.params ?? {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    return okReply(id, {
      supportedVersions: SUPPORTED_REVISIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = LEGACY_REVISIONS.includes(offered) ? offered : SUPPORTED_REVISIONS.includes(offered) ? offered : null;
    if (negotiated === null) return errReply(id, -32602, `unsupported protocol version ${offered}`);
    return okReply(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'ping') {
    return okReply(id, {});
  }

  if (method === 'tools/list') {
    return okReply(id, { tools: TOOL_CATALOG });
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (name === '') return errReply(id, -32602, 'tools/call needs a tool name');
    if (TOOL_CATALOG.every((spec) => spec.name !== name)) return errReply(id, -32602, `unknown tool ${name}`);
    const result = invokeTool(store, name, args);
    return okReply(id, result);
  }

  return errReply(id, -32601, `method not found: ${method}`);
}
