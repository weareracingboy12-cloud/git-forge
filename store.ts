// The store: every object the forge holds, in memory. One process, one
// store, no disk. Determinism is a design rule here: timestamps and
// request ids come from monotonic counters seeded at a fixed epoch, never
// from the wall clock or Math.random, so a replayed trial reaches the
// same state.
//
// The store owns the git object graph too (objects and refs per
// repository), the contents-API commit builder, the three-way merge, and
// the issue and pull-request records the REST, GraphQL and MCP surfaces
// all read.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitobj.ts';

/** The login the bearer token names: the scenario's viewer, fixed by the
 * kit's SCENARIO_SEED (wire.ts: "the contest's fixed data"). Verified by
 * running the kit's own generator: viewer login `adaiversen`, id 1000. */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;

/** The fixed epoch every timestamp derives from: 2025-01-01T00:00:00Z. */
export const EPOCH_SEC = 1_735_689_600;

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  comments: IssueComment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  first: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  nextNumber: number;
}

function signLine(when: number): string {
  return `${VIEWER_LOGIN} <${VIEWER_LOGIN}@example.invalid> ${when} +0000`;
}

/** Count the lines of `text`: a trailing newline does not start a new
 * sig. */
export function countLines(text: string): number {
  if (text === '') return 0;
  const split = text.split('\n');
  return text.endsWith('\n') ? split.length - 1 : split.length;
}

