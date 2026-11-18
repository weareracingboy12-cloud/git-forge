// GraphQL v4 at /api/graphql: a small document lexer, parser and
// executor for the documents gh and github-mcp-server actually send —
// no GraphQL library, no schema file, just the queries and mutations
// the suite drives.
//
//   Query.viewer{login}; Query.repository(owner:, name:) (nullable);
//   Query.node(id:) with `... on Repository`; Query.__type(name:) with
//   fields(includeDeprecated:) and enumValues(includeDeprecated:),
//   under the aliases gh uses; repository.issue(number:),
//   issues(first:, states:, orderBy:, after:) with cursor pageInfo,
//   pullRequests(first:), pullRequest(number:); createIssue, closeIssue,
//   createPullRequest, mergePullRequest and addComment mutations;
//   batched operation documents in one body. An unknown field is a 200
//   with an `errors` array naming it. Global ids are opaque (base64 of
//   a kind and a path) and stable.

import { BASE_EPOCH, Store, VIEWER, type IssueRecord, type PullRecord, type Repository } from './store.ts';
import { jsonReply, type Reply } from './httputil.ts';

// ---------------------------------------------------------------------------
// document model
// ---------------------------------------------------------------------------

export type ValNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'items'; values: ValNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValNode }> };

export interface FieldSel {
  alias: string | null;
  name: string;
  arguments: Array<{ name: string; value: ValNode }>;
  sels: SelNode[] | null;
}

export interface FragSel {
  typeCondition: string;
  sels: SelNode[];
}

export type SelNode = { kind: 'fld'; field: FieldSel } | { kind: 'fragment'; fragment: FragSel };

export interface OpNode {
  operation: 'query' | 'mutation';
  name: string | null;
  vars: string[];
  sels: SelNode[];
}

// ---------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------

type LexToken =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'eof' };

function lex(input: string): LexToken[] {
  const tokens: LexToken[] = [];
  let at = 0;
  const opensName = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const extendsName = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
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
    if (opensName(ch)) {
      let name = '';
      while (at < input.length && extendsName(input[at]!)) {
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

class DocParser {
  private pos = 0;

  private readonly lexed: LexToken[];
  constructor(lexed: LexToken[]) {
    this.lexed = lexed;
  }

  private peek(): LexToken {
    return this.lexed[this.pos]!;
  }

  private take(): LexToken {
    const token = this.lexed[this.pos]!;
    this.pos += 1;
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

  parseAll(): OpNode[] {
    const operations: OpNode[] = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOp());
    }
    return operations;
  }

  private parseOp(): OpNode {
    let operation: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const head = this.peek();
    if (head.kind === 'name' && (head.value === 'query' || head.value === 'mutation')) {
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
        this.parseType();
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.take();
          this.parseValue();
        }
      }
      this.expectPunct(')');
    }
    return { operation, name, vars, sels: this.parseSels() };
  }

  private parseType(): void {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '[') {
      this.take();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.take();
  }

  private parseSels(): SelNode[] {
    this.expectPunct('{');
    const sels: SelNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '...') {
        this.take();
        const on = this.peek();
        if (on.kind === 'name' && on.value === 'on') {
          this.take();
          const typeCondition = this.expectName();
          sels.push({ kind: 'fragment', fragment: { typeCondition, sels: this.parseSels() } });
        } else {
          throw new Error('fragment spreads are not supported');
        }
        continue;
      }
      const head = this.expectName();
      let alias: string | null = null;
      let name = head;
      if (this.peek().kind === 'punct' && this.peek().value === ':') {
        this.take();
        alias = head;
        name = this.expectName();
      }
      const argv: Array<{ name: string; value: ValNode }> = [];
      if (this.peek().kind === 'punct' && this.peek().value === '(') {
        this.take();
        while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          argv.push({ name: argName, value: this.parseValue() });
        }
        this.expectPunct(')');
      }
      let sub: SelNode[] | null = null;
      if (this.peek().kind === 'punct' && this.peek().value === '{') sub = this.parseSels();
      sels.push({ kind: 'fld', field: { alias, name, arguments: argv, sels: sub } });
    }
    this.expectPunct('}');
    return sels;
  }

  private parseValue(): ValNode {
    const token = this.take();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'items', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
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

function evalValue(node: ValNode, vars: Record<string, unknown>): unknown {
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
      return node.values.map((child) => evalValue(child, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const entry of node.fields) out[entry.name] = evalValue(entry.value, vars);
      return out;
    }
  }
}

