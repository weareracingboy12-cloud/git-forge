// GraphQL v4 at /api/graphql: a small document lexer, parser and
// executor for the documents gh and github-mcp-server actually send —
// no GraphQL library, no schema file, just the queries and mutations the
// suite drives.
//
//   Query.viewer{login}; Query.repository(owner:, name:) (nullable);
//   Query.node(id:) with `... on Repository`; Query.__type(name:) with
//   fields(includeDeprecated:) and enumValues(includeDeprecated:), under
//   the aliases gh uses; repository.issue(number:), issues(first:,
//   states:, orderBy:, after:) with cursor pageInfo,
//   pullRequests(first:), pullRequest(number:); createIssue, closeIssue,
//   createPullRequest, mergePullRequest and addComment mutations; batched
//   operation documents in one body. An unknown fld is a 200 with an
//   `errors` array naming it. Global ids are opaque (base64 of a kind and
//   a path) and stable.

import { Store, VIEWER_LOGIN, type Issue, type Pull, type Repo } from './store.ts';
import { jsonResult, type HttpResult } from './httputil.ts';

// ---------------------------------------------------------------------------
// document model
// ---------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'items'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  alias: string | null;
  name: string;
  arguments: Array<{ name: string; value: ValueNode }>;
  sels: SelectionNode[] | null;
}

export interface FragmentNode {
  typeCondition: string;
  sels: SelectionNode[];
}

export type SelectionNode = { kind: 'fld'; fld: FieldNode } | { kind: 'fragment'; fragment: FragmentNode };

export interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  vars: string[];
  sels: SelectionNode[];
}

// ---------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'eof' };

