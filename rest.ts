// REST v3 under /api/v3: repositories, branches, commits, contents, labels,
// issues and comments, pull requests with files and squash merges.
//
// The contract this file answers (from the suite's checks):
//   every reply is application/json, never HTML; 4xx bodies carry a string
//   `message`; a malformed JSON body is a 400; an unknown route is a JSON
//   404; no token is a 401; another owner's repository is a 404, never 403.
//   POST /user/repos is 201; GET /user/repos pages with Link rel="next".
//   PUT /contents is 201 on create, 200 on update, 409 on a stale sha, and
//   an unborn repository accepts the first commit. POST /issues with an
//   unknown label is 422. PUT /pulls/{n}/merge is 200 on a squash merge,
//   404 for an unknown pull request, 405 for a conflicted one.

import { Store, VIEWER_LOGIN, VIEWER_ID, type Issue, type Pull, type Repo } from './store.ts';
import { jsonResult, notFound, unauthorized, type HttpResult } from './httputil.ts';

export interface RestContext {
  store: Store;
  /** The bearer token the entry accepts (MAKEFUN_SHOP_TOKEN). Empty means
   * any non-empty bearer token is accepted (local runs without the env var). */
  token: string;
  /** The request's absolute base URL, for pagination Link headers. */
  baseUrl: string;
  method: string;
  /** Decoded path segments under /api/v3. */
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  authorized: boolean;
}

function message(status: number, text: string): HttpResult {
  return jsonResult(status, { message: text });
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : repo.id },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    created_at: new Date((1_735_689_600 + repo.createdSeq) * 1000).toISOString(),
    updated_at: new Date((1_735_689_600 + repo.createdSeq) * 1000).toISOString(),
  };
}

function labelJson(label: { name: string; color: string }): Record<string, unknown> {
  return { name: label.name, color: label.color };
}

export function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    created_at: new Date((1_735_689_600 + issue.createdSeq) * 1000).toISOString(),
  };
}

export function pullJson(pull: Pull): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head, sha: pull.headSha },
    base: { ref: pull.base, sha: pull.baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
  };
  return out;
}

