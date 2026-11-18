// The store: every object the forge holds, in memory. One process, one
// store, no disk. Determinism is a design rule here: timestamps and
// request ids come from monotonic counters seeded at a fixed epoch,
// never from the wall clock or Math.random, so a replayed trial reaches
// the same state.
//
// The store owns the git object graph too (objects and refs per
// repository), the contents-API commit builder, the three-way merge, and
// the issue and pull-request records the REST, GraphQL and MCP surfaces
// all read.

import {
  EMPTY_OID,
  encodeCommit,
  encodeTree,
  objectId,
  decodeCommit,
  decodeTree,
  type StoredObject,
  type ObjectKind,
  type TreeItem,
} from './gitobj.ts';

/** The login the bearer token names: the scenario's viewer, fixed by the
 * kit's SCENARIO_SEED (wire.ts: "the contest's fixed data"). Verified by
 * running the kit's own generator: viewer login `adaiversen`, id 1000. */
export const VIEWER = 'adaiversen';
export const VIEWER_UID = 1000;

/** The fixed epoch every timestamp derives from: 2025-01-01T00:00:00Z. */
export const BASE_EPOCH = 1_735_689_600;

export interface RepoLabel {
  name: string;
  color: string;
}

export interface IssueNote {
  id: number;
  body: string;
  seq: number;
}

export interface IssueRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  comments: IssueNote[];
}

export interface PullRecord {
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
  seq: number;
}

export interface Repository {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  mainBranch: string;
  seq: number;
  objects: Map<string, StoredObject>;
  refs: Map<string, string>;
  issues: Map<number, IssueRecord>;
  pulls: Map<number, PullRecord>;
  labels: Map<string, RepoLabel>;
  nextNum: number;
}

function signatureLine(when: number): string {
  return `${VIEWER} <${VIEWER}@example.invalid> ${when} +0000`;
}

/** Count the lines of `text`: a trailing newline does not start a new
 * one. */
export function countTextLines(text: string): number {
  if (text === '') return 0;
  const split = text.split('\n');
  return text.endsWith('\n') ? split.length - 1 : split.length;
}

/** Line additions and deletions between two texts, by multiset
 * difference. */
export function diffLineCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const tally = (text: string): Map<string, number> => {
    const counts = new Map<string, number>();
    if (text === '') return counts;
    const lines = text.split('\n');
    if (text.endsWith('\n')) lines.pop();
    for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
    return counts;
  };
  const oldCounts = tally(oldText);
  const newCounts = tally(newText);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of newCounts) additions += Math.max(0, n - (oldCounts.get(line) ?? 0));
  for (const [line, n] of oldCounts) deletions += Math.max(0, n - (newCounts.get(line) ?? 0));
  return { additions, deletions };
}

export class Store {
  readonly repos = new Map<string, Repository>();
  private seqId = 5000;
  private tickCount = 0;
  private reqCount = 0;

  /** The next stable numeric id (repos, issues, pulls, comments share
   * it). */
  allocateId(): number {
    this.seqId += 1;
    return this.seqId;
  }

  /** Advance the deterministic clock and answer the new sequence
   * number. */
  advanceClock(): number {
    this.tickCount += 1;
    return this.tickCount;
  }

  /** The deterministic "now": the fixed epoch plus the sequence, as
   * ISO. */
  clockIso(): string {
    return new Date((BASE_EPOCH + this.tickCount) * 1000).toISOString();
  }

  /** A request id for X-GitHub-Request-Id: monotonic, never empty. */
  nextRequestId(): string {
    this.reqCount += 1;
    return `req-${this.reqCount}`;
  }

  // ---------------------------------------------------------------- repos