function scan(input: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  const startsName = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const continuesName = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (at < input.length) {
    const ch = input[at]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      at += 1;
      continue;
    }
    if (ch === '#') {
      while (at < input.length && input[at] !== '\n') at += 1;
      continue;
    }
    if (ch === '.' && input.slice(at, at + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      at += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      at += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      at += 1;
      while (at < input.length && input[at] !== '"') {
        if (input[at] === '\\' && at + 1 < input.length) {
          const next = input[at + 1]!;
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
          at += 2;
        } else {
          value += input[at];
          at += 1;
        }
      }
      at += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      let num = '';
      while (at < input.length && /[0-9.eE+-]/.test(input[at]!)) {
        num += input[at];
        at += 1;
      }
      if (num.includes('.') || num.includes('e') || num.includes('E')) tokens.push({ kind: 'float', value: Number(num) });
      else tokens.push({ kind: 'int', value: Number.parseInt(num, 10) });
      continue;
    }
    if (startsName(ch)) {
      let name = '';
      while (at < input.length && continuesName(input[at]!)) {
        name += input[at];
        at += 1;
      }
      tokens.push({ kind: 'name', value: name });
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

class Parser {
  private at = 0;

  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.at]!;
  }

  private take(): Token {
    const token = this.tokens[this.at]!;
    this.at += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.take();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }

  private expectName(): string {
    const token = this.take();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  readAll(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.readOp());
    }
    return operations;
  }

  private readOp(): OperationNode {
    let operation: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const first = this.peek();
    if (first.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      operation = this.take().value as 'query' | 'mutation';
      const maybeName = this.peek();
      if (maybeName.kind === 'name') name = this.take().value;
    }
    const vars: string[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.take();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const dollar = this.take();
        if (dollar.kind !== 'punct' || dollar.value !== '$') throw new Error('expected $ in variable definition');
        vars.push(this.expectName());
        this.expectPunct(':');
        this.readTyp();
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.take();
          this.readVal();
        }
      }
      this.expectPunct(')');
    }
    return { operation, name, vars, sels: this.readSel() };
  }

  private readTyp(): void {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '[') {
      this.take();
      this.readTyp();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.take();
  }

  private readSel(): SelectionNode[] {
    this.expectPunct('{');
    const sels: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '...') {
        this.take();
        const on = this.peek();
        if (on.kind === 'name' && on.value === 'on') {
          this.take();
          const typeCondition = this.expectName();
          sels.push({ kind: 'fragment', fragment: { typeCondition, sels: this.readSel() } });
        } else {
          throw new Error('fragment spreads are not supported');
        }
        continue;
      }
      const first = this.expectName();
      let alias: string | null = null;
      let name = first;
      if (this.peek().kind === 'punct' && this.peek().value === ':') {
        this.take();
        alias = first;
        name = this.expectName();
      }
      const argv: Array<{ name: string; value: ValueNode }> = [];
      if (this.peek().kind === 'punct' && this.peek().value === '(') {
        this.take();
        while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          argv.push({ name: argName, value: this.readVal() });
        }
        this.expectPunct(')');
      }
      let sub: SelectionNode[] | null = null;
      if (this.peek().kind === 'punct' && this.peek().value === '{') sub = this.readSel();
      sels.push({ kind: 'fld', fld: { alias, name, arguments: argv, sels: sub } });
    }
    this.expectPunct('}');
    return sels;
  }

  private readVal(): ValueNode {
    const token = this.take();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.readVal());
      this.expectPunct(']');
      return { kind: 'items', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.readVal() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

// ---------------------------------------------------------------------------
// values and global ids
// ---------------------------------------------------------------------------

function resolveArg(node: ValueNode, vars: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return vars[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'items':
      return node.values.map((child) => resolveArg(child, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const fld of node.fields) out[fld.name] = resolveArg(fld.value, vars);
      return out;
    }
  }
}

function packId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join('/')}`, 'utf8').toString('base64url');
}

function unpackId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), parts: text.slice(colon + 1).split('/') };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// the object model the executor walks
// ---------------------------------------------------------------------------

type GqlObject =
  | { __typename: 'Query' }
  | { __typename: 'Mutation' }
  | { __typename: 'User'; login: string }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'Ref'; name: string }
  | {
      __typename: 'IssueConnection';
      nodes: Array<{ __typename: 'Issue'; repo: Repo; issue: Issue }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    }
  | { __typename: 'PullRequestConnection'; nodes: Array<{ __typename: 'PullRequest'; repo: Repo; pull: Pull }> }
  | { __typename: 'PullRequestChangedFileConnection'; nodes: Array<{ __typename: 'PullRequestChangedFile'; path: string }> }
  | { __typename: 'PullRequestChangedFile'; path: string }
  | { __typename: '__Type'; name: string; fields: string[]; enumValues: string[] }
  | { __typename: '__Field'; name: string }
  | { __typename: '__EnumValue'; name: string }
  | { __typename: 'IssueCommentEdge'; node: { __typename: 'IssueComment'; id: string; body: string } }
  | { __typename: 'CreateIssuePayload'; issue: { __typename: 'Issue'; repo: Repo; issue: Issue } }
  | { __typename: 'CloseIssuePayload'; issue: { __typename: 'Issue'; repo: Repo; issue: Issue } }
  | { __typename: 'CreatePullRequestPayload'; pull: { __typename: 'PullRequest'; repo: Repo; pull: Pull } }
  | { __typename: 'MergePullRequestPayload'; pull: { __typename: 'PullRequest'; repo: Repo; pull: Pull } }
  | { __typename: 'AddCommentPayload'; comment: { __typename: 'IssueComment'; id: string; body: string } }
  | { __typename: 'IssueComment'; id: string; body: string };

const ISSUE_FIELDS = ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url'];
const PULL_REQUEST_FIELDS = [
  'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid',
  'files', 'createdAt', 'updatedAt', 'author', 'url',
];
const REPOSITORY_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'private', 'defaultBranchRef', 'viewerPermission',
  'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt', 'url',
];
const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function repoGlobalId(repo: Repo): string {
  return packId('repo', repo.owner, repo.name);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return packId('issue', repo.owner, repo.name, issue.number);
}

function pullGlobalId(repo: Repo, pull: Pull): string {
  return packId('pull', repo.owner, repo.name, pull.number);
}

interface Ctx {
  store: Store;
  problems: Array<{ message: string; path?: Array<string | number> }>;
}

function repoById(store: Store, id: string): Repo | null {
  const unpacked = unpackId(id);
  if (unpacked === null || unpacked.kind !== 'repo' || unpacked.parts.length !== 2) return null;
  return store.getRepo(unpacked.parts[0]!, unpacked.parts[1]!) ?? null;
}

function issueById(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const unpacked = unpackId(id);
  if (unpacked === null || unpacked.kind !== 'issue' || unpacked.parts.length !== 3) return null;
  const repo = store.getRepo(unpacked.parts[0]!, unpacked.parts[1]!);
  if (repo === undefined) return null;
  const issue = repo.issues.get(Number(unpacked.parts[2]));
  return issue === undefined ? null : { repo, issue };
}

function pullById(store: Store, id: string): { repo: Repo; pull: Pull } | null {
  const unpacked = unpackId(id);
  if (unpacked === null || unpacked.kind !== 'pull' || unpacked.parts.length !== 3) return null;
  const repo = store.getRepo(unpacked.parts[0]!, unpacked.parts[1]!);
  if (repo === undefined) return null;
  const pull = repo.pulls.get(Number(unpacked.parts[2]));
  return pull === undefined ? null : { repo, pull };
}

// ---------------------------------------------------------------------------
// fld resolution
// ---------------------------------------------------------------------------

function argsOf(fld: FieldNode, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of fld.arguments) out[arg.name] = resolveArg(arg.value, vars);
  return out;
}

function strArg(argv: Record<string, unknown>, name: string): string {
  const value = argv[name];
  return typeof value === 'string' ? value : '';
}

function numArg(argv: Record<string, unknown>, name: string): number | undefined {
  const value = argv[name];
  return typeof value === 'number' ? value : undefined;
}

function fieldVal(cx: Ctx, node: GqlObject, fld: FieldNode, vars: Record<string, unknown>): unknown {
  const argv = argsOf(fld, vars);
  const store = cx.store;
  switch (node.__typename) {
    case 'Query': {
      if (fld.name === '__type') {
        const name = strArg(argv, 'name');
        if (name === 'Issue') {
          return { __typename: '__Type', name, fields: ISSUE_FIELDS, enumValues: [] } as GqlObject;
        }
        if (name === 'PullRequest') {
          return { __typename: '__Type', name, fields: PULL_REQUEST_FIELDS, enumValues: [] } as GqlObject;
        }
        if (name === 'Repository') {
          return { __typename: '__Type', name, fields: REPOSITORY_FIELDS, enumValues: [] } as GqlObject;
        }
        if (name === 'SearchType') {
          return { __typename: '__Type', name, fields: [], enumValues: SEARCH_TYPE_VALUES } as GqlObject;
        }
        return { __typename: '__Type', name, fields: [], enumValues: [] } as GqlObject;
      }
      if (fld.name === 'viewer') return { __typename: 'User', login: VIEWER_LOGIN } as GqlObject;
      if (fld.name === 'node') {
        const id = strArg(argv, 'id');
        const repo = repoById(store, id);
        return repo === null ? null : ({ __typename: 'Repository', repo } as GqlObject);
      }
      if (fld.name === 'repository') {
        const repo = store.getRepo(strArg(argv, 'owner'), strArg(argv, 'name'));
        return repo === undefined ? null : ({ __typename: 'Repository', repo } as GqlObject);
      }
      return undefined;
    }
    case 'Mutation': {
      if (fld.name === 'createIssue') {
        const input = (argv.input ?? {}) as Record<string, unknown>;
        const repo = repoById(store, String(input.repositoryId ?? ''));
        if (repo === null) throw new Error('createIssue: unknown repository');
        const issue = store.createIssue(repo, { title: String(input.title ?? ''), body: String(input.body ?? '') });
        return { __typename: 'CreateIssuePayload', issue: { __typename: 'Issue', repo, issue } } as GqlObject;
      }
      if (fld.name === 'closeIssue') {
        const input = (argv.input ?? {}) as Record<string, unknown>;
        const found = issueById(store, String(input.issueId ?? ''));
        if (found === null) throw new Error('closeIssue: unknown issue');
        found.issue.state = 'closed';
        return { __typename: 'CloseIssuePayload', issue: { __typename: 'Issue', repo: found.repo, issue: found.issue } } as GqlObject;
      }
      if (fld.name === 'createPullRequest') {
        const input = (argv.input ?? {}) as Record<string, unknown>;
        const repo = repoById(store, String(input.repositoryId ?? ''));
        if (repo === null) throw new Error('createPullRequest: unknown repository');
        const pull = store.createPull(repo, {
          head: String(input.headRefName ?? ''),
          base: String(input.baseRefName ?? ''),
          title: String(input.title ?? ''),
          body: String(input.body ?? ''),
        });
        return { __typename: 'CreatePullRequestPayload', pull: { __typename: 'PullRequest', repo, pull } } as GqlObject;
      }
      if (fld.name === 'mergePullRequest') {
        const input = (argv.input ?? {}) as Record<string, unknown>;
        const found = pullById(store, String(input.pullRequestId ?? ''));
        if (found === null) throw new Error('mergePullRequest: unknown pull request');
        const sha = store.mergePull(found.repo, found.pull);
        if (sha === null) throw new Error('mergePullRequest: merge conflict');
        return { __typename: 'MergePullRequestPayload', pull: { __typename: 'PullRequest', repo: found.repo, pull: found.pull } } as GqlObject;
      }
      if (fld.name === 'addComment') {
        const input = (argv.input ?? {}) as Record<string, unknown>;
        const found = issueById(store, String(input.subjectId ?? ''));
        if (found === null) throw new Error('addComment: unknown subject');
        const comment = store.addIssueComment(found.repo, found.issue, String(input.body ?? ''));
        const id = packId('comment', found.repo.owner, found.repo.name, found.issue.number, comment.id);
        return { __typename: 'AddCommentPayload', comment: { __typename: 'IssueComment', id, body: comment.body } } as GqlObject;
      }
      return undefined;
    }
    case 'User':
      if (fld.name === 'login') return node.login;
      return undefined;
    case 'Repository': {
      const repo = node.repo;
      switch (fld.name) {
        case 'id':
          return repoGlobalId(repo);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'description':
          return repo.description;
        case 'private':
          return repo.private;
        case 'owner':
          return { __typename: 'User', login: repo.owner } as GqlObject;
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return tip === undefined ? null : ({ __typename: 'Ref', name: repo.defaultBranch } as GqlObject);
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const number = numArg(argv, 'number');
          const issue = number === undefined ? undefined : repo.issues.get(number);
          return issue === undefined ? null : ({ __typename: 'Issue', repo, issue } as GqlObject);
        }
        case 'issues': {
          const states = Array.isArray(argv.states) ? (argv.states as string[]) : null;
          const orderBy = (argv.orderBy ?? {}) as Record<string, unknown>;
          const first = numArg(argv, 'first');
          const after = typeof argv.after === 'string' ? argv.after : null;
          let items = [...repo.issues.values()];
          if (states !== null) {
            const wanted = new Set(
              states.map((state) =>
                state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : state.toLowerCase(),
              ),
            );
            items = items.filter((issue) => wanted.has(issue.state));
          }
          const direction = orderBy.direction === 'ASC' ? 'asc' : 'desc';
          items.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
          if (after !== null) {
            const unpacked = unpackId(after);
            if (unpacked !== null && unpacked.kind === 'cursor') {
              const seq = Number(unpacked.parts[0]);
              items = items.filter((issue) => (direction === 'asc' ? issue.createdSeq > seq : issue.createdSeq < seq));
            }
          }
          const slice = first === undefined ? items : items.slice(0, first);
          const hasNextPage = first !== undefined && items.length > first;
          const tailItem = slice[slice.length - 1];
          return {
            __typename: 'IssueConnection',
            nodes: slice.map((issue) => ({ __typename: 'Issue', repo, issue })),
            pageInfo: { hasNextPage, endCursor: tailItem === undefined ? null : packId('cursor', tailItem.createdSeq) },
          } as GqlObject;
        }
        case 'pullRequests': {
          const first = numArg(argv, 'first');
          const items = [...repo.pulls.values()]
            .filter((pull) => pull.state === 'open')
            .sort((a, b) => b.createdSeq - a.createdSeq);
          const slice = first === undefined ? items : items.slice(0, first);
          return {
            __typename: 'PullRequestConnection',
            nodes: slice.map((pull) => ({ __typename: 'PullRequest', repo, pull })),
          } as GqlObject;
        }
        case 'pullRequest': {
          const number = numArg(argv, 'number');
          const pull = number === undefined ? undefined : repo.pulls.get(number);
          return pull === undefined ? null : ({ __typename: 'PullRequest', repo, pull } as GqlObject);
        }
        default:
          return undefined;
      }
    }
    case 'Issue': {
      const issue = node.issue;
      switch (fld.name) {
        case 'id':
          return issueGlobalId(node.repo, issue);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issueState(issue);
        case 'createdAt':
          return new Date((1_735_689_600 + issue.createdSeq) * 1000).toISOString();
        default:
          return undefined;
      }
    }
    case 'PullRequest': {
      const pull = node.pull;
      switch (fld.name) {
        case 'id':
          return pullGlobalId(node.repo, pull);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pullState(pull);
        case 'merged':
          return pull.merged;
        case 'headRefName':
          return pull.head;
        case 'baseRefName':
          return pull.base;
        case 'headRefOid':
          return pull.headSha;
        case 'baseRefOid':
          return pull.baseSha;
        case 'mergeable':
          return store.pullMergeable(node.repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        case 'files': {
          const first = numArg(argv, 'first');
          const files = store.pullFiles(node.repo, pull);
          const slice = first === undefined ? files : files.slice(0, first);
          return {
            __typename: 'PullRequestChangedFileConnection',
            nodes: slice.map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename })),
          } as GqlObject;
        }
        default:
          return undefined;
      }
    }
    case 'Ref':
      if (fld.name === 'name') return node.name;
      return undefined;
    case 'IssueConnection':
      if (fld.name === 'nodes') return node.nodes;
      if (fld.name === 'pageInfo') return node.pageInfo;
      return undefined;
    case 'PullRequestConnection':
      if (fld.name === 'nodes') return node.nodes;
      return undefined;
    case 'PullRequestChangedFileConnection':
      if (fld.name === 'nodes') return node.nodes;
      return undefined;
    case 'PullRequestChangedFile':
      if (fld.name === 'path') return node.path;
      return undefined;
    case '__Type':
      if (fld.name === 'fields') return node.fields.map((name) => ({ __typename: '__Field', name }));
      if (fld.name === 'enumValues') return node.enumValues.map((name) => ({ __typename: '__EnumValue', name }));
      if (fld.name === 'name') return node.name;
      return undefined;
    case '__Field':
    case '__EnumValue':
      if (fld.name === 'name') return node.name;
      return undefined;
    case 'IssueCommentEdge':
      if (fld.name === 'node') return node.node;
      return undefined;
    case 'CreateIssuePayload':
      if (fld.name === 'issue') return node.issue;
      return undefined;
    case 'CloseIssuePayload':
      if (fld.name === 'issue') return node.issue;
      return undefined;
    case 'CreatePullRequestPayload':
      if (fld.name === 'pullRequest') return node.pull;
      return undefined;
    case 'MergePullRequestPayload':
      if (fld.name === 'pullRequest') return node.pull;
      return undefined;
    case 'AddCommentPayload':
      if (fld.name === 'commentEdge') return { __typename: 'IssueCommentEdge', node: node.comment };
      return undefined;
    case 'IssueComment':
      if (fld.name === 'id') return node.id;
      if (fld.name === 'body') return node.body;
      return undefined;
    default:
      return undefined;
  }
}

// The pageInfo object is a plain record, not a GqlObject: resolve its
// fields here.
function plainField(node: Record<string, unknown>, fld: FieldNode): unknown {
  if (fld.name === 'hasNextPage') return node.hasNextPage ?? false;
  if (fld.name === 'endCursor') return node.endCursor ?? null;
  return undefined;
}

// __Field and __EnumValue are plain records too.
function namedField(node: { name: string }, fld: FieldNode): unknown {
  if (fld.name === 'name') return node.name;
  return undefined;
}

function isObjectNode(value: unknown): value is GqlObject {
  return typeof value === 'object' && value !== null && '__typename' in value && typeof (value as { __typename: unknown }).__typename === 'string';
}

function runSels(
  cx: Ctx,
  node: unknown,
  sels: SelectionNode[],
  vars: Record<string, unknown>,
  path: Array<string | number>,
): Record<string, unknown> | null {
  if (node === null || node === undefined) return null;
  const out: Record<string, unknown> = {};
  for (const sel of sels) {
    if (sel.kind === 'fragment') {
      const typename = isObjectNode(node) ? node.__typename : null;
      if (typename === null || typename !== sel.fragment.typeCondition) continue;
      const nested = runSels(cx, node, sel.fragment.sels, vars, path);
      if (nested !== null) Object.assign(out, nested);
      continue;
    }
    const fld = sel.fld;
    const key = fld.alias ?? fld.name;
    const fieldPath = [...path, key];
    let value: unknown;
    try {
      if (fld.name === '__typename') {
        value = isObjectNode(node) ? node.__typename : null;
      } else if (isObjectNode(node)) {
        value = fieldVal(cx, node, fld, vars);
      } else if (typeof node === 'object' && node !== null && ('hasNextPage' in node || 'endCursor' in node)) {
        value = plainField(node as Record<string, unknown>, fld);
      } else if (typeof node === 'object' && node !== null && 'name' in node && Object.keys(node).length === 1) {
        value = namedField(node as { name: string }, fld);
      } else {
        value = undefined;
      }
    } catch (err) {
      cx.problems.push({ message: err instanceof Error ? err.message : String(err), path: fieldPath });
      out[key] = null;
      continue;
    }
    if (value === undefined) {
      const typeName = isObjectNode(node) ? node.__typename : 'Query';
      cx.problems.push({ message: `Cannot query field "${fld.name}" on type "${typeName}".`, path: fieldPath });
      out[key] = null;
      continue;
    }
    if (fld.sels === null) {
      out[key] = value;
    } else if (Array.isArray(value)) {
      out[key] = value.map((entry, index) => runSels(cx, entry, fld.sels!, vars, [...fieldPath, index]));
    } else {
      out[key] = runSels(cx, value, fld.sels, vars, fieldPath);
    }
  }
  return out;
}

function runOp(
  store: Store,
  operation: OperationNode,
  vars: Record<string, unknown>,
): { data: Record<string, unknown> | null; errors: Array<{ message: string }> } {
  const cx: Ctx = { store, problems: [] };
  const root: GqlObject = operation.operation === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  let data: Record<string, unknown> | null = null;
  try {
    data = runSels(cx, root, operation.sels, vars, []);
  } catch (err) {
    cx.problems.push({ message: err instanceof Error ? err.message : String(err) });
    data = null;
  }
  return { data, errors: cx.problems };
}

export function handleGraphql(store: Store, body: unknown): HttpResult {
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { errors: [{ message: 'GraphQL request body must be an object with query and variables' }] };
    }
    const record = entry as Record<string, unknown>;
    const query = record.query;
    if (typeof query !== 'string' || query.trim() === '') {
      return { errors: [{ message: 'GraphQL request needs a query string' }] };
    }
    const vars = (record.variables ?? {}) as Record<string, unknown>;
    let operations: OperationNode[];
    try {
      operations = new Parser(scan(query)).readAll();
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    if (operations.length === 0) return { errors: [{ message: 'GraphQL document has no operation' }] };
    const result = runOp(store, operations[0]!, vars);
    const out: Record<string, unknown> = { data: result.data };
    if (result.errors.length > 0) out.errors = result.errors;
    return out;
  };
  if (Array.isArray(body)) {
    return jsonResult(200, body.map(runOne));
  }
  return jsonResult(200, runOne(body));
}
