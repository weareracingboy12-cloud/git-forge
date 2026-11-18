// GraphQL v4 at /api/graphql: a small document parser and executor for the
// documents gh and github-mcp-server actually send — no GraphQL library, no
// schema file, just the queries and mutations the suite drives.
//
//   Query.viewer{login}; Query.repository(owner:, name:) (nullable);
//   Query.node(id:) with `... on Repository`; Query.__type(name:) with
//   fields(includeDeprecated:) and enumValues(includeDeprecated:), under the
//   aliases gh uses; repository.issue(number:), issues(first:, states:,
//   orderBy:, after:) with cursor pageInfo, pullRequests(first:),
//   pullRequest(number:); createIssue, closeIssue, createPullRequest,
//   mergePullRequest and addComment mutations; batched operation documents in
//   one body. An unknown field is a 200 with an `errors` array naming it.
//   Global ids are opaque (base64 of a kind and a path) and stable.

import { Store, VIEWER_LOGIN, type Issue, type Pull, type Repo } from './store.ts';
import { jsonResult, type HttpResult } from './httputil.ts';

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

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const next = input[i + 1]!;
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
          i += 2;
        } else {
          value += input[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      let num = '';
      while (i < input.length && /[0-9.eE+-]/.test(input[i]!)) {
        num += input[i];
        i += 1;
      }
      if (num.includes('.') || num.includes('e') || num.includes('E')) tokens.push({ kind: 'float', value: Number(num) });
      else tokens.push({ kind: 'int', value: Number.parseInt(num, 10) });
      continue;
    }
    if (isNameStart(ch)) {
      let name = '';
      while (i < input.length && isNameChar(input[i]!)) {
        name += input[i];
        i += 1;
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

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  alias: string | null;
  name: string;
  arguments: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[] | null;
}

export interface FragmentNode {
  typeCondition: string;
  selections: SelectionNode[];
}

export type SelectionNode = { kind: 'field'; field: FieldNode } | { kind: 'fragment'; fragment: FragmentNode };

export interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  variables: string[];
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;

  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): OperationNode {
    let operation: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const first = this.peek();
    if (first.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      operation = this.next().value as 'query' | 'mutation';
      const maybeName = this.peek();
      if (maybeName.kind === 'name') name = this.next().value;
    }
    const variables: string[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const dollar = this.next();
        if (dollar.kind !== 'punct' || dollar.value !== '$') throw new Error('expected $ in variable definition');
        variables.push(this.expectName());
        this.expectPunct(':');
        this.parseType();
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          this.parseValue();
        }
      }
      this.expectPunct(')');
    }
    return { operation, name, variables, selections: this.parseSelections() };
  }

  private parseType(): void {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelections(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '...') {
        this.next();
        const on = this.peek();
        if (on.kind === 'name' && on.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          selections.push({ kind: 'fragment', fragment: { typeCondition, selections: this.parseSelections() } });
        } else {
          throw new Error('fragment spreads are not supported');
        }
        continue;
      }
      const first = this.expectName();
      let alias: string | null = null;
      let name = first;
      if (this.peek().kind === 'punct' && this.peek().value === ':') {
        this.next();
        alias = first;
        name = this.expectName();
      }
      const args: Array<{ name: string; value: ValueNode }> = [];
      if (this.peek().kind === 'punct' && this.peek().value === '(') {
        this.next();
        while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args.push({ name: argName, value: this.parseValue() });
        }
        this.expectPunct(')');
      }
      let sub: SelectionNode[] | null = null;
      if (this.peek().kind === 'punct' && this.peek().value === '{') sub = this.parseSelections();
      selections.push({ kind: 'field', field: { alias, name, arguments: args, selections: sub } });
    }
    this.expectPunct('}');
    return selections;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
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

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => resolveValue(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
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

type GqlObject =
  | { __typename: 'Query' }
  | { __typename: 'Mutation' }
  | { __typename: 'User'; login: string }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'IssueConnection'; nodes: Array<{ __typename: 'Issue'; repo: Repo; issue: Issue }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
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
  return encodeId('repo', repo.owner, repo.name);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return encodeId('issue', repo.owner, repo.name, issue.number);
}

function pullGlobalId(repo: Repo, pull: Pull): string {
  return encodeId('pull', repo.owner, repo.name, pull.number);
}

interface Executor {
  store: Store;
  errors: Array<{ message: string; path?: Array<string | number> }>;
}

