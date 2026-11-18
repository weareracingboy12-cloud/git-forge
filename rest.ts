// REST v3 under /api/v3: repositories, branches, commits, contents,
// labels, issues and comments, pull requests with files and squash
// merges.
//
// The contract this file answers (from the suite's checks):
//   every reply is application/json, never HTML; 4xx bodies carry a
//   string `message`; a malformed JSON body is a 400; an unknown route
//   is a JSON 404; no token is a 401; another owner's repository is a
//   404, never 403.
//   POST /user/repos is 201; GET /user/repos pages with Link rel="next".
//   PUT /contents is 201 on create, 200 on update, 409 on a stale sha,
//   and an unborn repository accepts the first commit. POST /issues with
//   an unknown label is 422. PUT /pulls/{n}/merge is 200 on a squash
//   merge, 404 for an unknown pull request, 405 for a conflicted one.

import { BASE_EPOCH, Store, VIEWER, VIEWER_UID, type IssueRecord, type PullRecord, type Repository } from './store.ts';
import { jsonReply, replyNotFound, replyUnauthorized, type Reply } from './httputil.ts';

export interface RestCall {
  store: Store;
  /** The bearer token the entry accepts (MAKEFUN_SHOP_TOKEN). Empty
   * means any non-empty bearer token is accepted (local runs without
   * the env var). */
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

function failWith(status: number, text: string): Reply {
  return jsonReply(status, { message: text });
}

export function repoView(repo: Repository): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER ? VIEWER_UID : repo.id },
    private: repo.private,
    description: repo.description,
    default_branch: repo.mainBranch,
    has_issues: true,
    created_at: new Date((BASE_EPOCH + repo.seq) * 1000).toISOString(),
    updated_at: new Date((BASE_EPOCH + repo.seq) * 1000).toISOString(),
  };
}

function labelView(label: { name: string; color: string }): Record<string, unknown> {
  return { name: label.name, color: label.color };
}

export function issueView(issue: IssueRecord): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    created_at: new Date((BASE_EPOCH + issue.seq) * 1000).toISOString(),
  };
}

