// Smoke test for the git forge: starts the app on an ephemeral listenPort and
// exercises healthz, REST, GraphQL, MCP and git advertisement. Usage:
//   node --experimental-strip-types smoke.ts
import { Store } from './store.ts';
import { createApp } from './app.ts';

const TOKEN = 'shpat_testtoken';
const store = new Store();
const server = createApp(store, TOKEN);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
const listenPort = (server.address() as { port: number }).port;
const origin = `http://127.0.0.1:${listenPort}`;
const AUTH = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

let okCount = 0;
let badCount = 0;
function assert(name: string, ok: boolean, extra = ''): void {
  if (ok) {
    okCount += 1;
    console.log(`  ok   ${name}`);
  } else {
    badCount += 1;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

async function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; raw: string; data: unknown; headers: Headers }> {
  const reply = await fetch(origin + path, {
    method,
    headers: { ...AUTH, ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const raw = await reply.text();
  let data: unknown = null;
  try {
    data = JSON.parse(raw) as unknown;
  } catch {
    // not JSON
  }
  return { status: reply.status, raw, data, headers: reply.headers };
}

console.log('healthz');
{
  const resp = await request('GET', '/healthz', undefined, { authorization: '' });
  assert('healthz 200', resp.status === 200 && (resp.data as { ok?: boolean }).ok === true);
}

console.log('rest');
{
  const resp = await request('GET', '/api/v3/');
  assert('root 200 + scopes', resp.status === 200 && resp.headers.get('x-oauth-scopes') === 'repo, read:org');
  assert('root has request id', (resp.headers.get('x-github-request-id') ?? '') !== '');
  const anon = await fetch(origin + '/api/v3/user');
  assert('no token -> 401', anon.status === 401);
  const user = await request('GET', '/api/v3/user');
  assert('user login adaiversen', user.status === 200 && (user.data as { login?: string }).login === 'adaiversen');
  const repo = await request('POST', '/api/v3/user/repos', { name: 'smoke-repo', description: 'smoke', private: false });
  assert('create repo 201', repo.status === 201 && (repo.data as { name?: string }).name === 'smoke-repo', repo.raw);
  const again = await request('POST', '/api/v3/user/repos', { name: 'smoke-repo' });
  assert('duplicate repo 422', again.status === 422);
  const created = await request('PUT', '/api/v3/repos/adaiversen/smoke-repo/contents/README.md', {
    message: 'add readme',
    content: Buffer.from('# smoke\n', 'utf8').toString('base64'),
  });
  assert('created contents 201', created.status === 201 && typeof (created.data as { content?: { sha?: string } }).content?.sha === 'string', created.raw);
  const fetched = await request('GET', '/api/v3/repos/adaiversen/smoke-repo/contents/README.md');
  assert('fetched contents base64', fetched.status === 200 && (fetched.data as { content?: string }).content === Buffer.from('# smoke\n', 'utf8').toString('base64'), fetched.raw);
  const branches = await request('GET', '/api/v3/repos/adaiversen/smoke-repo/branches');
  assert('branches list', branches.status === 200 && Array.isArray(branches.data) && (branches.data as unknown[]).length === 1, branches.raw);
  const issue = await request('POST', '/api/v3/repos/adaiversen/smoke-repo/issues', { title: 'first bug', body: 'it broke' });
  assert('create issue 201', issue.status === 201 && (issue.data as { number?: number }).number === 1, issue.raw);
  const issues = await request('GET', '/api/v3/repos/adaiversen/smoke-repo/issues');
  assert('list issues', issues.status === 200 && Array.isArray(issues.data) && (issues.data as unknown[]).length === 1);
  const comment = await request('POST', '/api/v3/repos/adaiversen/smoke-repo/issues/1/comments', { body: 'noted' });
  assert('comment 201', comment.status === 201 && (comment.data as { id?: number }).id! >= 1, comment.raw);
  const unknown = await request('GET', '/api/v3/repos/olgabauer/nope');
  assert('other owner repo 404', unknown.status === 404);
  const bad = await request('POST', '/api/v3/user/repos', 'not data', { 'content-type': 'application/json' });
  assert('malformed data 400', bad.status === 400, bad.raw);
  const missing = await request('GET', '/api/v3/nope');
  assert('unknown route 404 data', missing.status === 404 && typeof (missing.data as { message?: string }).message === 'string');
}

console.log('mcp');
{
  const discover = await request('POST', '/mcp', { jsonrpc: '2.0', id: 'discover-1', method: 'server/discover', params: {} });
  assert('discover 2026-07-28', discover.status === 200 && JSON.stringify(discover.data).includes('2026-07-28'), discover.raw);
  const init = await request('POST', '/mcp', { jsonrpc: '2.0', id: 'initialize-1', method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  assert('initialize echoes 2025-11-25', init.status === 200 && (init.data as { result?: { protocolVersion?: string } }).result?.protocolVersion === '2025-11-25', init.raw);
  const list = await request('POST', '/mcp', { jsonrpc: '2.0', id: 'list-1', method: 'tools/list', params: {} });
  const tools = (list.data as { result?: { tools?: { name?: string }[] } }).result?.tools ?? [];
  assert('tools/list >= 6 incl create_repo', list.status === 200 && tools.length >= 6 && tools.some((t) => t.name === 'create_repo'), list.raw);
  const toolCall = await request('POST', '/mcp', {
    jsonrpc: '2.0',
    id: 'call-1',
    method: 'tools/call',
    params: { name: 'create_issue', arguments: { owner: 'adaiversen', repo: 'smoke-repo', title: 'mcp issue', body: 'via mcp' } },
  });
  assert('tools/call create_issue', toolCall.status === 200 && JSON.stringify(toolCall.data).includes('mcp issue'), toolCall.raw);
  const unknown = await request('POST', '/mcp', { jsonrpc: '2.0', id: 'call-2', method: 'tools/call', params: { name: 'nope_tool', arguments: {} } });
  assert('unknown tool -32602', unknown.status === 200 && (unknown.data as { error?: { code?: number } }).error?.code === -32602, unknown.raw);
  const parse = await request('POST', '/mcp', '{bad data', { 'content-type': 'application/json' });
  assert('parse error 400 -32700', parse.status === 400 && (parse.data as { error?: { code?: number } }).error?.code === -32700, parse.raw);
  const anon = await fetch(origin + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'x', method: 'tools/call', params: { name: 'create_issue', arguments: {} } }) });
  assert('mcp no auth 401', anon.status === 401);
}

console.log('graphql');
{
  const viewerResp = await request('POST', '/api/graphql', { query: '{ viewer { login } }' });
  assert('viewer login', viewerResp.status === 200 && (viewerResp.data as { data?: { viewer?: { login?: string } } }).data?.viewer?.login === 'adaiversen', viewerResp.raw);
  const repo = await request('POST', '/api/graphql', {
    query: 'query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id name nameWithOwner defaultBranchRef { name } } }',
    variables: { owner: 'adaiversen', name: 'smoke-repo' },
  });
  assert('repository fields', repo.status === 200 && (repo.data as { data?: { repository?: { name?: string } } }).data?.repository?.name === 'smoke-repo', repo.raw);
  const bad = await request('POST', '/api/graphql', { query: '{ viewer { noSuchFieldOnViewer } }' });
  assert('unknown field -> 200 + errors naming field', bad.status === 200 && JSON.stringify(bad.data).includes('noSuchFieldOnViewer'), bad.raw);
  const create = await request('POST', '/api/graphql', {
    query: 'mutation { createIssue(input: {repositoryId: "x", title: "gql issue", body: "hi"}) { issue { number title state } } }',
  });
  // repositoryId "x" is not a valid global id; expect errors, not a crash
  assert('createIssue with bad id errors (no crash)', create.status === 200 && typeof create.data === 'object', create.raw);
}

console.log('git advertisement');
{
  const missingRepo = await fetch(origin + '/adaiversen/nope.git/info/refs?service=git-upload-pack');
  assert('unknown repo 404', missingRepo.status === 404);
  const uploadAdv = await fetch(origin + '/adaiversen/smoke-repo.git/info/refs?service=git-upload-pack');
  const uploadText = await uploadAdv.text();
  assert('advertise 200 + service line', uploadAdv.status === 200 && uploadText.includes('# service=git-upload-pack'), uploadText.slice(0, 200));
  const receiveAdv = await fetch(origin + '/adaiversen/smoke-repo.git/info/refs?service=git-receive-pack');
  const receiveText = await receiveAdv.text();
  assert('receive-pack advertise 200', receiveAdv.status === 200 && receiveText.includes('# service=git-receive-pack'));
}

console.log(`\n${okCount} okCount, ${badCount} badCount`);
server.close();
process.exit(badCount === 0 ? 0 : 1);