function findRepoByGlobalId(store: Store, id: string): Repo | null {
  const decoded = decodeId(id);
  if (decoded === null || decoded.kind !== 'repo' || decoded.parts.length !== 2) return null;
  return store.getRepo(decoded.parts[0]!, decoded.parts[1]!) ?? null;
}

function findIssueByGlobalId(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeId(id);
  if (decoded === null || decoded.kind !== 'issue' || decoded.parts.length !== 3) return null;
  const repo = store.getRepo(decoded.parts[0]!, decoded.parts[1]!);
  if (repo === undefined) return null;
  const issue = repo.issues.get(Number(decoded.parts[2]));
  return issue === undefined ? null : { repo, issue };
}

function findPullByGlobalId(store: Store, id: string): { repo: Repo; pull: Pull } | null {
  const decoded = decodeId(id);
  if (decoded === null || decoded.kind !== 'pull' || decoded.parts.length !== 3) return null;
  const repo = store.getRepo(decoded.parts[0]!, decoded.parts[1]!);
  if (repo === undefined) return null;
  const pull = repo.pulls.get(Number(decoded.parts[2]));
  return pull === undefined ? null : { repo, pull };
}

// ---------------------------------------------------------------------------
// field resolution
// ---------------------------------------------------------------------------

function argMap(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.arguments) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

function intArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  return typeof value === 'number' ? value : undefined;
}