/** Line additions and deletions between two texts, by multiset
 * difference. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const count = (text: string): Map<string, number> => {
    const counts = new Map<string, number>();
    if (text === '') return counts;
    const lines = text.split('\n');
    if (text.endsWith('\n')) lines.pop();
    for (const sig of lines) counts.set(sig, (counts.get(sig) ?? 0) + 1);
    return counts;
  };
  const oldCounts = count(oldText);
  const newCounts = count(newText);
  let additions = 0;
  let deletions = 0;
  for (const [sig, n] of newCounts) additions += Math.max(0, n - (oldCounts.get(sig) ?? 0));
  for (const [sig, n] of oldCounts) deletions += Math.max(0, n - (newCounts.get(sig) ?? 0));
  return { additions, deletions };
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private seqId = 5000;
  private tickCount = 0;
  private reqCount = 0;

  /** The next stable numeric id (repos, issues, pulls, comments share
   * it). */
  nextId(): number {
    this.seqId += 1;
    return this.seqId;
  }

  /** Advance the deterministic clock and answer the new sequence
   * number. */
  tick(): number {
    this.tickCount += 1;
    return this.tickCount;
  }

  /** The deterministic "now": the fixed epoch plus the sequence, as
   * ISO. */
  nowIso(): string {
    return new Date((EPOCH_SEC + this.tickCount) * 1000).toISOString();
  }

  /** A request id for X-GitHub-Request-Id: monotonic, never empty. */
  requestId(): string {
    this.reqCount += 1;
    return `req-${this.reqCount}`;
  }

  // ---------------------------------------------------------------- repos

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, options: { private?: boolean; description?: string } = {}): Repo {
    const entry: Repo = {
      id: this.nextId(),
      owner,
      name,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: 'main',
      createdSeq: this.tick(),
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
    };
    this.repos.set(this.repoKey(owner, name), entry);
    return entry;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listReposByOwner(owner: string): Repo[] {
    return [...this.repos.values()]
      .filter((repo) => repo.owner === owner)
      .sort((a, b) => a.createdSeq - b.createdSeq);
  }

  // ------------------------------------------------------------ git objects

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** The commit object at `oid`, parsed; undefined when absent or not a
   * commit. */
  readCommit(repo: Repo, oid: string): ReturnType<typeof parseCommit> | undefined {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return undefined;
    return parseCommit(object.data);
  }

  /** The tree oid a commit names; undefined when the commit is
   * unknown. */
  commitTree(repo: Repo, commitOid: string): string | undefined {
    return this.readCommit(repo, commitOid)?.tree;
  }

  /** The tree entries at `treeOid`; [] when the tree is unknown. */
  treeEntries(repo: Repo, treeOid: string): TreeEntry[] {
    const object = repo.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return [];
    return parseTree(object.data);
  }

  /** Walk `segments` down from `treeOid`: the final entry, or null. */
  resolvePath(repo: Repo, treeOid: string, segments: readonly string[]): { oid: string; mode: string } | null {
    let current = treeOid;
    for (let i = 0; i < segments.length; i += 1) {
      const entries = this.treeEntries(repo, current);
      const entry = entries.find((candidate) => candidate.name === segments[i]);
      if (entry === undefined) return null;
      if (i === segments.length - 1) return { oid: entry.oid, mode: entry.mode };
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return null;
  }

  /** A tree like `treeOid` but with `segments` set to `blob`
   * (creating intermediate directories). `treeOid` may be null for an
   * empty tree. */
  setPath(repo: Repo, treeOid: string | null, segments: readonly string[], blob: string): string {
    const entries = treeOid === null ? [] : this.treeEntries(repo, treeOid);
    const first = segments[0]!;
    const others = entries.filter((entry) => entry.name !== first);
    if (segments.length === 1) {
      others.push({ mode: '100644', name: first, oid: blob });
    } else {
      const sub = entries.find((entry) => entry.name === first && entry.mode === '40000');
      const nested = this.setPath(repo, sub?.oid ?? null, segments.slice(1), blob);
      others.push({ mode: '40000', name: first, oid: nested });
    }
    return this.putObject(repo, 'tree', buildTree(others));
  }

  /** A tree like `treeOid` but with `segments` removed. */
  removePath(repo: Repo, treeOid: string, segments: readonly string[]): string {
    const entries = this.treeEntries(repo, treeOid);
    const first = segments[0]!;
    if (segments.length === 1) {
      return this.putObject(repo, 'tree', buildTree(entries.filter((entry) => entry.name !== first)));
    }
    const sub = entries.find((entry) => entry.name === first && entry.mode === '40000');
    if (sub === undefined) return treeOid;
    const nested = this.removePath(repo, sub.oid, segments.slice(1));
    const others = entries.filter((entry) => entry.name !== first);
    others.push({ mode: '40000', name: first, oid: nested });
    return this.putObject(repo, 'tree', buildTree(others));
  }

  /** Every blob under `treeOid`, as path -> {oid}. */
  flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string }> {
    const acc = new Map<string, { oid: string }>();
    for (const entry of this.treeEntries(repo, treeOid)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') {
        for (const [nested, value] of this.flattenTree(repo, entry.oid, path)) acc.set(nested, value);
      } else {
        acc.set(path, { oid: entry.oid });
      }
    }
    return acc;
  }

  /** Build a tree from a flat path -> blob oid map. */
  buildTreeFromPaths(repo: Repo, files: ReadonlyMap<string, string>): string {
    const build = (allPaths: ReadonlyMap<string, string>): string => {
      const byDir = new Map<string, Map<string, string>>();
      const plain: TreeEntry[] = [];
      for (const [path, oid] of allPaths) {
        const sep = path.indexOf('/');
        if (sep === -1) {
          plain.push({ mode: '100644', name: path, oid });
        } else {
          const first = path.slice(0, sep);
          const tail = path.slice(sep + 1);
          let bucket = byDir.get(first);
          if (bucket === undefined) {
            bucket = new Map();
            byDir.set(first, bucket);
          }
          bucket.set(tail, oid);
        }
      }
      const entries = [...plain];
      for (const [name, bucket] of byDir) entries.push({ mode: '40000', name, oid: build(bucket) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(files);
  }

  /** All commit ancestors of `start` (including `start`), newest-first. */
  ancestors(repo: Repo, start: string): Set<string> {
    const done = new Set<string>();
    const todo = [start];
    while (todo.length > 0) {
      const oid = todo.pop()!;
      if (done.has(oid)) continue;
      const commit = this.readCommit(repo, oid);
      if (commit === undefined) continue;
      done.add(oid);
      for (const parent of commit.parents) todo.push(parent);
    }
    return done;
  }

  /** Whether `ancestor` is an ancestor of `descendant` (or equal to
   * it). */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    return this.ancestors(repo, descendant).has(ancestor);
  }

  /** The merge base of two commits: the first common ancestor entry
   * walking from `b` through the ancestors of `a`. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsOfA = this.ancestors(repo, a);
    const frontier = [b];
    const done = new Set<string>();
    while (frontier.length > 0) {
      const oid = frontier.shift()!;
      if (done.has(oid)) continue;
      done.add(oid);
      if (ancestorsOfA.has(oid)) return oid;
      const commit = this.readCommit(repo, oid);
      if (commit === undefined) continue;
      frontier.push(...commit.parents);
    }
    return null;
  }

  /** Create a commit object (author and committer are the viewer, at
   * the deterministic clock) and store it. */
  createCommit(repo: Repo, options: { tree: string; parents: string[]; message: string }): string {
    const when = EPOCH_SEC + this.tick();
    const sig = signLine(when);
    const data = buildCommit({
      tree: options.tree,
      parents: options.parents,
      author: sig,
      committer: sig,
      message: options.message,
    });
    return this.putObject(repo, 'commit', data);
  }

  /** Resolve a ref-ish to a commit oid: a branch name, a full ref, or a
   * raw object id. `defaultBranch` is used when `ref` is undefined. */
  resolveRef(repo: Repo, ref: string | undefined): string | undefined {
    if (ref === undefined) return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (repo.refs.has(ref)) return repo.refs.get(ref);
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch !== undefined) return branch;
    if (repo.objects.has(ref)) return ref;
    return undefined;
  }

  /** The commit history walking back from `first` (first-parent order is
   * the same as parent order here: every commit has at most one parent
   * in the histories this forge builds, but the walk follows all
   * parents). */
  commitHistory(repo: Repo, first: string): Array<{ sha: string; message: string; author: string; committer: string }> {
    const rows: Array<{ sha: string; message: string; author: string; committer: string }> = [];
    const done = new Set<string>();
    const frontier = [first];
    while (frontier.length > 0) {
      const oid = frontier.shift()!;
      if (done.has(oid)) continue;
      done.add(oid);
      const commit = this.readCommit(repo, oid);
      if (commit === undefined) continue;
      rows.push({ sha: oid, message: commit.message, author: commit.author, committer: commit.committer });
      frontier.push(...commit.parents);
    }
    return rows;
  }

  // ------------------------------------------------------------- contents

  /** Commit `content` at `path` on `branch` (creating the branch from
   * the default head when it does not exist yet). */
  putContents(repo: Repo, branch: string, path: string, content: Buffer, message: string): { commitSha: string; contentSha: string } {
    const blob = this.putObject(repo, 'blob', content);
    let first = repo.refs.get(`refs/heads/${branch}`);
    if (first === undefined) first = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const parent = first === undefined ? null : this.commitTree(repo, first);
    const tree = this.setPath(repo, parent ?? null, path.split('/'), blob);
    const commitSha = this.createCommit(repo, { tree, parents: first === undefined ? [] : [first], message });
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha, contentSha: blob };
  }

  /** Remove `path` from `branch` with a commit. */
  deleteContents(repo: Repo, branch: string, path: string, message: string): { commitSha: string } {
    const first = repo.refs.get(`refs/heads/${branch}`);
    if (first === undefined) throw new Error('branch has no commit');
    const parent = this.commitTree(repo, first);
    if (parent === undefined) throw new Error('branch first is not a commit');
    const tree = this.removePath(repo, parent, path.split('/'));
    const commitSha = this.createCommit(repo, { tree, parents: [first], message });
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha };
  }

  /** Read a path at a ref: a file, a directory listing, or null. */
  readContents(
    repo: Repo,
    path: string,
    ref: string | undefined,
  ): { kind: 'file'; oid: string; data: Buffer } | { kind: 'sub'; entries: TreeEntry[] } | null {
    const first = this.resolveRef(repo, ref);
    if (first === undefined) return null;
    const tree = this.commitTree(repo, first);
    if (tree === undefined) return null;
    const segments = path === '' ? [] : path.split('/');
    if (segments.length === 0) return { kind: 'sub', entries: this.treeEntries(repo, tree) };
    const entry = this.resolvePath(repo, tree, segments);
    if (entry === null) return null;
    if (entry.mode === '40000') return { kind: 'sub', entries: this.treeEntries(repo, entry.oid) };
    const object = repo.objects.get(entry.oid);
    if (object === undefined || object.type !== 'blob') return null;
    return { kind: 'file', oid: entry.oid, data: object.data };
  }

  // --------------------------------------------------------------- issues

  createIssue(repo: Repo, input: { title: string; body: string; labels?: string[] }): Issue {
    const rec: Issue = {
      id: this.nextId(),
      number: repo.nextNumber,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels: [...(input.labels ?? [])],
      createdSeq: this.tick(),
      comments: [],
    };
    repo.nextNumber += 1;
    repo.issues.set(rec.number, rec);
    return rec;
  }

  listIssues(
    repo: Repo,
    options: { state?: string; sort?: string; direction?: string; perPage?: number; page?: number } = {},
  ): Issue[] {
    const state = options.state ?? 'open';
    let rows = [...repo.issues.values()];
    if (state !== 'all') rows = rows.filter((rec) => rec.state === state);
    const direction = options.direction ?? 'desc';
    rows.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
    const perPage = Math.max(1, Math.min(options.perPage ?? 30, 100));
    const page = Math.max(1, options.page ?? 1);
    return rows.slice((page - 1) * perPage, page * perPage);
  }

  addIssueComment(repo: Repo, rec: Issue, body: string): IssueComment {
    const comment: IssueComment = { id: this.nextId(), body, createdSeq: this.tick() };
    rec.comments.push(comment);
    return comment;
  }

  // ----------------------------------------------------------------- pulls

  createPull(repo: Repo, input: { first: string; base: string; title: string; body: string }): Pull {
    const headSha = repo.refs.get(`refs/heads/${input.head}`);
    const baseSha = repo.refs.get(`refs/heads/${input.base}`);
    if (headSha === undefined) throw new Error(`head branch ${input.head} does not exist`);
    if (baseSha === undefined) throw new Error(`base branch ${input.base} does not exist`);
    for (const other of repo.pulls.values()) {
      if (other.state === 'open' && other.head === input.head && other.base === input.base) {
        throw new Error('a pr request is already open for this first and base');
      }
    }
    const pr: Pull = {
      id: this.nextId(),
      number: repo.nextNumber,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      head: input.head,
      base: input.base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: this.tick(),
    };
    repo.nextNumber += 1;
    repo.pulls.set(pr.number, pr);
    return pr;
  }

  listPulls(repo: Repo, options: { state?: string; perPage?: number; page?: number } = {}): Pull[] {
    const state = options.state ?? 'open';
    let rows = [...repo.pulls.values()];
    if (state !== 'all') rows = rows.filter((pr) => pr.state === state);
    rows.sort((a, b) => b.createdSeq - a.createdSeq);
    const perPage = Math.max(1, Math.min(options.perPage ?? 30, 100));
    const page = Math.max(1, options.page ?? 1);
    return rows.slice((page - 1) * perPage, page * perPage);
  }

  /** The file changes between a pr request's base first and first first. */
  pullFiles(repo: Repo, pr: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const fromTree = this.commitTree(repo, pr.baseSha);
    const toTree = this.commitTree(repo, pr.headSha);
    const baseMap = fromTree === undefined ? new Map() : this.flattenTree(repo, fromTree);
    const headMap = toTree === undefined ? new Map() : this.flattenTree(repo, toTree);
    const rows: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    const allPaths = new Set([...baseMap.keys(), ...headMap.keys()]);
    for (const path of [...allPaths].sort()) {
      const oldFile = baseMap.get(path);
      const newFile = headMap.get(path);
      if (oldFile === undefined && newFile !== undefined) {
        const blob = repo.objects.get(newFile.oid);
        const text = blob?.type === 'blob' ? blob.data.toString('utf8') : '';
        const additions = countLines(text);
        rows.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (oldFile !== undefined && newFile === undefined) {
        const blob = repo.objects.get(oldFile.oid);
        const text = blob?.type === 'blob' ? blob.data.toString('utf8') : '';
        const deletions = countLines(text);
        rows.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (oldFile !== undefined && newFile !== undefined && oldFile.oid !== newFile.oid) {
        const oldBlob = repo.objects.get(oldFile.oid);
        const newBlob = repo.objects.get(newFile.oid);
        const oldText = oldBlob?.type === 'blob' ? oldBlob.data.toString('utf8') : '';
        const newText = newBlob?.type === 'blob' ? newBlob.data.toString('utf8') : '';
        const { additions, deletions } = lineDiff(oldText, newText);
        rows.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return rows;
  }

  /** Whether a pr request would merge cleanly (no path changed on
   * both sides of the merge base in different ways). */
  pullMergeable(repo: Repo, pr: Pull): boolean {
    return this.mergePlan(repo, pr) !== null;
  }

  /** The merged tree for a pr request, or null on conflict. */
  private mergePlan(repo: Repo, pr: Pull): Map<string, string> | null {
    const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
    if (baseTip === undefined) return null;
    const base = this.mergeBase(repo, pr.headSha, baseTip);
    // No common ancestor: the merge base is the empty tree.
    const ancestorTree = base === null ? undefined : this.commitTree(repo, base);
    const ancestorMap = ancestorTree === undefined ? new Map<string, { oid: string }>() : this.flattenTree(repo, ancestorTree);
    const fromTree = this.commitTree(repo, baseTip);
    const toTree = this.commitTree(repo, pr.headSha);
    const baseMap = fromTree === undefined ? new Map() : this.flattenTree(repo, fromTree);
    const headMap = toTree === undefined ? new Map() : this.flattenTree(repo, toTree);
    const merged = new Map<string, string>();
    const allPaths = new Set([...ancestorMap.keys(), ...baseMap.keys(), ...headMap.keys()]);
    for (const path of allPaths) {
      const ancestorOid = ancestorMap.get(path)?.oid ?? null;
      const baseOid = baseMap.get(path)?.oid ?? null;
      const headOid = headMap.get(path)?.oid ?? null;
      if (baseOid === headOid) {
        if (baseOid !== null) merged.set(path, baseOid);
      } else if (ancestorOid === headOid) {
        if (baseOid !== null) merged.set(path, baseOid);
      } else if (ancestorOid === baseOid) {
        if (headOid !== null) merged.set(path, headOid);
      } else {
        return null;
      }
    }
    return merged;
  }

  /** Squash-merge a pr request onto its base branch. Returns the
   * merge commit sha, or null when the merge conflicts. */
  mergePull(repo: Repo, pr: Pull): string | null {
    if (pr.state !== 'open') return null;
    const merged = this.mergePlan(repo, pr);
    if (merged === null) return null;
    const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
    if (baseTip === undefined) return null;
    const tree = this.buildTreeFromPaths(repo, merged);
    const sha = this.createCommit(repo, {
      tree,
      parents: [baseTip],
      message: `Merge pr request #${pr.number}: ${pr.title}`,
    });
    repo.refs.set(`refs/heads/${pr.base}`, sha);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = this.nowIso();
    pr.mergeCommitSha = sha;
    return sha;
  }
}