function encodeId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join('/')}`, 'utf8').toString('base64url');
}

function decodeId(id: string): { kind: string; parts: string[] } | null {
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

type GqlNode =
  | { __typename: 'Query' }
  | { __typename: 'Mutation' }
  | { __typename: 'User'; login: string }
  | { __typename: 'Repository'; repo: Repository }
  | { __typename: 'Issue'; repo: Repository; issue: IssueRecord }
  | { __typename: 'PullRequest'; repo: Repository; pull: PullRecord }
  | { __typename: 'Ref'; name: string }
  | {
      __typename: 'IssueConnection';
      nodes: Array<{ __typename: 'Issue'; repo: Repository; issue: IssueRecord }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    }
  | { __typename: 'PullRequestConnection'; nodes: Array<{ __typename: 'PullRequest'; repo: Repository; pull: PullRecord }> }
  | { __typename: 'PullRequestChangedFileConnection'; nodes: Array<{ __typename: 'PullRequestChangedFile'; path: string }> }
  | { __typename: 'PullRequestChangedFile'; path: string }
  | { __typename: '__Type'; name: string; fields: string[]; enumValues: string[] }
  | { __typename: '__Field'; name: string }
  | { __typename: '__EnumValue'; name: string }
  | { __typename: 'IssueCommentEdge'; node: { __typename: 'IssueComment'; id: string; body: string } }
  | { __typename: 'CreateIssuePayload'; issue: { __typename: 'Issue'; repo: Repository; issue: IssueRecord } }
  | { __typename: 'CloseIssuePayload'; issue: { __typename: 'Issue'; repo: Repository; issue: IssueRecord } }
  | { __typename: 'CreatePullRequestPayload'; pull: { __typename: 'PullRequest'; repo: Repository; pull: PullRecord } }
  | { __typename: 'MergePullRequestPayload'; pull: { __typename: 'PullRequest'; repo: Repository; pull: PullRecord } }
  | { __typename: 'AddCommentPayload'; comment: { __typename: 'IssueComment'; id: string; body: string } }
  | { __typename: 'IssueComment'; id: string; body: string };

const ISSUE_FIELD_NAMES = ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url'];
const PULL_FIELD_NAMES = [
  'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid',
  'files', 'createdAt', 'updatedAt', 'author', 'url',
];
const REPO_FIELD_NAMES = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'private', 'defaultBranchRef', 'viewerPermission',
  'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt', 'url',
];
const SEARCH_KINDS = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];

function stateOfIssue(issue: IssueRecord): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function stateOfPull(pull: PullRecord): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function repoNodeId(repo: Repository): string {
  return encodeId('repo', repo.owner, repo.name);
}

function issueNodeId(repo: Repository, issue: IssueRecord): string {
  return encodeId('issue', repo.owner, repo.name, issue.number);
}

function pullNodeId(repo: Repository, pull: PullRecord): string {
  return encodeId('pull', repo.owner, repo.name, pull.number);
}

interface ExecCtx {
  store: Store;
  problems: Array<{ message: string; path?: Array<string | number> }>;
}

function repoFromId(store: Store, id: string): Repository | null {
  const unpacked = decodeId(id);
  if (unpacked === null || unpacked.kind !== 'repo' || unpacked.parts.length !== 2) return null;
  return store.findRepo(unpacked.parts[0]!, unpacked.parts[1]!) ?? null;
}

function issueFromId(store: Store, id: string): { repo: Repository; issue: IssueRecord } | null {
  const unpacked = decodeId(id);
  if (unpacked === null || unpacked.kind !== 'issue' || unpacked.parts.length !== 3) return null;
  const repo = store.findRepo(unpacked.parts[0]!, unpacked.parts[1]!);
  if (repo === undefined) return null;
  const issue = repo.issues.get(Number(unpacked.parts[2]));
  return issue === undefined ? null : { repo, issue };
}

function pullFromId(store: Store, id: string): { repo: Repository; pull: PullRecord } | null {
  const unpacked = decodeId(id);
  if (unpacked === null || unpacked.kind !== 'pull' || unpacked.parts.length !== 3) return null;
  const repo = store.findRepo(unpacked.parts[0]!, unpacked.parts[1]!);
  if (repo === undefined) return null;
  const pull = repo.pulls.get(Number(unpacked.parts[2]));
  return pull === undefined ? null : { repo, pull };
}

// ---------------------------------------------------------------------------
// field resolution
// ---------------------------------------------------------------------------

function collectArgs(field: FieldSel, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.arguments) out[arg.name] = evalValue(arg.value, vars);
  return out;
}

function argString(argv: Record<string, unknown>, name: string): string {
  const value = argv[name];
  return typeof value === 'string' ? value : '';
}

function argNumber(argv: Record<string, unknown>, name: string): number | undefined {
  const value = argv[name];
  return typeof value === 'number' ? value : undefined;
}

function resolveField(cx: ExecCtx, node: GqlNode, field: FieldSel, vars: Record<string, unknown>): unknown {
  const argv = collectArgs(field, vars);
  const store = cx.store;
  switch (node.__typename) {
    case 'Query': {
      if (field.name === '__type') {
        const name = argString(argv, 'name');
        if (name === 'Issue') {
          return { __typename: '__Type', name, fields: ISSUE_FIELD_NAMES, enumValues: [] } as GqlNode;
        }
        if (name === 'PullRequest') {
          return { __typename: '__Type', name, fields: PULL_FIELD_NAMES, enumValues: [] } as GqlNode;
        }
        if (name === 'Repository') {
          return { __typename: '__Type', name, fields: REPO_FIELD_NAMES, enumValues: [] } as GqlNode;
        }
        if (name === 'SearchType') {
          return { __typename: '__Type', name, fields: [], enumValues: SEARCH_KINDS } as GqlNode;
        }
        return { __typename: '__Type', name, fields: [], enumValues: [] } as GqlNode;
      }
      if (field.name === 'viewer') return { __typename: 'User', login: VIEWER } as GqlNode;
      if (field.name === 'node') {
        const id = argString(argv, 'id');
        const repo = repoFromId(store, id);
        return repo === null ? null : ({ __typename: 'Repository', repo } as GqlNode);
      }
      if (field.name === 'repository') {
        const repo = store.findRepo(argString(argv, 'owner'), argString(argv, 'name'));
        return repo === undefined ? null : ({ __typename: 'Repository', repo } as GqlNode);
      }
      return undefined;
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = (argv.input ?? {}) as Record<string, unknown>;
        const repo = repoFromId(store, String(input.repositoryId ?? ''));
        if (repo === null) throw new Error('createIssue: unknown repository');
        const issue = store.addIssue(repo, { title: String(input.title ?? ''), body: String(input.body ?? '') });
        return { __typename: 'CreateIssuePayload', issue: { __typename: 'Issue', repo, issue } } as GqlNode;
      }
      if (field.name === 'closeIssue') {
        const input = (argv.input ?? {}) as Record<string, unknown>;
        const found = issueFromId(store, String(input.issueId ?? ''));
        if (found === null) throw new Error('closeIssue: unknown issue');
        found.issue.state = 'closed';
        return { __typename: 'CloseIssuePayload', issue: { __typename: 'Issue', repo: found.repo, issue: found.issue } } as GqlNode;
      }
      if (field.name === 'createPullRequest') {
        const input = (argv.input ?? {}) as Record<string, unknown>;
        const repo = repoFromId(store, String(input.repositoryId ?? ''));
        if (repo === null) throw new Error('createPullRequest: unknown repository');
        const pull = store.openPull(repo, {
          head: String(input.headRefName ?? ''),
          base: String(input.baseRefName ?? ''),
          title: String(input.title ?? ''),
          body: String(input.body ?? ''),
        });
        return { __typename: 'CreatePullRequestPayload', pull: { __typename: 'PullRequest', repo, pull } } as GqlNode;
      }
      if (field.name === 'mergePullRequest') {
        const input = (argv.input ?? {}) as Record<string, unknown>;
        const found = pullFromId(store, String(input.pullRequestId ?? ''));
        if (found === null) throw new Error('mergePullRequest: unknown pull request');
        const sha = store.squashMerge(found.repo, found.pull);
        if (sha === null) throw new Error('mergePullRequest: merge conflict');
        return { __typename: 'MergePullRequestPayload', pull: { __typename: 'PullRequest', repo: found.repo, pull: found.pull } } as GqlNode;
      }
      if (field.name === 'addComment') {
        const input = (argv.input ?? {}) as Record<string, unknown>;
        const found = issueFromId(store, String(input.subjectId ?? ''));
        if (found === null) throw new Error('addComment: unknown subject');
        const comment = store.commentOnIssue(found.repo, found.issue, String(input.body ?? ''));
        const id = encodeId('comment', found.repo.owner, found.repo.name, found.issue.number, comment.id);
        return { __typename: 'AddCommentPayload', comment: { __typename: 'IssueComment', id, body: comment.body } } as GqlNode;
      }
      return undefined;
    }
    case 'User':
      if (field.name === 'login') return node.login;
      return undefined;
    case 'Repository': {
      const repo = node.repo;
      switch (field.name) {
        case 'id':
          return repoNodeId(repo);
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
          return { __typename: 'User', login: repo.owner } as GqlNode;
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.mainBranch}`);
          return tip === undefined ? null : ({ __typename: 'Ref', name: repo.mainBranch } as GqlNode);
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const number = argNumber(argv, 'number');
          const issue = number === undefined ? undefined : repo.issues.get(number);
          return issue === undefined ? null : ({ __typename: 'Issue', repo, issue } as GqlNode);
        }
        case 'issues': {
          const states = Array.isArray(argv.states) ? (argv.states as string[]) : null;
          const orderBy = (argv.orderBy ?? {}) as Record<string, unknown>;
          const first = argNumber(argv, 'first');
          const after = typeof argv.after === 'string' ? argv.after : null;
          let rows = [...repo.issues.values()];
          if (states !== null) {
            const allowed = new Set(
              states.map((state) =>
                state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : state.toLowerCase(),
              ),
            );
            rows = rows.filter((issue) => allowed.has(issue.state));
          }
          const direction = orderBy.direction === 'ASC' ? 'asc' : 'desc';
          rows.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          if (after !== null) {
            const unpacked = decodeId(after);
            if (unpacked !== null && unpacked.kind === 'cursor') {
              const seq = Number(unpacked.parts[0]);
              rows = rows.filter((issue) => (direction === 'asc' ? issue.seq > seq : issue.seq < seq));
            }
          }
          const slice = first === undefined ? rows : rows.slice(0, first);
          const hasNextPage = first !== undefined && rows.length > first;
          const tailItem = slice[slice.length - 1];
          return {
            __typename: 'IssueConnection',
            nodes: slice.map((issue) => ({ __typename: 'Issue', repo, issue })),
            pageInfo: { hasNextPage, endCursor: tailItem === undefined ? null : encodeId('cursor', tailItem.seq) },
          } as GqlNode;
        }
        case 'pullRequests': {
          const first = argNumber(argv, 'first');
          const rows = [...repo.pulls.values()]
            .filter((pull) => pull.state === 'open')
            .sort((a, b) => b.seq - a.seq);
          const slice = first === undefined ? rows : rows.slice(0, first);
          return {
            __typename: 'PullRequestConnection',
            nodes: slice.map((pull) => ({ __typename: 'PullRequest', repo, pull })),
          } as GqlNode;
        }
        case 'pullRequest': {
          const number = argNumber(argv, 'number');
          const pull = number === undefined ? undefined : repo.pulls.get(number);
          return pull === undefined ? null : ({ __typename: 'PullRequest', repo, pull } as GqlNode);
        }
        default:
          return undefined;
      }
    }
    case 'Issue': {
      const issue = node.issue;
      switch (field.name) {
        case 'id':
          return issueNodeId(node.repo, issue);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return stateOfIssue(issue);
        case 'createdAt':
          return new Date((BASE_EPOCH + issue.seq) * 1000).toISOString();
        default:
          return undefined;
      }
    }
    case 'PullRequest': {
      const pull = node.pull;
      switch (field.name) {
        case 'id':
          return pullNodeId(node.repo, pull);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return stateOfPull(pull);
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
          return store.canMergePull(node.repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        case 'files': {
          const first = argNumber(argv, 'first');
          const files = store.filesOfPull(node.repo, pull);
          const slice = first === undefined ? files : files.slice(0, first);
          return {
            __typename: 'PullRequestChangedFileConnection',
            nodes: slice.map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename })),
          } as GqlNode;
        }
        default:
          return undefined;
      }
    }
    case 'Ref':
      if (field.name === 'name') return node.name;
      return undefined;
    case 'IssueConnection':
      if (field.name === 'nodes') return node.nodes;
      if (field.name === 'pageInfo') return node.pageInfo;
      return undefined;
    case 'PullRequestConnection':
      if (field.name === 'nodes') return node.nodes;
      return undefined;
    case 'PullRequestChangedFileConnection':
      if (field.name === 'nodes') return node.nodes;
      return undefined;
    case 'PullRequestChangedFile':
      if (field.name === 'path') return node.path;
      return undefined;
    case '__Type':
      if (field.name === 'fields') return node.fields.map((name) => ({ __typename: '__Field', name }));
      if (field.name === 'enumValues') return node.enumValues.map((name) => ({ __typename: '__EnumValue', name }));
      if (field.name === 'name') return node.name;
      return undefined;
    case '__Field':
    case '__EnumValue':
      if (field.name === 'name') return node.name;
      return undefined;
    case 'IssueCommentEdge':
      if (field.name === 'node') return node.node;
      return undefined;
    case 'CreateIssuePayload':
      if (field.name === 'issue') return node.issue;
      return undefined;
    case 'CloseIssuePayload':
      if (field.name === 'issue') return node.issue;
      return undefined;
    case 'CreatePullRequestPayload':
      if (field.name === 'pullRequest') return node.pull;
      return undefined;
    case 'MergePullRequestPayload':
      if (field.name === 'pullRequest') return node.pull;
      return undefined;
    case 'AddCommentPayload':
      if (field.name === 'commentEdge') return { __typename: 'IssueCommentEdge', node: node.comment };
      return undefined;
    case 'IssueComment':
      if (field.name === 'id') return node.id;
      if (field.name === 'body') return node.body;
      return undefined;
    default:
      return undefined;
  }
}