function resolveField(exec: Executor, parent: GqlObject, field: FieldNode, variables: Record<string, unknown>): unknown {
  const args = argMap(field, variables);
  const store = exec.store;
  switch (parent.__typename) {
    case 'Query': {
      if (field.name === 'viewer') return { __typename: 'User', login: VIEWER_LOGIN } as GqlObject;
      if (field.name === 'repository') {
        const repo = store.getRepo(stringArg(args, 'owner'), stringArg(args, 'name'));
        return repo === undefined ? null : ({ __typename: 'Repository', repo } as GqlObject);
      }
      if (field.name === 'node') {
        const id = stringArg(args, 'id');
        const repo = findRepoByGlobalId(store, id);
        return repo === null ? null : ({ __typename: 'Repository', repo } as GqlObject);
      }
      if (field.name === '__type') {
        const name = stringArg(args, 'name');
        if (name === 'Issue') return { __typename: '__Type', name, fields: ISSUE_FIELDS, enumValues: [] } as GqlObject;
        if (name === 'PullRequest') return { __typename: '__Type', name, fields: PULL_REQUEST_FIELDS, enumValues: [] } as GqlObject;
        if (name === 'Repository') return { __typename: '__Type', name, fields: REPOSITORY_FIELDS, enumValues: [] } as GqlObject;
        if (name === 'SearchType') return { __typename: '__Type', name, fields: [], enumValues: SEARCH_TYPE_VALUES } as GqlObject;
        return { __typename: '__Type', name, fields: [], enumValues: [] } as GqlObject;
      }
      return undefined;
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = findRepoByGlobalId(store, String(input.repositoryId ?? ''));
        if (repo === null) throw new Error('createIssue: unknown repository');
        const issue = store.createIssue(repo, { title: String(input.title ?? ''), body: String(input.body ?? '') });
        return { __typename: 'CreateIssuePayload', issue: { __typename: 'Issue', repo, issue } } as GqlObject;
      }
      if (field.name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findIssueByGlobalId(store, String(input.issueId ?? ''));
        if (found === null) throw new Error('closeIssue: unknown issue');
        found.issue.state = 'closed';
        return { __typename: 'CloseIssuePayload', issue: { __typename: 'Issue', repo: found.repo, issue: found.issue } } as GqlObject;
      }
      if (field.name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = findRepoByGlobalId(store, String(input.repositoryId ?? ''));
        if (repo === null) throw new Error('createPullRequest: unknown repository');
        const pull = store.createPull(repo, {
          head: String(input.headRefName ?? ''),
          base: String(input.baseRefName ?? ''),
          title: String(input.title ?? ''),
          body: String(input.body ?? ''),
        });
        return { __typename: 'CreatePullRequestPayload', pull: { __typename: 'PullRequest', repo, pull } } as GqlObject;
      }
      if (field.name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findPullByGlobalId(store, String(input.pullRequestId ?? ''));
        if (found === null) throw new Error('mergePullRequest: unknown pull request');
        const sha = store.mergePull(found.repo, found.pull);
        if (sha === null) throw new Error('mergePullRequest: merge conflict');
        return { __typename: 'MergePullRequestPayload', pull: { __typename: 'PullRequest', repo: found.repo, pull: found.pull } } as GqlObject;
      }
      if (field.name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findIssueByGlobalId(store, String(input.subjectId ?? ''));
        if (found === null) throw new Error('addComment: unknown subject');
        const comment = store.addIssueComment(found.repo, found.issue, String(input.body ?? ''));
        const id = encodeId('comment', found.repo.owner, found.repo.name, found.issue.number, comment.id);
        return { __typename: 'AddCommentPayload', comment: { __typename: 'IssueComment', id, body: comment.body } } as GqlObject;
      }
      return undefined;
    }
    case 'User':
      if (field.name === 'login') return parent.login;
      return undefined;
    case 'Repository': {
      const repo = parent.repo;
      switch (field.name) {
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
          const number = intArg(args, 'number');
          const issue = number === undefined ? undefined : repo.issues.get(number);
          return issue === undefined ? null : ({ __typename: 'Issue', repo, issue } as GqlObject);
        }
        case 'issues': {
          const states = Array.isArray(args.states) ? (args.states as string[]) : null;
          const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
          const first = intArg(args, 'first');
          const after = typeof args.after === 'string' ? args.after : null;
          let list = [...repo.issues.values()];
          if (states !== null) {
            const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : state.toLowerCase())));
            list = list.filter((issue) => wanted.has(issue.state));
          }
          const direction = orderBy.direction === 'ASC' ? 'asc' : 'desc';
          list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
          if (after !== null) {
            const decoded = decodeId(after);
            if (decoded !== null && decoded.kind === 'cursor') {
              const seq = Number(decoded.parts[0]);
              list = list.filter((issue) => (direction === 'asc' ? issue.createdSeq > seq : issue.createdSeq < seq));
            }
          }
          const page = first === undefined ? list : list.slice(0, first);
          const hasNextPage = first !== undefined && list.length > first;
          const last = page[page.length - 1];
          return {
            __typename: 'IssueConnection',
            nodes: page.map((issue) => ({ __typename: 'Issue', repo, issue })),
            pageInfo: { hasNextPage, endCursor: last === undefined ? null : encodeId('cursor', last.createdSeq) },
          } as GqlObject;
        }
        case 'pullRequests': {
          const first = intArg(args, 'first');
          const list = [...repo.pulls.values()]
            .filter((pull) => pull.state === 'open')
            .sort((a, b) => b.createdSeq - a.createdSeq);
          const page = first === undefined ? list : list.slice(0, first);
          return {
            __typename: 'PullRequestConnection',
            nodes: page.map((pull) => ({ __typename: 'PullRequest', repo, pull })),
          } as GqlObject;
        }
        case 'pullRequest': {
          const number = intArg(args, 'number');
          const pull = number === undefined ? undefined : repo.pulls.get(number);
          return pull === undefined ? null : ({ __typename: 'PullRequest', repo, pull } as GqlObject);
        }
        default:
          return undefined;
      }
    }
    case 'Issue': {
      const issue = parent.issue;
      switch (field.name) {
        case 'id':
          return issueGlobalId(parent.repo, issue);
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
      const pull = parent.pull;
      switch (field.name) {
        case 'id':
          return pullGlobalId(parent.repo, pull);
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
          return store.pullMergeable(parent.repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        case 'files': {
          const first = intArg(args, 'first');
          const files = store.pullFiles(parent.repo, pull);
          const page = first === undefined ? files : files.slice(0, first);
          return {
            __typename: 'PullRequestChangedFileConnection',
            nodes: page.map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename })),
          } as GqlObject;
        }
        default:
          return undefined;
      }
    }
    case 'Ref':
      if (field.name === 'name') return parent.name;
      return undefined;
    case 'IssueConnection':
      if (field.name === 'nodes') return parent.nodes;
      if (field.name === 'pageInfo') return parent.pageInfo;
      return undefined;
    case 'PullRequestConnection':
      if (field.name === 'nodes') return parent.nodes;
      return undefined;
    case 'PullRequestChangedFileConnection':
      if (field.name === 'nodes') return parent.nodes;
      return undefined;
    case 'PullRequestChangedFile':
      if (field.name === 'path') return parent.path;
      return undefined;
    case '__Type':
      if (field.name === 'fields') return parent.fields.map((name) => ({ __typename: '__Field', name }));
      if (field.name === 'enumValues') return parent.enumValues.map((name) => ({ __typename: '__EnumValue', name }));
      if (field.name === 'name') return parent.name;
      return undefined;
    case '__Field':
    case '__EnumValue':
      if (field.name === 'name') return parent.name;
      return undefined;
    case 'IssueCommentEdge':
      if (field.name === 'node') return parent.node;
      return undefined;
    case 'CreateIssuePayload':
      if (field.name === 'issue') return parent.issue;
      return undefined;
    case 'CloseIssuePayload':
      if (field.name === 'issue') return parent.issue;
      return undefined;
    case 'CreatePullRequestPayload':
      if (field.name === 'pullRequest') return parent.pull;
      return undefined;
    case 'MergePullRequestPayload':
      if (field.name === 'pullRequest') return parent.pull;
      return undefined;
    case 'AddCommentPayload':
      if (field.name === 'commentEdge') return { __typename: 'IssueCommentEdge', node: parent.comment };
      return undefined;
    case 'IssueComment':
      if (field.name === 'id') return parent.id;
      if (field.name === 'body') return parent.body;
      return undefined;
    default:
      return undefined;
  }
}