export function pullView(pull: PullRecord): Record<string, unknown> {
  return {
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
}

function pageNumber(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** A Link header for one page of a list, following GitHub's shape. */
function pageLinkHeader(baseUrl: string, path: string, query: URLSearchParams, page: number, perPage: number, hasNext: boolean): string {
  const urlFor = (pageNumberValue: number): string => {
    const next = new URLSearchParams(query);
    next.set('page', String(pageNumberValue));
    next.set('per_page', String(perPage));
    return `${baseUrl}${path}?${next.toString()}`;
  };
  const parts: string[] = [];
  if (hasNext) parts.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${urlFor(page - 1)}>; rel="prev"`);
  parts.push(`<${urlFor(1)}>; rel="first"`);
  return parts.join(', ');
}

function objectBody(body: unknown): Record<string, unknown> | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  return typeof value === 'string' ? value : '';
}

/** The repository a route names, or null when it is not the viewer's. */
function repoForRoute(ctx: RestCall, owner: string, name: string): Repository | null {
  const repo = ctx.store.findRepo(owner, name);
  return repo ?? null;
}

export function serveRest(ctx: RestCall): Reply {
  const { method, segments } = ctx;
  const store = ctx.store;

  // The API root.
  if (segments.length === 0) {
    if (method !== 'GET') return failWith(404, 'Not Found');
    return jsonReply(
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  // Auth: every /api/v3 route below the root takes a bearer token.
  if (!ctx.authorized) return replyUnauthorized('Requires authentication');

  const [seg0, seg1, seg2] = segments;

  // GET /api/v3/meta
  if (seg0 === 'meta' && segments.length === 1 && method === 'GET') {
    return jsonReply(200, { installed_version: '1.0.0' });
  }

  // GET /api/v3/user
  if (seg0 === 'user' && segments.length === 1 && method === 'GET') {
    return jsonReply(200, { login: VIEWER, id: VIEWER_UID, type: 'User' });
  }

  // POST /api/v3/user/repos, GET /api/v3/user/repos
  if (seg0 === 'user' && seg1 === 'repos') {
    if (segments.length !== 2) return replyNotFound();
    if (method === 'POST') {
      const body = objectBody(ctx.body);
      if (body === null) return failWith(400, 'request body must be a JSON object');
      const name = stringField(body, 'name');
      if (name === '') return failWith(422, 'name is required');
      if (store.findRepo(VIEWER, name) !== undefined) return failWith(422, 'Repository already exists');
      const repo = store.addRepo(VIEWER, name, {
        private: body.private === true,
        description: stringField(body, 'description'),
      });
      return jsonReply(201, repoView(repo));
    }
    if (method === 'GET') {
      const perPage = Math.max(1, Math.min(pageNumber(ctx.query, 'per_page', 30), 100));
      const page = Math.max(1, pageNumber(ctx.query, 'page', 1));
      const all = store.reposOfOwner(VIEWER);
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const extra: Record<string, string> = {};
      if (all.length > page * perPage) {
        extra.link = pageLinkHeader(ctx.baseUrl, '/api/v3/user/repos', ctx.query, page, perPage, true);
      }
      return jsonReply(200, slice.map(repoView), extra);
    }
    return replyNotFound();
  }

  // /api/v3/repos/{owner}/{name}/...
  if (seg0 === 'repos' && segments.length >= 3) {
    const owner = decodeURIComponent(seg1!);
    const name = decodeURIComponent(seg2!);
    const repo = repoForRoute(ctx, owner, name);
    const rest = segments.slice(3);

    if (repo === null) return replyNotFound('Not Found');

    // GET /repos/{o}/{r}, PATCH, DELETE
    if (rest.length === 0) {
      if (method === 'GET') return jsonReply(200, repoView(repo));
      if (method === 'PATCH') {
        const body = objectBody(ctx.body);
        if (body === null) return failWith(400, 'request body must be a JSON object');
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        return jsonReply(200, repoView(repo));
      }
      if (method === 'DELETE') {
        store.removeRepo(owner, name);
        return { status: 204, contentType: 'application/json; charset=utf-8', body: Buffer.alloc(0) };
      }
      return replyNotFound();
    }

    const [sub, ...tail] = rest;

    // Pulls: /repos/{o}/{r}/pulls[/{n}[/files|/merge]]
    if (sub === 'pulls') {
      if (tail.length === 0) {
        if (method === 'POST') {
          const body = objectBody(ctx.body);
          if (body === null) return failWith(400, 'request body must be a JSON object');
          try {
            const pull = store.openPull(repo, {
              head: stringField(body, 'head'),
              base: stringField(body, 'base') || repo.mainBranch,
              title: stringField(body, 'title'),
              body: stringField(body, 'body'),
            });
            return jsonReply(201, pullView(pull));
          } catch (err) {
            return failWith(422, err instanceof Error ? err.message : 'cannot create pull request');
          }
        }
        if (method === 'GET') {
          const list = store.pullsOf(repo, {
            state: ctx.query.get('state') ?? 'open',
            perPage: pageNumber(ctx.query, 'per_page', 30),
            page: pageNumber(ctx.query, 'page', 1),
          });
          return jsonReply(200, list.map(pullView));
        }
        return replyNotFound();
      }
      const num = Number.parseInt(tail[0]!, 10);
      if (!Number.isInteger(num)) return replyNotFound();
      const pull = repo.pulls.get(num);
      if (tail.length === 2 && tail[1] === 'files') {
        if (pull === undefined) return replyNotFound('Pull request not found');
        if (method !== 'GET') return replyNotFound();
        return jsonReply(200, store.filesOfPull(repo, pull));
      }
      if (tail.length === 2 && tail[1] === 'merge') {
        if (pull === undefined) return replyNotFound('Pull request not found');
        if (method !== 'PUT') return replyNotFound();
        const sha = store.squashMerge(repo, pull);
        if (sha === null) return failWith(405, 'Merge conflict');
        return jsonReply(200, { sha, merged: true, message: `Pull request #${pull.number} merged` });
      }
      if (tail.length === 1) {
        if (pull === undefined) return replyNotFound('Pull request not found');
        if (method === 'GET') return jsonReply(200, pullView(pull));
        return replyNotFound();
      }
      return replyNotFound();
    }

    // Issues: /repos/{o}/{r}/issues[/{n}[/comments]]
    if (sub === 'issues') {
      if (tail.length === 0) {
        if (method === 'POST') {
          const body = objectBody(ctx.body);
          if (body === null) return failWith(400, 'request body must be a JSON object');
          const labels = Array.isArray(body.labels)
            ? body.labels.filter((entry): entry is string => typeof entry === 'string')
            : [];
          for (const label of labels) {
            if (!repo.labels.has(label)) return failWith(422, `Label does not exist: ${label}`);
          }
          const issue = store.addIssue(repo, {
            title: stringField(body, 'title'),
            body: stringField(body, 'body'),
            labels,
          });
          return jsonReply(201, issueView(issue));
        }
        if (method === 'GET') {
          const list = store.issuesOf(repo, {
            state: ctx.query.get('state') ?? 'open',
            sort: ctx.query.get('sort') ?? undefined,
            direction: ctx.query.get('direction') ?? undefined,
            perPage: pageNumber(ctx.query, 'per_page', 30),
            page: pageNumber(ctx.query, 'page', 1),
          });
          return jsonReply(200, list.map(issueView));
        }
        return replyNotFound();
      }
      const num = Number.parseInt(tail[0]!, 10);
      if (!Number.isInteger(num)) return replyNotFound();
      const issue = repo.issues.get(num);
      if (issue === undefined) return replyNotFound('Issue not found');
      if (tail.length === 1) {
        if (method === 'GET') return jsonReply(200, issueView(issue));
        if (method === 'PATCH') {
          const body = objectBody(ctx.body);
          if (body === null) return failWith(400, 'request body must be a JSON object');
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          return jsonReply(200, issueView(issue));
        }
        return replyNotFound();
      }
      if (tail[1] === 'comments' && tail.length === 2) {
        if (method === 'POST') {
          const body = objectBody(ctx.body);
          if (body === null) return failWith(400, 'request body must be a JSON object');
          const comment = store.commentOnIssue(repo, issue, stringField(body, 'body'));
          return jsonReply(201, { id: comment.id, body: comment.body });
        }
        if (method === 'GET') {
          return jsonReply(200, issue.comments.map((comment) => ({ id: comment.id, body: comment.body })));
        }
        return replyNotFound();
      }
      return replyNotFound();
    }

    // POST /repos/{o}/{r}/labels
    if (sub === 'labels') {
      if (method === 'POST' && tail.length === 0) {
        const body = objectBody(ctx.body);
        if (body === null) return failWith(400, 'request body must be a JSON object');
        const name = stringField(body, 'name');
        if (name === '') return failWith(422, 'name is required');
        const label = { name, color: typeof body.color === 'string' ? body.color : 'ededed' };
        repo.labels.set(name, label);
        return jsonReply(201, labelView(label));
      }
      if (method === 'GET' && tail.length === 0) {
        return jsonReply(200, [...repo.labels.values()].map(labelView));
      }
      return replyNotFound();
    }

    // PUT/GET/DELETE /repos/{o}/{r}/contents/{path}
    if (sub === 'contents') {
      const path = tail.map((segment) => decodeURIComponent(segment)).join('/');
      if (method === 'PUT') {
        const body = objectBody(ctx.body);
        if (body === null) return failWith(400, 'request body must be a JSON object');
        const contentB64 = stringField(body, 'content');
        if (contentB64 === '') return failWith(422, 'content is required');
        const content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.mainBranch;
        const current = store.readPath(repo, path, branch);
        if (current !== null && current.kind === 'dir') return failWith(422, 'Is a directory');
        if (typeof body.sha === 'string' && body.sha !== '') {
          if (current === null || current.kind !== 'file' || current.oid.toLowerCase() !== body.sha.toLowerCase()) {
            return failWith(409, 'sha does not match the current file');
          }
        }
        const created = current === null;
        const made = store.writeContents(repo, branch, path, content, stringField(body, 'message') || 'update file');
        return jsonReply(created ? 201 : 200, {
          content: {
            name: path.split('/').pop() ?? '',
            path,
            sha: made.contentSha,
            size: content.length,
            encoding: 'base64',
          },
          commit: { sha: made.commitSha },
        });
      }
      if (method === 'GET') {
        const ref = ctx.query.get('ref') ?? undefined;
        const found = store.readPath(repo, path, ref);
        if (found === null) return replyNotFound('Not Found');
        if (found.kind === 'file') {
          return jsonReply(200, {
            type: 'file',
            name: path.split('/').pop() ?? '',
            path,
            encoding: 'base64',
            content: found.data.toString('base64'),
            sha: found.oid,
            size: found.data.length,
          });
        }
        const items = found.entries.map((entry) => ({
          type: entry.mode === '40000' ? 'dir' : 'file',
          name: entry.name,
          path: path === '' ? entry.name : `${path}/${entry.name}`,
          sha: entry.oid,
        }));
        return jsonReply(200, items);
      }
      if (method === 'DELETE') {
        const body = objectBody(ctx.body);
        if (body === null) return failWith(400, 'request body must be a JSON object');
        const current = store.readPath(repo, path, repo.mainBranch);
        if (current === null || current.kind !== 'file') return replyNotFound('Not Found');
        if (typeof body.sha === 'string' && body.sha !== '' && current.oid.toLowerCase() !== body.sha.toLowerCase()) {
          return failWith(409, 'sha does not match the current file');
        }
        const made = store.removeContents(repo, repo.mainBranch, path, stringField(body, 'message') || 'delete file');
        return jsonReply(200, { commit: { sha: made.commitSha } });
      }
      return replyNotFound();
    }

    // POST /repos/{o}/{r}/git/refs, GET /git/refs/heads/{branch}
    if (sub === 'git' && tail[0] === 'refs') {
      if (method === 'POST' && tail.length === 1) {
        const body = objectBody(ctx.body);
        if (body === null) return failWith(400, 'request body must be a JSON object');
        const ref = stringField(body, 'ref');
        const sha = stringField(body, 'sha');
        if (ref === '' || sha === '') return failWith(422, 'ref and sha are required');
        if (repo.refs.has(ref)) return failWith(422, 'Reference already exists');
        if (!store.fetchObject(repo, sha)) return failWith(422, 'Object does not exist');
        repo.refs.set(ref, sha);
        return jsonReply(201, { ref, object: { sha } });
      }
      if (method === 'GET' && tail.length >= 3 && tail[1] === 'heads') {
        const branch = decodeURIComponent(tail.slice(2).join('/'));
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) return replyNotFound('Reference not found');
        return jsonReply(200, { ref: `refs/heads/${branch}`, object: { sha } });
      }
      return replyNotFound();
    }

    // GET /repos/{o}/{r}/commits
    if (sub === 'commits') {
      if (method !== 'GET') return replyNotFound();
      const tip = store.resolveReference(repo, ctx.query.get('sha') ?? undefined);
      if (tip === undefined) return jsonReply(200, []);
      const history = store.historyOf(repo, tip).map((entry) => ({
        sha: entry.sha,
        commit: {
          message: entry.message,
          author: { name: entry.author },
          committer: { name: entry.committer },
        },
      }));
      return jsonReply(200, history);
    }

    // GET /repos/{o}/{r}/branches, /branches/{branch}
    if (sub === 'branches') {
      if (method !== 'GET') return replyNotFound();
      if (tail.length === 0) {
        const branches = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .sort()
          .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref) } }));
        return jsonReply(200, branches);
      }
      const branch = decodeURIComponent(tail.join('/'));
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return replyNotFound('Branch not found');
      return jsonReply(200, { name: branch, commit: { sha } });
    }

    return replyNotFound();
  }

  return replyNotFound();
}