  repoPath(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  findRepo(owner: string, name: string): Repository | undefined {
    return this.repos.get(this.repoPath(owner, name));
  }

  addRepo(owner: string, name: string, options: { private?: boolean; description?: string } = {}): Repository {
    const entry: Repository = {
      id: this.allocateId(),
      owner,
      name,
      description: options.description ?? '',
      private: options.private ?? false,
      mainBranch: 'main',
      seq: this.advanceClock(),
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNum: 1,
    };
    this.repos.set(this.repoPath(owner, name), entry);
    return entry;
  }

  removeRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoPath(owner, name));
  }

  reposOfOwner(owner: string): Repository[] {
    return [...this.repos.values()]
      .filter((repo) => repo.owner === owner)
      .sort((a, b) => a.seq - b.seq);
  }

  // ------------------------------------------------------------ git objects

  storeObject(repo: Repository, type: ObjectKind, data: Buffer): string {
    const oid = objectId(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  fetchObject(repo: Repository, oid: string): StoredObject | undefined {
    return repo.objects.get(oid);
  }

  /** The commit object at `oid`, parsed; undefined when absent or not a
   * commit. */
  loadCommit(repo: Repository, oid: string): ReturnType<typeof decodeCommit> | undefined {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return undefined;
    return decodeCommit(object.data);
  }

  /** The tree oid a commit names; undefined when the commit is
   * unknown. */
  treeOfCommit(repo: Repository, commitOid: string): string | undefined {
    return this.loadCommit(repo, commitOid)?.tree;
  }

  /** The tree entries at `treeOid`; [] when the tree is unknown. */
  entriesOfTree(repo: Repository, treeOid: string): TreeItem[] {
    const object = repo.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return [];
    return decodeTree(object.data);
  }

  /** Walk `segments` down from `treeOid`: the final entry, or null. */
  lookupPath(repo: Repository, treeOid: string, segments: readonly string[]): { oid: string; mode: string } | null {
    let current = treeOid;
    for (let i = 0; i < segments.length; i += 1) {
      const entries = this.entriesOfTree(repo, current);
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
  writePath(repo: Repository, treeOid: string | null, segments: readonly string[], blob: string): string {
    const entries = treeOid === null ? [] : this.entriesOfTree(repo, treeOid);
    const head = segments[0]!;
    const others = entries.filter((entry) => entry.name !== head);
    if (segments.length === 1) {
      others.push({ mode: '100644', name: head, oid: blob });
    } else {
      const sub = entries.find((entry) => entry.name === head && entry.mode === '40000');
      const nested = this.writePath(repo, sub?.oid ?? null, segments.slice(1), blob);
      others.push({ mode: '40000', name: head, oid: nested });
    }
    return this.storeObject(repo, 'tree', encodeTree(others));
  }

  /** A tree like `treeOid` but with `segments` removed. */
  dropPath(repo: Repository, treeOid: string, segments: readonly string[]): string {
    const entries = this.entriesOfTree(repo, treeOid);
    const head = segments[0]!;
    if (segments.length === 1) {
      return this.storeObject(repo, 'tree', encodeTree(entries.filter((entry) => entry.name !== head)));
    }
    const sub = entries.find((entry) => entry.name === head && entry.mode === '40000');
    if (sub === undefined) return treeOid;
    const nested = this.dropPath(repo, sub.oid, segments.slice(1));
    const others = entries.filter((entry) => entry.name !== head);
    others.push({ mode: '40000', name: head, oid: nested });
    return this.storeObject(repo, 'tree', encodeTree(others));
  }

  /** Every blob under `treeOid`, as path -> {oid}. */
  flatten(repo: Repository, treeOid: string, prefix = ''): Map<string, { oid: string }> {
    const acc = new Map<string, { oid: string }>();
    for (const entry of this.entriesOfTree(repo, treeOid)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') {
        for (const [nested, value] of this.flatten(repo, entry.oid, path)) acc.set(nested, value);
      } else {
        acc.set(path, { oid: entry.oid });
      }
    }
    return acc;
  }

  /** Build a tree from a flat path -> blob oid map. */
  treeFromFiles(repo: Repository, files: ReadonlyMap<string, string>): string {
    const build = (allPaths: ReadonlyMap<string, string>): string => {
      const byDir = new Map<string, Map<string, string>>();
      const plain: TreeItem[] = [];
      for (const [path, oid] of allPaths) {
        const sep = path.indexOf('/');
        if (sep === -1) {
          plain.push({ mode: '100644', name: path, oid });
        } else {
          const dir = path.slice(0, sep);
          const tail = path.slice(sep + 1);
          let bucket = byDir.get(dir);
          if (bucket === undefined) {
            bucket = new Map();
            byDir.set(dir, bucket);
          }
          bucket.set(tail, oid);
        }
      }
      const entries = [...plain];
      for (const [name, bucket] of byDir) entries.push({ mode: '40000', name, oid: build(bucket) });
      return this.storeObject(repo, 'tree', encodeTree(entries));
    };
    return build(files);
  }

  /** All commit ancestors of `start` (including `start`), newest-first. */
  allAncestors(repo: Repository, start: string): Set<string> {
    const done = new Set<string>();
    const todo = [start];
    while (todo.length > 0) {
      const oid = todo.pop()!;
      if (done.has(oid)) continue;
      const commit = this.loadCommit(repo, oid);
      if (commit === undefined) continue;
      done.add(oid);
      for (const parent of commit.parents) todo.push(parent);
    }
    return done;
  }

  /** Whether `ancestor` is an ancestor of `descendant` (or equal to
   * it). */
  hasAncestor(repo: Repository, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    return this.allAncestors(repo, descendant).has(ancestor);
  }

  /** The merge base of two commits: the first common ancestor entry
   * walking from `b` through the ancestors of `a`. */
  commonAncestor(repo: Repository, a: string, b: string): string | null {
    const ancestorsOfA = this.allAncestors(repo, a);
    const frontier = [b];
    const done = new Set<string>();
    while (frontier.length > 0) {
      const oid = frontier.shift()!;
      if (done.has(oid)) continue;
      done.add(oid);
      if (ancestorsOfA.has(oid)) return oid;
      const commit = this.loadCommit(repo, oid);
      if (commit === undefined) continue;
      frontier.push(...commit.parents);
    }
    return null;
  }

  /** Create a commit object (author and committer are the viewer, at
   * the deterministic clock) and store it. */
  makeCommit(repo: Repository, options: { tree: string; parents: string[]; message: string }): string {
    const when = BASE_EPOCH + this.advanceClock();
    const sig = signatureLine(when);
    const data = encodeCommit({
      tree: options.tree,
      parents: options.parents,
      author: sig,
      committer: sig,
      message: options.message,
    });
    return this.storeObject(repo, 'commit', data);
  }

  /** Resolve a ref-ish to a commit oid: a branch name, a full ref, or a
   * raw object id. `mainBranch` is used when `ref` is undefined. */
  resolveReference(repo: Repository, ref: string | undefined): string | undefined {
    if (ref === undefined) return repo.refs.get(`refs/heads/${repo.mainBranch}`);
    if (repo.refs.has(ref)) return repo.refs.get(ref);
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch !== undefined) return branch;
    if (repo.objects.has(ref)) return ref;
    return undefined;
  }

  /** The commit history walking back from `start` (first-parent order
   * is the same as parent order here: every commit has at most one
   * parent in the histories this forge builds, but the walk follows all
   * parents). */
  historyOf(repo: Repository, start: string): Array<{ sha: string; message: string; author: string; committer: string }> {
    const rows: Array<{ sha: string; message: string; author: string; committer: string }> = [];
    const done = new Set<string>();
    const frontier = [start];
    while (frontier.length > 0) {
      const oid = frontier.shift()!;
      if (done.has(oid)) continue;
      done.add(oid);
      const commit = this.loadCommit(repo, oid);
      if (commit === undefined) continue;
      rows.push({ sha: oid, message: commit.message, author: commit.author, committer: commit.committer });
      frontier.push(...commit.parents);
    }
    return rows;
  }

  // ------------------------------------------------------------- contents

  /** Commit `content` at `path` on `branch` (creating the branch from
   * the default head when it does not exist yet). */
  writeContents(repo: Repository, branch: string, path: string, content: Buffer, message: string): { commitSha: string; contentSha: string } {
    const blob = this.storeObject(repo, 'blob', content);
    let tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) tip = repo.refs.get(`refs/heads/${repo.mainBranch}`);
    const parent = tip === undefined ? null : this.treeOfCommit(repo, tip);
    const tree = this.writePath(repo, parent ?? null, path.split('/'), blob);
    const commitSha = this.makeCommit(repo, { tree, parents: tip === undefined ? [] : [tip], message });
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha, contentSha: blob };
  }

  /** Remove `path` from `branch` with a commit. */
  removeContents(repo: Repository, branch: string, path: string, message: string): { commitSha: string } {
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) throw new Error('branch has no commit');
    const parent = this.treeOfCommit(repo, tip);
    if (parent === undefined) throw new Error('branch tip is not a commit');
    const tree = this.dropPath(repo, parent, path.split('/'));
    const commitSha = this.makeCommit(repo, { tree, parents: [tip], message });
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha };
  }

  /** Read a path at a ref: a file, a directory listing, or null. */
  readPath(
    repo: Repository,
    path: string,
    ref: string | undefined,
  ): { kind: 'file'; oid: string; data: Buffer } | { kind: 'sub'; entries: TreeItem[] } | null {
    const tip = this.resolveReference(repo, ref);
    if (tip === undefined) return null;
    const tree = this.treeOfCommit(repo, tip);
    if (tree === undefined) return null;
    const segments = path === '' ? [] : path.split('/');
    if (segments.length === 0) return { kind: 'sub', entries: this.entriesOfTree(repo, tree) };
    const entry = this.lookupPath(repo, tree, segments);
    if (entry === null) return null;
    if (entry.mode === '40000') return { kind: 'sub', entries: this.entriesOfTree(repo, entry.oid) };
    const object = repo.objects.get(entry.oid);
    if (object === undefined || object.type !== 'blob') return null;
    return { kind: 'file', oid: entry.oid, data: object.data };
  }

  // --------------------------------------------------------------- issues

  addIssue(repo: Repository, input: { title: string; body: string; labels?: string[] }): IssueRecord {
    const rec: IssueRecord = {
      id: this.allocateId(),
      number: repo.nextNum,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels: [...(input.labels ?? [])],
      seq: this.advanceClock(),
      comments: [],
    };
    repo.nextNum += 1;
    repo.issues.set(rec.number, rec);
    return rec;
  }

  issuesOf(
    repo: Repository,
    options: { state?: string; sort?: string; direction?: string; perPage?: number; page?: number } = {},
  ): IssueRecord[] {
    const state = options.state ?? 'open';
    let rows = [...repo.issues.values()];
    if (state !== 'all') rows = rows.filter((rec) => rec.state === state);
    const direction = options.direction ?? 'desc';
    rows.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
    const perPage = Math.max(1, Math.min(options.perPage ?? 30, 100));
    const page = Math.max(1, options.page ?? 1);
    return rows.slice((page - 1) * perPage, page * perPage);
  }

  commentOnIssue(repo: Repository, rec: IssueRecord, body: string): IssueNote {
    const note: IssueNote = { id: this.allocateId(), body, seq: this.advanceClock() };
    rec.comments.push(note);
    return note;
  }

  // ----------------------------------------------------------------- pulls

  openPull(repo: Repository, input: { head: string; base: string; title: string; body: string }): PullRecord {
    const headSha = repo.refs.get(`refs/heads/${input.head}`);
    const baseSha = repo.refs.get(`refs/heads/${input.base}`);
    if (headSha === undefined) throw new Error(`head branch ${input.head} does not exist`);
    if (baseSha === undefined) throw new Error(`base branch ${input.base} does not exist`);
    for (const other of repo.pulls.values()) {
      if (other.state === 'open' && other.head === input.head && other.base === input.base) {
        throw new Error('a pr request is already open for this head and base');
      }
    }
    const pr: PullRecord = {
      id: this.allocateId(),
      number: repo.nextNum,
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
      seq: this.advanceClock(),
    };
    repo.nextNum += 1;
    repo.pulls.set(pr.number, pr);
    return pr;
  }

  pullsOf(repo: Repository, options: { state?: string; perPage?: number; page?: number } = {}): PullRecord[] {
    const state = options.state ?? 'open';
    let rows = [...repo.pulls.values()];
    if (state !== 'all') rows = rows.filter((pr) => pr.state === state);
    rows.sort((a, b) => b.seq - a.seq);
    const perPage = Math.max(1, Math.min(options.perPage ?? 30, 100));
    const page = Math.max(1, options.page ?? 1);
    return rows.slice((page - 1) * perPage, page * perPage);
  }

  /** The file changes between a pull request's base tip and head tip. */
  filesOfPull(repo: Repository, pr: PullRecord): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const baseTree = this.treeOfCommit(repo, pr.baseSha);
    const headTree = this.treeOfCommit(repo, pr.headSha);
    const before = baseTree === undefined ? new Map() : this.flatten(repo, baseTree);
    const after = headTree === undefined ? new Map() : this.flatten(repo, headTree);
    const rows: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    const allPaths = new Set([...before.keys(), ...after.keys()]);
    for (const path of [...allPaths].sort()) {
      const oldFile = before.get(path);
      const newFile = after.get(path);
      if (oldFile === undefined && newFile !== undefined) {
        const blob = repo.objects.get(newFile.oid);
        const text = blob?.type === 'blob' ? blob.data.toString('utf8') : '';
        const additions = countTextLines(text);
        rows.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (oldFile !== undefined && newFile === undefined) {
        const blob = repo.objects.get(oldFile.oid);
        const text = blob?.type === 'blob' ? blob.data.toString('utf8') : '';
        const deletions = countTextLines(text);
        rows.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (oldFile !== undefined && newFile !== undefined && oldFile.oid !== newFile.oid) {
        const oldBlob = repo.objects.get(oldFile.oid);
        const newBlob = repo.objects.get(newFile.oid);
        const oldText = oldBlob?.type === 'blob' ? oldBlob.data.toString('utf8') : '';
        const newText = newBlob?.type === 'blob' ? newBlob.data.toString('utf8') : '';
        const { additions, deletions } = diffLineCounts(oldText, newText);
        rows.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return rows;
  }

  /** Whether a pull request would merge cleanly (no path changed on
   * both sides of the merge base in different ways). */
  canMergePull(repo: Repository, pr: PullRecord): boolean {
    return this.planMerge(repo, pr) !== null;
  }

  /** The merged tree for a pull request, or null on conflict. */
  private planMerge(repo: Repository, pr: PullRecord): Map<string, string> | null {
    const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
    if (baseTip === undefined) return null;
    const base = this.commonAncestor(repo, pr.headSha, baseTip);
    // No common ancestor: the merge base is the empty tree.
    const ancestorTree = base === null ? undefined : this.treeOfCommit(repo, base);
    const ancestorMap = ancestorTree === undefined ? new Map<string, { oid: string }>() : this.flatten(repo, ancestorTree);
    const baseTree = this.treeOfCommit(repo, baseTip);
    const headTree = this.treeOfCommit(repo, pr.headSha);
    const baseMap = baseTree === undefined ? new Map() : this.flatten(repo, baseTree);
    const headMap = headTree === undefined ? new Map() : this.flatten(repo, headTree);
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

  /** Squash-merge a pull request onto its base branch. Returns the
   * merge commit sha, or null when the merge conflicts. */
  squashMerge(repo: Repository, pr: PullRecord): string | null {
    if (pr.state !== 'open') return null;
    const merged = this.planMerge(repo, pr);
    if (merged === null) return null;
    const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
    if (baseTip === undefined) return null;
    const tree = this.treeFromFiles(repo, merged);
    const sha = this.makeCommit(repo, {
      tree,
      parents: [baseTip],
      message: `Merge pr request #${pr.number}: ${pr.title}`,
    });
    repo.refs.set(`refs/heads/${pr.base}`, sha);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = this.clockIso();
    pr.mergeCommitSha = sha;
    return sha;
  }
}