// The pageInfo object is a plain record, not a GqlObject: resolve its fields here.
function resolvePlain(parent: Record<string, unknown>, field: FieldNode): unknown {
  if (field.name === 'hasNextPage') return parent.hasNextPage ?? false;
  if (field.name === 'endCursor') return parent.endCursor ?? null;
  return undefined;
}

// __Field and __EnumValue are plain records too.
function resolveNamed(parent: { name: string }, field: FieldNode): unknown {
  if (field.name === 'name') return parent.name;
  return undefined;
}

function isGqlObject(value: unknown): value is GqlObject {
  return typeof value === 'object' && value !== null && '__typename' in value && typeof (value as { __typename: unknown }).__typename === 'string';
}

function executeSelections(
  exec: Executor,
  parent: unknown,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
  path: Array<string | number>,
): Record<string, unknown> | null {
  if (parent === null || parent === undefined) return null;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      const typename = isGqlObject(parent) ? parent.__typename : null;
      if (typename === null || typename !== selection.fragment.typeCondition) continue;
      const nested = executeSelections(exec, parent, selection.fragment.selections, variables, path);
      if (nested !== null) Object.assign(out, nested);
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    const fieldPath = [...path, key];
    let value: unknown;
    try {
      if (field.name === '__typename') {
        value = isGqlObject(parent) ? parent.__typename : null;
      } else if (isGqlObject(parent)) {
        value = resolveField(exec, parent, field, variables);
      } else if (typeof parent === 'object' && parent !== null && ('hasNextPage' in parent || 'endCursor' in parent)) {
        value = resolvePlain(parent as Record<string, unknown>, field);
      } else if (typeof parent === 'object' && parent !== null && 'name' in parent && Object.keys(parent).length === 1) {
        value = resolveNamed(parent as { name: string }, field);
      } else {
        value = undefined;
      }
    } catch (err) {
      exec.errors.push({ message: err instanceof Error ? err.message : String(err), path: fieldPath });
      out[key] = null;
      continue;
    }
    if (value === undefined) {
      const typeName = isGqlObject(parent) ? parent.__typename : 'Query';
      exec.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".`, path: fieldPath });
      out[key] = null;
      continue;
    }
    if (field.selections === null) {
      out[key] = value;
    } else if (Array.isArray(value)) {
      out[key] = value.map((entry, index) => executeSelections(exec, entry, field.selections!, variables, [...fieldPath, index]));
    } else {
      out[key] = executeSelections(exec, value, field.selections, variables, fieldPath);
    }
  }
  return out;
}

function executeOperation(store: Store, operation: OperationNode, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors: Array<{ message: string }> } {
  const exec: Executor = { store, errors: [] };
  const root: GqlObject = operation.operation === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  let data: Record<string, unknown> | null = null;
  try {
    data = executeSelections(exec, root, operation.selections, variables, []);
  } catch (err) {
    exec.errors.push({ message: err instanceof Error ? err.message : String(err) });
    data = null;
  }
  return { data, errors: exec.errors };
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
    const variables = (record.variables ?? {}) as Record<string, unknown>;
    let operations: OperationNode[];
    try {
      operations = new Parser(lex(query)).parseDocument();
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    if (operations.length === 0) return { errors: [{ message: 'GraphQL document has no operation' }] };
    const result = executeOperation(store, operations[0]!, variables);
    const out: Record<string, unknown> = { data: result.data };
    if (result.errors.length > 0) out.errors = result.errors;
    return out;
  };
  if (Array.isArray(body)) {
    return jsonResult(200, body.map(runOne));
  }
  return jsonResult(200, runOne(body));
}