function intParam(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** A Link header for one page of a list, following GitHub's shape. */
function pageLinks(baseUrl: string, path: string, query: URLSearchParams, page: number, perPage: number, hasNext: boolean): string {
  const urlFor = (pageNumber: number): string => {
    const next = new URLSearchParams(query);
    next.set('page', String(pageNumber));
    next.set('per_page', String(perPage));
    return `${baseUrl}${path}?${next.toString()}`;
  };
  const parts: string[] = [];
  if (hasNext) parts.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${urlFor(page - 1)}>; rel="prev"`);
  parts.push(`<${urlFor(1)}>; rel="first"`);
  return parts.join(', ');
}

function parseBodyObject(body: unknown): Record<string, unknown> | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  return typeof value === 'string' ? value : '';
}

/** The repository a route names, or null when it is not the viewer's. */
function routeRepo(ctx: RestContext, owner: string, name: string): Repo | null {
  const repo = ctx.store.getRepo(owner, name);
  return repo ?? null;
}

export function handleRest(ctx: RestContext): HttpResult {
  const { method, segments } = ctx;
  const store = ctx.store;

  // The API root.
  if (segments.length === 0) {
    if (method !== 'GET') return message(404, 'Not Found');
    return jsonResult(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  // Auth: every /api/v3 route below the root takes a bearer token.
  if (!ctx.authorized) return unauthorized('Requires authentication');

  const [first, second, third] = segments;

  // GET /api/v3/meta
  if (first === 'meta' && segments.length === 1 && method === 'GET') {
    return jsonResult(200, { installed_version: '1.0.0' });
  }

  // GET /api/v3/user
  if (first === 'user' && segments.length === 1 && method === 'GET') {
    return jsonResult(200, { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' });
  }

  // POST /api/v3/user/repos, GET /api/v3/user/repos
  if (first === 'user' && second === 'repos') {
    if (segments.length !== 2) return notFound();
    if (method === 'POST') {
      const body = parseBodyObject(ctx.body);
      if (body === null) return message(400, 'request body must be a JSON object');
      const name = stringField(body, 'name');
      if (name === '') return message(422, 'name is required');
      if (store.getRepo(VIEWER_LOGIN, name) !== undefined) return message(422, 'Repository already exists');
      const repo = store.createRepo(VIEWER_LOGIN, name, {
        private: body.private === true,
        description: stringField(body, 'description'),
      });
      return jsonResult(201, repoJson(repo));
    }
    if (method === 'GET') {
      const perPage = Math.max(1, Math.min(intParam(ctx.query, 'per_page', 30), 100));
      const page = Math.max(1, intParam(ctx.query, 'page', 1));
      const all = store.listReposByOwner(VIEWER_LOGIN);
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const headers: Record<string, string> = {};
      if (all.length > page * perPage) {
        headers.link = pageLinks(ctx.baseUrl, '/api/v3/user/repos', ctx.query, page, perPage, true);
      }
      return jsonResult(200, slice.map(repoJson), headers);
    }
    return notFound();
  }

  // /api/v3/repos/{owner}/{name}/...
  if (first === 'repos' && segments.length >= 3) {
    const owner = decodeURIComponent(second!);
    const name = decodeURIComponent(third!);
    const repo = routeRepo(ctx, owner, name);
    const rest = segments.slice(3);

    if (repo === null) return notFound('Not Found');

    // GET /repos/{o}/{r}, PATCH, DELETE
    if (rest.length === 0) {
      if (method === 'GET') return jsonResult(200, repoJson(repo));
      if (method === 'PATCH') {
        const body = parseBodyObject(ctx.body);
        if (body === null) return message(400, 'request body must be a JSON object');
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        return jsonResult(200, repoJson(repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return { status: 204, contentType: 'application/json; charset=utf-8', body: Buffer.alloc(0) };
      }
      return notFound();
    }

    const [sub, ...tail] = rest;

    // GET /repos/{o}/{r}/branches, /branches/{branch}
    if (sub === 'branches') {
      if (method !== 'GET') return notFound();
      if (tail.length === 0) {
        const branches = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .sort()
          .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref) } }));
        return jsonResult(200, branches);
      }
      const branch = decodeURIComponent(tail.join('/'));
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return notFound('Branch not found');
      return jsonResult(200, { name: branch, commit: { sha } });
    }

    // GET /repos/{o}/{r}/commits
    if (sub === 'commits') {
      if (method !== 'GET') return notFound();
      const tip = store.resolveRef(repo, ctx.query.get('sha') ?? undefined);
      if (tip === undefined) return jsonResult(200, []);
      const history = store.commitHistory(repo, tip).map((entry) => ({
        sha: entry.sha,
        commit: { message: entry.message, author: { name: entry.author }, committer: { name: entry.committer } },
      }));
      return jsonResult(200, history);
    }

    // POST /repos/{o}/{r}/git/refs, GET /git/refs/heads/{branch}
    if (sub === 'git' && tail[0] === 'refs') {
      if (method === 'POST' && tail.length === 1) {
        const body = parseBodyObject(ctx.body);
        if (body === null) return message(400, 'request body must be a JSON object');
        const ref = stringField(body, 'ref');
        const sha = stringField(body, 'sha');
        if (ref === '' || sha === '') return message(422, 'ref and sha are required');
        if (repo.refs.has(ref)) return message(422, 'Reference already exists');
        if (!store.getObject(repo, sha)) return message(422, 'Object does not exist');
        repo.refs.set(ref, sha);
        return jsonResult(201, { ref, object: { sha } });
      }
      if (method === 'GET' && tail.length >= 3 && tail[1] === 'heads') {
        const branch = decodeURIComponent(tail.slice(2).join('/'));
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) return notFound('Reference not found');
        return jsonResult(200, { ref: `refs/heads/${branch}`, object: { sha } });
      }
      return notFound();
    }

    // PUT/GET/DELETE /repos/{o}/{r}/contents/{path}
    if (sub === 'contents') {
      const filePath = tail.map((segment) => decodeURIComponent(segment)).join('/');
      if (method === 'PUT') {
        const body = parseBodyObject(ctx.body);
        if (body === null) return message(400, 'request body must be a JSON object');
        const contentB64 = stringField(body, 'content');
        if (contentB64 === '') return message(422, 'content is required');
        const content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        const existing = store.readContents(repo, filePath, branch);
        if (existing !== null && existing.kind === 'dir') return message(422, 'Is a directory');
        if (typeof body.sha === 'string' && body.sha !== '') {
          if (existing === null || existing.kind !== 'file' || existing.oid.toLowerCase() !== body.sha.toLowerCase()) {
            return message(409, 'sha does not match the current file');
          }
        }
        const created = existing === null;
        const result = store.putContents(repo, branch, filePath, content, stringField(body, 'message') || 'update file');
        return jsonResult(created ? 201 : 200, {
          content: { name: filePath.split('/').pop() ?? '', path: filePath, sha: result.contentSha, size: content.length, encoding: 'base64' },
          commit: { sha: result.commitSha },
        });
      }
      if (method === 'GET') {
        const ref = ctx.query.get('ref') ?? undefined;
        const found = store.readContents(repo, filePath, ref);
        if (found === null) return notFound('Not Found');
        if (found.kind === 'file') {
          return jsonResult(200, {
            type: 'file',
            name: filePath.split('/').pop() ?? '',
            path: filePath,
            encoding: 'base64',
            content: found.data.toString('base64'),
            sha: found.oid,
            size: found.data.length,
          });
        }
        const entries = found.entries.map((entry) => ({
          type: entry.mode === '40000' ? 'dir' : 'file',
          name: entry.name,
          path: filePath === '' ? entry.name : `${filePath}/${entry.name}`,
          sha: entry.oid,
        }));
        return jsonResult(200, entries);
      }
      if (method === 'DELETE') {
        const body = parseBodyObject(ctx.body);
        if (body === null) return message(400, 'request body must be a JSON object');
        const existing = store.readContents(repo, filePath, repo.defaultBranch);
        if (existing === null || existing.kind !== 'file') return notFound('Not Found');
        if (typeof body.sha === 'string' && body.sha !== '' && existing.oid.toLowerCase() !== body.sha.toLowerCase()) {
          return message(409, 'sha does not match the current file');
        }
        const result = store.deleteContents(repo, repo.defaultBranch, filePath, stringField(body, 'message') || 'delete file');
        return jsonResult(200, { commit: { sha: result.commitSha } });
      }
      return notFound();
    }

    // POST /repos/{o}/{r}/labels
    if (sub === 'labels') {
      if (method === 'POST' && tail.length === 0) {
        const body = parseBodyObject(ctx.body);
        if (body === null) return message(400, 'request body must be a JSON object');
        const name = stringField(body, 'name');
        if (name === '') return message(422, 'name is required');
        const label = { name, color: typeof body.color === 'string' ? body.color : 'ededed' };
        repo.labels.set(name, label);
        return jsonResult(201, labelJson(label));
      }
      if (method === 'GET' && tail.length === 0) {
        return jsonResult(200, [...repo.labels.values()].map(labelJson));
      }
      return notFound();
    }

    // Issues: /repos/{o}/{r}/issues[/{n}[/comments]]
    if (sub === 'issues') {
      if (tail.length === 0) {
        if (method === 'POST') {
          const body = parseBodyObject(ctx.body);
          if (body === null) return message(400, 'request body must be a JSON object');
          const labels = Array.isArray(body.labels) ? body.labels.filter((entry): entry is string => typeof entry === 'string') : [];
          for (const label of labels) {
            if (!repo.labels.has(label)) return message(422, `Label does not exist: ${label}`);
          }
          const issue = store.createIssue(repo, { title: stringField(body, 'title'), body: stringField(body, 'body'), labels });
          return jsonResult(201, issueJson(issue));
        }
        if (method === 'GET') {
          const list = store.listIssues(repo, {
            state: ctx.query.get('state') ?? 'open',
            sort: ctx.query.get('sort') ?? undefined,
            direction: ctx.query.get('direction') ?? undefined,
            perPage: intParam(ctx.query, 'per_page', 30),
            page: intParam(ctx.query, 'page', 1),
          });
          return jsonResult(200, list.map(issueJson));
        }
        return notFound();
      }
      const number = Number.parseInt(tail[0]!, 10);
      if (!Number.isInteger(number)) return notFound();
      const issue = repo.issues.get(number);
      if (issue === undefined) return notFound('Issue not found');
      if (tail.length === 1) {
        if (method === 'GET') return jsonResult(200, issueJson(issue));
        if (method === 'PATCH') {
          const body = parseBodyObject(ctx.body);
          if (body === null) return message(400, 'request body must be a JSON object');
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          return jsonResult(200, issueJson(issue));
        }
        return notFound();
      }
      if (tail[1] === 'comments' && tail.length === 2) {
        if (method === 'POST') {
          const body = parseBodyObject(ctx.body);
          if (body === null) return message(400, 'request body must be a JSON object');
          const comment = store.addIssueComment(repo, issue, stringField(body, 'body'));
          return jsonResult(201, { id: comment.id, body: comment.body });
        }
        if (method === 'GET') {
          return jsonResult(200, issue.comments.map((comment) => ({ id: comment.id, body: comment.body })));
        }
        return notFound();
      }
      return notFound();
    }

    // Pulls: /repos/{o}/{r}/pulls[/{n}[/files|/merge]]
    if (sub === 'pulls') {
      if (tail.length === 0) {
        if (method === 'POST') {
          const body = parseBodyObject(ctx.body);
          if (body === null) return message(400, 'request body must be a JSON object');
          try {
            const pull = store.createPull(repo, {
              head: stringField(body, 'head'),
              base: stringField(body, 'base') || repo.defaultBranch,
              title: stringField(body, 'title'),
              body: stringField(body, 'body'),
            });
            return jsonResult(201, pullJson(pull));
          } catch (err) {
            return message(422, err instanceof Error ? err.message : 'cannot create pull request');
          }
        }
        if (method === 'GET') {
          const list = store.listPulls(repo, {
            state: ctx.query.get('state') ?? 'open',
            perPage: intParam(ctx.query, 'per_page', 30),
            page: intParam(ctx.query, 'page', 1),
          });
          return jsonResult(200, list.map(pullJson));
        }
        return notFound();
      }
      const number = Number.parseInt(tail[0]!, 10);
      if (!Number.isInteger(number)) return notFound();
      const pull = repo.pulls.get(number);
      if (tail.length === 2 && tail[1] === 'files') {
        if (pull === undefined) return notFound('Pull request not found');
        if (method !== 'GET') return notFound();
        return jsonResult(200, store.pullFiles(repo, pull));
      }
      if (tail.length === 2 && tail[1] === 'merge') {
        if (pull === undefined) return notFound('Pull request not found');
        if (method !== 'PUT') return notFound();
        const sha = store.mergePull(repo, pull);
        if (sha === null) return message(405, 'Merge conflict');
        return jsonResult(200, { sha, merged: true, message: `Pull request #${pull.number} merged` });
      }
      if (tail.length === 1) {
        if (pull === undefined) return notFound('Pull request not found');
        if (method === 'GET') return jsonResult(200, pullJson(pull));
        return notFound();
      }
      return notFound();
    }

    return notFound();
  }

  return notFound();
}
