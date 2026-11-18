// MCP at /mcp: JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28.
//
//   `server/discover` answers the server's identity, capabilities and
//   supportedVersions in one request (the modern era, no handshake, no
//   session); `initialize` + `notifications/initialized` is answered too, for
//   a client that predates discover. Every answer is one plain JSON body
//   (never an SSE stream). A body that is not JSON is HTTP 400 with
//   JSON-RPC -32700. An unknown tool is -32602, never HTTP 500. A tool call
//   without its required arguments is a tool result with isError: true.
//   No Authorization header is HTTP 401. The six tools act on the same
//   store as REST, so a repository or issue made over MCP reads back over
//   REST with the same ids.

import { Store, VIEWER_LOGIN } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import { jsonResult, type HttpResult } from './httputil.ts';

const SERVER_NAME = 'git-forge';
const SERVER_VERSION = '1.0.0';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/** The six tools, in a fixed order: tools/list is byte-identical every time. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function rpcResult(id: unknown, result: unknown): HttpResult {
  return jsonResult(200, { jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string, status = 200): HttpResult {
  return jsonResult(status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function toolResult(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

function numberArg(args: Record<string, unknown>, name: string): number | null {
  const value = args[name];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`unknown tool ${name}`);
  const missing = tool.inputSchema.required.filter((field) => args[field] === undefined || args[field] === null || args[field] === '');
  if (missing.length > 0) return toolError(`missing required argument(s): ${missing.join(', ')}`);
  const owner = stringArg(args, 'owner') || VIEWER_LOGIN;
  const repoName = stringArg(args, 'repo') || stringArg(args, 'name');
  switch (name) {
    case 'create_repo': {
      const repoNameArg = stringArg(args, 'name');
      if (store.getRepo(VIEWER_LOGIN, repoNameArg) !== undefined) return toolError(`repository ${repoNameArg} already exists`);
      const repo = store.createRepo(VIEWER_LOGIN, repoNameArg, {
        description: stringArg(args, 'description'),
        private: args.private === true,
      });
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`repository ${owner}/${repoName} not found`);
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`repository ${owner}/${repoName} not found`);
      const issue = store.createIssue(repo, { title: stringArg(args, 'title'), body: stringArg(args, 'body') });
      return toolResult(issueJson(issue));
    }
    case 'list_issues': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`repository ${owner}/${repoName} not found`);
      const state = stringArg(args, 'state') || 'open';
      const issues = store.listIssues(repo, { state, perPage: 100, page: 1 });
      const value = { issues: issues.map(issueJson) };
      return toolResult(value);
    }
    case 'create_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`repository ${owner}/${repoName} not found`);
      try {
        const pull = store.createPull(repo, {
          head: stringArg(args, 'head'),
          base: stringArg(args, 'base') || repo.defaultBranch,
          title: stringArg(args, 'title'),
          body: stringArg(args, 'body'),
        });
        return toolResult(pullJson(pull));
      } catch (err) {
        return toolError(err instanceof Error ? err.message : 'cannot create pull request');
      }
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`repository ${owner}/${repoName} not found`);
      const number = numberArg(args, 'pull_number');
      if (number === null) return toolError('pull_number is required');
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolError(`pull request #${number} not found`);
      const sha = store.mergePull(repo, pull);
      if (sha === null) return toolError(`pull request #${number} cannot be merged (conflict or already closed)`);
      return toolResult({ ...pullJson(pull), sha });
    }
    default:
      return toolError(`unknown tool ${name}`);
  }
}

export function handleMcp(store: Store, bodyText: string, authorized: boolean): HttpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return rpcError(null, -32600, 'Invalid Request', 400);
  }
  const request = parsed as Record<string, unknown>;
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  if (method === '') return rpcError(id, -32600, 'Invalid Request: no method');

  // Authentication is decided before any tool exists.
  if (!authorized) {
    return rpcError(id, -32000, 'Unauthorized', 401);
  }

  // Notifications carry no id and get no JSON-RPC answer.
  if (method.startsWith('notifications/')) {
    return { status: 202, contentType: 'application/json; charset=utf-8', body: Buffer.alloc(0) };
  }

  const params = (request.params ?? {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = LEGACY_VERSIONS.includes(offered) ? offered : SUPPORTED_VERSIONS.includes(offered) ? offered : null;
    if (negotiated === null) return rpcError(id, -32602, `unsupported protocol version ${offered}`);
    return rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (name === '') return rpcError(id, -32602, 'tools/call needs a tool name');
    if (TOOLS.every((tool) => tool.name !== name)) return rpcError(id, -32602, `unknown tool ${name}`);
    const result = callTool(store, name, args);
    return rpcResult(id, result);
  }

  return rpcError(id, -32601, `method not found: ${method}`);
}