// The pageInfo object is a plain record, not a GqlNode: resolve its
// fields here.
function pageInfoField(node: Record<string, unknown>, field: FieldSel): unknown {
  if (field.name === 'hasNextPage') return node.hasNextPage ?? false;
  if (field.name === 'endCursor') return node.endCursor ?? null;
  return undefined;
}

// __Field and __EnumValue are plain records too.
function namedValue(node: { name: string }, field: FieldSel): unknown {
  if (field.name === 'name') return node.name;
  return undefined;
}

function isGqlNode(value: unknown): value is GqlNode {
  return typeof value === 'object' && value !== null && '__typename' in value && typeof (value as { __typename: unknown }).__typename === 'string';
}

function execSels(
  cx: ExecCtx,
  node: unknown,
  sels: SelNode[],
  vars: Record<string, unknown>,
  path: Array<string | number>,
): Record<string, unknown> | null {
  if (node === null || node === undefined) return null;
  const out: Record<string, unknown> = {};
  for (const sel of sels) {
    if (sel.kind === 'fragment') {
      const typename = isGqlNode(node) ? node.__typename : null;
      if (typename === null || typename !== sel.fragment.typeCondition) continue;
      const nested = execSels(cx, node, sel.fragment.sels, vars, path);
      if (nested !== null) Object.assign(out, nested);
      continue;
    }
    const field = sel.field;
    const key = field.alias ?? field.name;
    const fieldPath = [...path, key];
    let value: unknown;
    try {
      if (field.name === '__typename') {
        value = isGqlNode(node) ? node.__typename : null;
      } else if (isGqlNode(node)) {
        value = resolveField(cx, node, field, vars);
      } else if (typeof node === 'object' && node !== null && ('hasNextPage' in node || 'endCursor' in node)) {
        value = pageInfoField(node as Record<string, unknown>, field);
      } else if (typeof node === 'object' && node !== null && 'name' in node && Object.keys(node).length === 1) {
        value = namedValue(node as { name: string }, field);
      } else {
        value = undefined;
      }
    } catch (err) {
      cx.problems.push({ message: err instanceof Error ? err.message : String(err), path: fieldPath });
      out[key] = null;
      continue;
    }
    if (value === undefined) {
      const typeName = isGqlNode(node) ? node.__typename : 'Query';
      cx.problems.push({ message: `Cannot query field "${field.name}" on type "${typeName}".`, path: fieldPath });
      out[key] = null;
      continue;
    }
    if (field.sels === null) {
      out[key] = value;
    } else if (Array.isArray(value)) {
      out[key] = value.map((entry, index) => execSels(cx, entry, field.sels!, vars, [...fieldPath, index]));
    } else {
      out[key] = execSels(cx, value, field.sels, vars, fieldPath);
    }
  }
  return out;
}

function execOp(
  store: Store,
  operation: OpNode,
  vars: Record<string, unknown>,
): { data: Record<string, unknown> | null; errors: Array<{ message: string }> } {
  const cx: ExecCtx = { store, problems: [] };
  const root: GqlNode = operation.operation === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  let data: Record<string, unknown> | null = null;
  try {
    data = execSels(cx, root, operation.sels, vars, []);
  } catch (err) {
    cx.problems.push({ message: err instanceof Error ? err.message : String(err) });
    data = null;
  }
  return { data, errors: cx.problems };
}

export function serveGraphql(store: Store, body: unknown): Reply {
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
    let operations: OpNode[];
    try {
      operations = new DocParser(lex(query)).parseAll();
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    if (operations.length === 0) return { errors: [{ message: 'GraphQL document has no operation' }] };
    const result = execOp(store, operations[0]!, vars);
    const out: Record<string, unknown> = { data: result.data };
    if (result.errors.length > 0) out.errors = result.errors;
    return out;
  };
  if (Array.isArray(body)) {
    return jsonReply(200, body.map(runOne));
  }
  return jsonReply(200, runOne(body));
}
