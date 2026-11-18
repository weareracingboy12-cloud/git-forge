// Smoke test for the git forge: starts the app on an ephemeral port and
// exercises healthz, REST, GraphQL, MCP and git advertisement. Usage:
//   node --experimental-strip-types smoke.ts
import { Store } from './store.ts';
import { createApp } from './app.ts';

const TOKEN = 'shpat_testtoken';
const store = new Store();
const server = createApp(store, TOKEN);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, extra = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

async function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; text: string; json: unknown; headers: Headers }> {
  const res = await fetch(base + path, {
    method,
    headers: { ...H, ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    // not JSON
  }
  return { status: res.status, text, json, headers: res.headers };
}

console.log('healthz');
{
  const r = await req('GET', '/healthz', undefined, { authorization: '' });
  check('healthz 200', r.status === 200 && (r.json as { ok?: boolean }).ok === true);
}

console.log('rest');
{
  const r = await req('GET', '/api/v3/');
  check('root 200 + scopes', r.status === 200 && r.headers.get('x-oauth-scopes') === 'repo, read:org');
  check('root has request id', (r.headers.get('x-github-request-id') ?? '') !== '');
  const noAuth = await fetch(base + '/api/v3/user');
  check('no token -> 401', noAuth.status === 401);
  const user = await req('GET', '/api/v3/user');
  check('user login adaiversen', user.status === 200 && (user.json as { login?: string }).login === 'adaiversen');
  const repo = await req('POST', '/api/v3/user/repos', { name: 'smoke-repo', description: 'smoke', private: false });
  check('create repo 201', repo.status === 201 && (repo.json as { name?: string }).name === 'smoke-repo', repo.text);
  const dup = await req('POST', '/api/v3/user/repos', { name: 'smoke-repo' });
  check('duplicate repo 422', dup.status === 422);
  const put = await req('PUT', '/api/v3/repos/adaiversen/smoke-repo/contents/README.md', {
    message: 'add readme',
    content: Buffer.from('# smoke\n', 'utf8').toString('base64'),
  });
  check('put contents 201', put.status === 201 && typeof (put.json as { content?: { sha?: string } }).content?.sha === 'string', put.text);
  const get = await req('GET', '/api/v3/repos/adaiversen/smoke-repo/contents/README.md');
  check('get contents base64', get.status === 200 && (get.json as { content?: string }).content === Buffer.from('# smoke\n', 'utf8').toString('base64'), get.text);
  const branches = await req('GET', '/api/v3/repos/adaiversen/smoke-repo/branches');
  check('branches list', branches.status === 200 && Array.isArray(branches.json) && (branches.json as unknown[]).length === 1, branches.text);
  const issue = await req('POST', '/api/v3/repos/adaiversen/smoke-repo/issues', { title: 'first bug', body: 'it broke' });
  check('create issue 201', issue.status === 201 && (issue.json as { number?: number }).number === 1, issue.text);
  const issues = await req('GET', '/api/v3/repos/adaiversen/smoke-repo/issues');
  check('list issues', issues.status === 200 && Array.isArray(issues.json) && (issues.json as unknown[]).length === 1);
  const comment = await req('POST', '/api/v3/repos/adaiversen/smoke-repo/issues/1/comments', { body: 'noted' });
  check('comment 201', comment.status === 201 && (comment.json as { id?: number }).id! >= 1, comment.text);
  const unknown = await req('GET', '/api/v3/repos/olgabauer/nope');
  check('other owner repo 404', unknown.status === 404);
  const bad = await req('POST', '/api/v3/user/repos', 'not json', { 'content-type': 'application/json' });
  check('malformed json 400', bad.status === 400, bad.text);
  const nf = await req('GET', '/api/v3/nope');
  check('unknown route 404 json', nf.status === 404 && typeof (nf.json as { message?: string }).message === 'string');
}

console.log('graphql');
{
  const q = await req('POST', '/api/graphql', { query: '{ viewer { login } }' });
  check('viewer login', q.status === 200 && (q.json as { data?: { viewer?: { login?: string } } }).data?.viewer?.login === 'adaiversen', q.text);
  const repo = await req('POST', '/api/graphql', {
    query: 'query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id name nameWithOwner defaultBranchRef { name } } }',
    variables: { owner: 'adaiversen', name: 'smoke-repo' },
  });
  check('repository fields', repo.status === 200 && (repo.json as { data?: { repository?: { name?: string } } }).data?.repository?.name === 'smoke-repo', repo.text);
  const bad = await req('POST', '/api/graphql', { query: '{ viewer { noSuchFieldOnViewer } }' });
  check('unknown field -> 200 + errors naming field', bad.status === 200 && JSON.stringify(bad.json).includes('noSuchFieldOnViewer'), bad.text);
  const create = await req('POST', '/api/graphql', {
    query: 'mutation { createIssue(input: {repositoryId: "x", title: "gql issue", body: "hi"}) { issue { number title state } } }',
  });
  // repositoryId "x" is not a valid global id; expect errors, not a crash
  check('createIssue with bad id errors (no crash)', create.status === 200 && typeof create.json === 'object', create.text);
}

console.log('mcp');
{
  const discover = await req('POST', '/mcp', { jsonrpc: '2.0', id: 'discover-1', method: 'server/discover', params: {} });
  check('discover 2026-07-28', discover.status === 200 && JSON.stringify(discover.json).includes('2026-07-28'), discover.text);
  const init = await req('POST', '/mcp', { jsonrpc: '2.0', id: 'initialize-1', method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  check('initialize echoes 2025-11-25', init.status === 200 && (init.json as { result?: { protocolVersion?: string } }).result?.protocolVersion === '2025-11-25', init.text);
  const list = await req('POST', '/mcp', { jsonrpc: '2.0', id: 'list-1', method: 'tools/list', params: {} });
  const tools = (list.json as { result?: { tools?: { name?: string }[] } }).result?.tools ?? [];
  check('tools/list >= 6 incl create_repo', list.status === 200 && tools.length >= 6 && tools.some((t) => t.name === 'create_repo'), list.text);
  const call = await req('POST', '/mcp', {
    jsonrpc: '2.0',
    id: 'call-1',
    method: 'tools/call',
    params: { name: 'create_issue', arguments: { owner: 'adaiversen', repo: 'smoke-repo', title: 'mcp issue', body: 'via mcp' } },
  });
  check('tools/call create_issue', call.status === 200 && JSON.stringify(call.json).includes('mcp issue'), call.text);
  const unknown = await req('POST', '/mcp', { jsonrpc: '2.0', id: 'call-2', method: 'tools/call', params: { name: 'nope_tool', arguments: {} } });
  check('unknown tool -32602', unknown.status === 200 && (unknown.json as { error?: { code?: number } }).error?.code === -32602, unknown.text);
  const parse = await req('POST', '/mcp', '{bad json', { 'content-type': 'application/json' });
  check('parse error 400 -32700', parse.status === 400 && (parse.json as { error?: { code?: number } }).error?.code === -32700, parse.text);
  const noAuth = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'x', method: 'tools/call', params: { name: 'create_issue', arguments: {} } }) });
  check('mcp no auth 401', noAuth.status === 401);
}

console.log('git advertisement');
{
  const unk = await fetch(base + '/adaiversen/nope.git/info/refs?service=git-upload-pack');
  check('unknown repo 404', unk.status === 404);
  const adv = await fetch(base + '/adaiversen/smoke-repo.git/info/refs?service=git-upload-pack');
  const advText = await adv.text();
  check('advertise 200 + service line', adv.status === 200 && advText.includes('# service=git-upload-pack'), advText.slice(0, 200));
  const adv2 = await fetch(base + '/adaiversen/smoke-repo.git/info/refs?service=git-receive-pack');
  const adv2Text = await adv2.text();
  check('receive-pack advertise 200', adv2.status === 200 && adv2Text.includes('# service=git-receive-pack'));
}

console.log(`\n${passed} passed, ${failed} failed`);
server.close();
process.exit(failed === 0 ? 0 : 1);
