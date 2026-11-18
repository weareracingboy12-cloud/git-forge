// The store: every object the forge holds, in memory. One process, one
// store, no disk. Determinism is a design rule here: timestamps and request
// ids come from monotonic counters seeded at a fixed epoch, never from the
// wall clock or Math.random, so a replayed trial reaches the same state.
//
// The store owns the git object graph too (objects and refs per repository),
// the contents-API commit builder, the three-way merge, and the issue and
// pull-request records the REST, GraphQL and MCP surfaces all read.

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
  head: string;
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

function identityLine(epochSec: number): string {
  return `${VIEWER_LOGIN} <${VIEWER_LOGIN}@example.invalid> ${epochSec} +0000`;
}

/** Count the lines of `text`: a trailing newline does not start a new line. */
export function countLines(text: string): number {
  if (text === '') return 0;
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

/** Line additions and deletions between two texts, by multiset difference. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const count = (text: string): Map<string, number> => {
    const map = new Map<string, number>();
    if (text === '') return map;
    const lines = text.split('\n');
    if (text.endsWith('\n')) lines.pop();
    for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const oldLines = count(oldText);
  const newLines = count(newText);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of newLines) additions += Math.max(0, n - (oldLines.get(line) ?? 0));
  for (const [line, n] of oldLines) deletions += Math.max(0, n - (newLines.get(line) ?? 0));
  return { additions, deletions };
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextIdValue = 5000;
  private seqValue = 0;
  private requestSeq = 0;

  /** The next stable numeric id (repos, issues, pulls, comments share it). */
  nextId(): number {
    this.nextIdValue += 1;
    return this.nextIdValue;
  }

  /** Advance the deterministic clock and answer the new sequence number. */
  tick(): number {
    this.seqValue += 1;
    return this.seqValue;
  }

  /** The deterministic "now": the fixed epoch plus the sequence, as ISO. */
  nowIso(): string {
    return new Date((EPOCH_SEC + this.seqValue) * 1000).toISOString();
  }

  /** A request id for X-GitHub-Request-Id: monotonic, never empty. */
  requestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq}`;
  }

  // ---------------------------------------------------------------- repos

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, options: { private?: boolean; description?: string } = {}): Repo {
    const repo: Repo = {
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
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
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

  /** The commit object at `oid`, parsed; undefined when absent or not a commit. */
  readCommit(repo: Repo, oid: string): ReturnType<typeof parseCommit> | undefined {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return undefined;
    return parseCommit(object.data);
  }

  /** The tree oid a commit names; undefined when the commit is unknown. */
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
    for (let index = 0; index < segments.length; index += 1) {
      const entries = this.treeEntries(repo, current);
      const entry = entries.find((candidate) => candidate.name === segments[index]);
      if (entry === undefined) return null;
      if (index === segments.length - 1) return { oid: entry.oid, mode: entry.mode };
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return null;
  }

  /** A tree like `treeOid` but with `segments` set to `blobOid` (creating
   * intermediate directories). `treeOid` may be null for an empty tree. */
  setPath(repo: Repo, treeOid: string | null, segments: readonly string[], blobOid: string): string {
    const entries = treeOid === null ? [] : this.treeEntries(repo, treeOid);
    const head = segments[0]!;
    const kept = entries.filter((entry) => entry.name !== head);
    if (segments.length === 1) {
      kept.push({ mode: '100644', name: head, oid: blobOid });
    } else {
      const existing = entries.find((entry) => entry.name === head && entry.mode === '40000');
      const child = this.setPath(repo, existing?.oid ?? null, segments.slice(1), blobOid);
      kept.push({ mode: '40000', name: head, oid: child });
    }
    return this.putObject(repo, 'tree', buildTree(kept));
  }

  /** A tree like `treeOid` but with `segments` removed. */
  removePath(repo: Repo, treeOid: string, segments: readonly string[]): string {
    const entries = this.treeEntries(repo, treeOid);
    const head = segments[0]!;
    if (segments.length === 1) {
      return this.putObject(repo, 'tree', buildTree(entries.filter((entry) => entry.name !== head)));
    }
    const existing = entries.find((entry) => entry.name === head && entry.mode === '40000');
    if (existing === undefined) return treeOid;
    const child = this.removePath(repo, existing.oid, segments.slice(1));
    const kept = entries.filter((entry) => entry.name !== head);
    kept.push({ mode: '40000', name: head, oid: child });
    return this.putObject(repo, 'tree', buildTree(kept));
  }

  /** Every blob under `treeOid`, as path -> {oid}. */
  flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string }> {
    const out = new Map<string, { oid: string }>();
    for (const entry of this.treeEntries(repo, treeOid)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') {
        for (const [child, value] of this.flattenTree(repo, entry.oid, path)) out.set(child, value);
      } else {
        out.set(path, { oid: entry.oid });
      }
    }
    return out;
  }

  /** Build a tree from a flat path -> blob oid map. */
  buildTreeFromPaths(repo: Repo, files: ReadonlyMap<string, string>): string {
    const build = (paths: ReadonlyMap<string, string>): string => {
      const byFirst = new Map<string, Map<string, string>>();
      const direct: TreeEntry[] = [];
      for (const [path, oid] of paths) {
        const slash = path.indexOf('/');
        if (slash === -1) {
          direct.push({ mode: '100644', name: path, oid });
        } else {
          const first = path.slice(0, slash);
          const rest = path.slice(slash + 1);
          let group = byFirst.get(first);
          if (group === undefined) {
            group = new Map();
            byFirst.set(first, group);
          }
          group.set(rest, oid);
        }
      }
      const entries = [...direct];
      for (const [name, group] of byFirst) entries.push({ mode: '40000', name, oid: build(group) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(files);
  }

  /** All commit ancestors of `start` (including `start`), newest-first. */
  ancestors(repo: Repo, start: string): Set<string> {
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      const commit = this.readCommit(repo, oid);
      if (commit === undefined) continue;
      seen.add(oid);
      for (const parent of commit.parents) stack.push(parent);
    }
    return seen;
  }

  /** Whether `ancestor` is an ancestor of `descendant` (or equal to it). */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    return this.ancestors(repo, descendant).has(ancestor);
  }

  /** The merge base of two commits: the first common ancestor found walking
   * from `b` through the ancestors of `a`. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const aAncestors = this.ancestors(repo, a);
    const queue = [b];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (aAncestors.has(oid)) return oid;
      const commit = this.readCommit(repo, oid);
      if (commit === undefined) continue;
      queue.push(...commit.parents);
    }
    return null;
  }

  /** Create a commit object (author and committer are the viewer, at the
   * deterministic clock) and store it. */
  createCommit(repo: Repo, options: { tree: string; parents: string[]; message: string }): string {
    const epochSec = EPOCH_SEC + this.tick();
    const line = identityLine(epochSec);
    const data = buildCommit({ tree: options.tree, parents: options.parents, author: line, committer: line, message: options.message });
    return this.putObject(repo, 'commit', data);
  }

  /** Resolve a ref-ish to a commit oid: a branch name, a full ref, or a raw
   * object id. `defaultBranch` is used when `ref` is undefined. */
  resolveRef(repo: Repo, ref: string | undefined): string | undefined {
    if (ref === undefined) return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (repo.refs.has(ref)) return repo.refs.get(ref);
    const asBranch = repo.refs.get(`refs/heads/${ref}`);
    if (asBranch !== undefined) return asBranch;
    if (repo.objects.has(ref)) return ref;
    return undefined;
  }

  // ------------------------------------------------------------- contents

  /** Commit `content` at `path` on `branch` (creating the branch from the
   * default tip when it does not exist yet). */
  putContents(repo: Repo, branch: string, path: string, content: Buffer, message: string): { commitSha: string; contentSha: string } {
    const blobOid = this.putObject(repo, 'blob', content);
    let tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const parentTree = tip === undefined ? null : this.commitTree(repo, tip);
    const tree = this.setPath(repo, parentTree ?? null, path.split('/'), blobOid);
    const commitSha = this.createCommit(repo, { tree, parents: tip === undefined ? [] : [tip], message });
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha, contentSha: blobOid };
  }

  /** Remove `path` from `branch` with a commit. */
  deleteContents(repo: Repo, branch: string, path: string, message: string): { commitSha: string } {
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) throw new Error('branch has no commit');
    const parentTree = this.commitTree(repo, tip);
    if (parentTree === undefined) throw new Error('branch tip is not a commit');
    const tree = this.removePath(repo, parentTree, path.split('/'));
    const commitSha = this.createCommit(repo, { tree, parents: [tip], message });
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha };
  }

  /** Read a path at a ref: a file, a directory listing, or null. */
  readContents(
    repo: Repo,
    path: string,
    ref: string | undefined,
  ): { kind: 'file'; oid: string; data: Buffer } | { kind: 'dir'; entries: TreeEntry[] } | null {
    const tip = this.resolveRef(repo, ref);
    if (tip === undefined) return null;
    const tree = this.commitTree(repo, tip);
    if (tree === undefined) return null;
    const segments = path === '' ? [] : path.split('/');
    if (segments.length === 0) return { kind: 'dir', entries: this.treeEntries(repo, tree) };
    const found = this.resolvePath(repo, tree, segments);
    if (found === null) return null;
    if (found.mode === '40000') return { kind: 'dir', entries: this.treeEntries(repo, found.oid) };
    const object = repo.objects.get(found.oid);
    if (object === undefined || object.type !== 'blob') return null;
    return { kind: 'file', oid: found.oid, data: object.data };
  }

  // --------------------------------------------------------------- issues

  createIssue(repo: Repo, input: { title: string; body: string; labels?: string[] }): Issue {
    const issue: Issue = {
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
    repo.issues.set(issue.number, issue);
    return issue;
  }

  listIssues(
    repo: Repo,
    options: { state?: string; sort?: string; direction?: string; perPage?: number; page?: number } = {},
  ): Issue[] {
    const state = options.state ?? 'open';
    let list = [...repo.issues.values()];
    if (state !== 'all') list = list.filter((issue) => issue.state === state);
    const direction = options.direction ?? 'desc';
    list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
    const perPage = Math.max(1, Math.min(options.perPage ?? 30, 100));
    const page = Math.max(1, options.page ?? 1);
    return list.slice((page - 1) * perPage, page * perPage);
  }

  addIssueComment(repo: Repo, issue: Issue, body: string): IssueComment {
    const comment: IssueComment = { id: this.nextId(), body, createdSeq: this.tick() };
    issue.comments.push(comment);
    return comment;
  }

  // ----------------------------------------------------------------- pulls

  createPull(repo: Repo, input: { head: string; base: string; title: string; body: string }): Pull {
    const headSha = repo.refs.get(`refs/heads/${input.head}`);
    const baseSha = repo.refs.get(`refs/heads/${input.base}`);
    if (headSha === undefined) throw new Error(`head branch ${input.head} does not exist`);
    if (baseSha === undefined) throw new Error(`base branch ${input.base} does not exist`);
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.head === input.head && existing.base === input.base) {
        throw new Error('a pull request is already open for this head and base');
      }
    }
    const pull: Pull = {
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
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  listPulls(repo: Repo, options: { state?: string; perPage?: number; page?: number } = {}): Pull[] {
    const state = options.state ?? 'open';
    let list = [...repo.pulls.values()];
    if (state !== 'all') list = list.filter((pull) => pull.state === state);
    list.sort((a, b) => b.createdSeq - a.createdSeq);
    const perPage = Math.max(1, Math.min(options.perPage ?? 30, 100));
    const page = Math.max(1, options.page ?? 1);
    return list.slice((page - 1) * perPage, page * perPage);
  }

  /** The file changes between a pull request's base tip and head tip. */
  pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const baseTree = this.commitTree(repo, pull.baseSha);
    const headTree = this.commitTree(repo, pull.headSha);
    const baseFiles = baseTree === undefined ? new Map() : this.flattenTree(repo, baseTree);
    const headFiles = headTree === undefined ? new Map() : this.flattenTree(repo, headTree);
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of [...paths].sort()) {
      const base = baseFiles.get(path);
      const head = headFiles.get(path);
      if (base === undefined && head !== undefined) {
        const blob = repo.objects.get(head.oid);
        const text = blob?.type === 'blob' ? blob.data.toString('utf8') : '';
        const additions = countLines(text);
        out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (base !== undefined && head === undefined) {
        const blob = repo.objects.get(base.oid);
        const text = blob?.type === 'blob' ? blob.data.toString('utf8') : '';
        const deletions = countLines(text);
        out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (base !== undefined && head !== undefined && base.oid !== head.oid) {
        const oldBlob = repo.objects.get(base.oid);
        const newBlob = repo.objects.get(head.oid);
        const oldText = oldBlob?.type === 'blob' ? oldBlob.data.toString('utf8') : '';
        const newText = newBlob?.type === 'blob' ? newBlob.data.toString('utf8') : '';
        const { additions, deletions } = lineDiff(oldText, newText);
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  /** Whether a pull request would merge cleanly (no path changed on both
   * sides of the merge base in different ways). */
  pullMergeable(repo: Repo, pull: Pull): boolean {
    return this.mergePlan(repo, pull) !== null;
  }

  /** The merged tree for a pull request, or null on conflict. */
  private mergePlan(repo: Repo, pull: Pull): Map<string, string> | null {
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    if (baseTip === undefined) return null;
    const base = this.mergeBase(repo, pull.headSha, baseTip);
    // No common ancestor: the merge base is the empty tree.
    const ancestorTree = base === null ? undefined : this.commitTree(repo, base);
    const ancestorFiles = ancestorTree === undefined ? new Map<string, { oid: string }>() : this.flattenTree(repo, ancestorTree);
    const baseTree = this.commitTree(repo, baseTip);
    const headTree = this.commitTree(repo, pull.headSha);
    const baseFiles = baseTree === undefined ? new Map() : this.flattenTree(repo, baseTree);
    const headFiles = headTree === undefined ? new Map() : this.flattenTree(repo, headTree);
    const merged = new Map<string, string>();
    const paths = new Set([...ancestorFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of paths) {
      const a = ancestorFiles.get(path)?.oid ?? null;
      const b = baseFiles.get(path)?.oid ?? null;
      const h = headFiles.get(path)?.oid ?? null;
      if (b === h) {
        if (b !== null) merged.set(path, b);
      } else if (a === h) {
        if (b !== null) merged.set(path, b);
      } else if (a === b) {
        if (h !== null) merged.set(path, h);
      } else {
        return null;
      }
    }
    return merged;
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge
   * commit sha, or null when the merge conflicts. */
  mergePull(repo: Repo, pull: Pull): string | null {
    if (pull.state !== 'open') return null;
    const merged = this.mergePlan(repo, pull);
    if (merged === null) return null;
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    if (baseTip === undefined) return null;
    const tree = this.buildTreeFromPaths(repo, merged);
    const sha = this.createCommit(repo, {
      tree,
      parents: [baseTip],
      message: `Merge pull request #${pull.number}: ${pull.title}`,
    });
    repo.refs.set(`refs/heads/${pull.base}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.nowIso();
    pull.mergeCommitSha = sha;
    return sha;
  }

  /** The commit history walking back from `tip` (first-parent order is the
   * same as parent order here: every commit has at most one parent in the
   * histories this forge builds, but the walk follows all parents). */
  commitHistory(repo: Repo, tip: string): Array<{ sha: string; message: string; author: string; committer: string }> {
    const out: Array<{ sha: string; message: string; author: string; committer: string }> = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = this.readCommit(repo, oid);
      if (commit === undefined) continue;
      out.push({ sha: oid, message: commit.message, author: commit.author, committer: commit.committer });
      queue.push(...commit.parents);
    }
    return out;
  }
}
