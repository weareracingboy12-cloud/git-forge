// git smart HTTP: info/refs advertisements, v2 ls-refs and fetch, v0
// fetch, and v0 receive-pack. The protocol rules this file answers:
//
//   upload-pack honours Git-Protocol: version=2 (a v2 advertisement:
//   `version 2` plus capability lines, including fetch, ls-refs=unborn
//   and object-format=sha1); without it, a v0 advertisement (the
//   `# service=` preamble, ref lines, the first carrying the
//   capabilities after a NUL). receive-pack is v0 only, advertising
//   report-status, side-band-64k and delete-refs.
//   ls-refs answers HEAD with its symref target, peels annotated tags,
//   and honours ref-prefix filtering (HEAD is only listed without a
//   prefix).
//   fetch sends only the objects the client does not hold: the walk
//   stops at haves and at shallow boundaries, and a deepen limit cuts
//   the history at exactly that many generations, naming the new
//   boundary in shallow-info.
//   receive-pack is fast-forward only; a refused ref gets
//   `ng <ref> non-fast-forward` and does not move, while the pack still
//   unpacks. The report travels in sideband band 1 when negotiated.

import {
  ZERO_OID,
  parseCommit,
  parseTag,
  parseTree,
  pktDelim,
  pktFlush,
  pktLine,
  readPack,
  splitAtFlush,
  writePack,
  type GitObject,
} from './gitobj.ts';
import { Store, type Repo } from './store.ts';
import { jsonResult, notFound, type HttpResult } from './httputil.ts';

const AGENT = 'git-forge/1.0';

const UPLOAD_V0_CAPS =
  'side-band-64k multi_ack_detailed thin-pack ofs-delta shallow symref=HEAD:refs/heads/main agent=git-forge/1.0';
const RECEIVE_V0_CAPS =
  'report-status side-band-64k delete-refs ofs-delta agent=git-forge/1.0';

/** One ref of a repository, with its peeled tag target when it is an
 * annotated tag. */
interface ListedRef {
  name: string;
  oid: string;
  peeled?: string;
}

/** The refs of a repository, sorted by name, with peeled tag targets. */
function collectRefs(repo: Repo): ListedRef[] {
  const out: ListedRef[] = [];
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name)!;
    const ref: ListedRef = { name, oid };
    if (name.startsWith('refs/tags/')) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        const tag = parseTag(object.data);
        if (tag.object !== '') ref.peeled = tag.object;
      }
    }
    out.push(ref);
  }
  return out;
}

/** The tip of the default branch, or the zero oid when the repo is
 * unborn. */
function headTip(repo: Repo): string {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

function advertiseV2(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ]);
}

function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const chunks: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = collectRefs(repo);
  if (refs.length === 0) {
    chunks.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const tip = headTip(repo);
    chunks.push(pktLine(`${tip} HEAD\0${caps}\n`));
    for (const ref of refs) {
      chunks.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) {
        chunks.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
      }
    }
  }
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

export function handleInfoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: string,
  gitProtocol: string | undefined,
): HttpResult {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      return {
        status: 200,
        contentType: 'application/x-git-upload-pack-advertisement',
        body: advertiseV2(),
      };
    }
    return {
      status: 200,
      contentType: 'application/x-git-upload-pack-advertisement',
      body: advertiseV0(repo, 'git-upload-pack'),
    };
  }
  if (service === 'git-receive-pack') {
    return {
      status: 200,
      contentType: 'application/x-git-receive-pack-advertisement',
      body: advertiseV0(repo, 'git-receive-pack'),
    };
  }
  return jsonResult(400, { message: `unknown service ${service}` });
}

// ---------------------------------------------------------------------------
// pkt-line request parsing
// ---------------------------------------------------------------------------

/** The text lines of a pkt-line request body (data packets only). */
function textLines(body: Buffer): string[] {
  const lines: string[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (head === '0000' || head === '0001') {
      offset += 4;
      continue;
    }
    const length = Number.parseInt(head, 16);
    if (!Number.isFinite(length) || length < 4 || offset + length > body.length) {
      throw new Error('bad pkt-line in request');
    }
    lines.push(body.subarray(offset + 4, offset + length).toString('utf8'));
    offset += length;
  }
  return lines;
}

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
}

function readFetchRequest(lines: readonly string[]): FetchRequest {
  const out: FetchRequest = { wants: [], haves: [], shallow: [], depth: undefined };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) out.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) out.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) out.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n)) out.depth = n;
    }
  }
  return out;
}

interface FetchPlan {
  objects: GitObject[];
  freshShallow: string[];
  clearedShallow: string[];
}

/** Sideband framing: the pack bytes split into band-1 packets. */
function packInSideband(pack: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const piece = pack.subarray(offset, Math.min(offset + CHUNK, pack.length));
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), piece])));
  }
  if (pack.length === 0) {
    // An empty pack is still a pack: send its 32 bytes as one band-1 packet.
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), pack])));
  }
  return Buffer.concat(chunks);
}

function respondV2Fetch(plan: FetchPlan, depth: number | undefined): Buffer {
  const chunks: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), pktDelim()];
  if (depth !== undefined) {
    chunks.push(pktLine('shallow-info\n'));
    for (const oid of plan.freshShallow) chunks.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.clearedShallow) chunks.push(pktLine(`unshallow ${oid}\n`));
    chunks.push(pktDelim());
  }
  chunks.push(pktLine('packfile\n'));
  chunks.push(packInSideband(writePack(plan.objects)));
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

function respondV0Fetch(plan: FetchPlan, depth: number | undefined): Buffer {
  const chunks: Buffer[] = [pktLine('NAK\n')];
  if (depth !== undefined) {
    for (const oid of plan.freshShallow) chunks.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.clearedShallow) chunks.push(pktLine(`unshallow ${oid}\n`));
  }
  chunks.push(packInSideband(writePack(plan.objects)));
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

/** Which objects a fetch sends: the closure of the wants, stopping at
 * haves, at shallow boundaries, and at the deepen limit. A commit at
 * exactly depth-1 generations becomes a new shallow boundary; a
 * previously shallow commit whose parent is now sent stops being one. */
function buildFetchPlan(store: Store, repo: Repo, request: FetchRequest): FetchPlan {
  const haveSet = new Set(request.haves);
  const shallowSet = new Set(request.shallow);
  const depth = request.depth;
  const outbox = new Map<string, GitObject>();
  const shippedCommits = new Set<string>();
  const freshShallow: string[] = [];
  const depthOf = new Map<string, number>();
  const pending: Array<[string, number]> = [];
  for (const want of request.wants) pending.push([want, 0]);

  // Everything reachable from a held commit — a have, or a shallow
  // boundary the client already holds — is already on the client and must
  // never be re-sent: not the commit, not its tree, not a shared blob. The
  // walk stops at a shallow boundary: the client holds that commit and its
  // tree, but not its parents, and deepening exists to fetch exactly
  // those.
  const held = new Set<string>();
  const markOwned = (oid: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined || held.has(oid)) return;
    held.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      markOwned(commit.tree);
      if (!shallowSet.has(oid)) {
        for (const parent of commit.parents) markOwned(parent);
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) markOwned(entry.oid);
    } else if (object.type === 'tag') {
      markOwned(parseTag(object.data).object);
    }
  };
  for (const oid of [...request.haves, ...request.shallow]) markOwned(oid);

  const addTree = (treeOid: string): void => {
    const walk = (oid: string): void => {
      const object = repo.objects.get(oid);
      if (object === undefined || outbox.has(oid) || held.has(oid)) return;
      outbox.set(oid, object);
      if (object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) walk(entry.oid);
    };
    walk(treeOid);
  };

  while (pending.length > 0) {
    const [oid, dist] = pending.shift()!;
    const known = depthOf.get(oid);
    if (known !== undefined && known <= dist) continue;
    depthOf.set(oid, dist);
    if (depth !== undefined && dist >= depth) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    // A held commit is not re-sent. With a deepen in play its parents may
    // still be needed; without one its history is already held. A shallow
    // boundary is held the same way: the client has the commit, just not
    // its parents, so deepening walks past it.
    if (object.type === 'commit' && (haveSet.has(oid) || shallowSet.has(oid))) {
      if (depth !== undefined) {
        const commit = parseCommit(object.data);
        for (const parent of commit.parents) pending.push([parent, dist + 1]);
      }
      continue;
    }
    if (held.has(oid)) continue;
    if (object.type === 'tag') {
      outbox.set(oid, object);
      const target = parseTag(object.data).object;
      if (target !== '') pending.push([target, dist]);
      continue;
    }
    if (object.type !== 'commit') {
      outbox.set(oid, object);
      continue;
    }
    outbox.set(oid, object);
    shippedCommits.add(oid);
    const commit = parseCommit(object.data);
    addTree(commit.tree);
    if (depth !== undefined && dist === depth - 1) freshShallow.push(oid);
    for (const parent of commit.parents) pending.push([parent, dist + 1]);
  }

  const clearedShallow: string[] = [];
  if (depth !== undefined) {
    for (const old of request.shallow) {
      if (freshShallow.includes(old)) continue;
      const commit = store.readCommit(repo, old);
      if (commit !== undefined && commit.parents.some((parent) => shippedCommits.has(parent))) {
        clearedShallow.push(old);
      }
    }
  }
  return { objects: [...outbox.values()], freshShallow, clearedShallow };
}

export function handleUploadPack(
  store: Store,
  owner: string,
  repoName: string,
  body: Buffer,
  gitProtocol: string | undefined,
): HttpResult {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  let lines: string[];
  try {
    lines = textLines(body);
  } catch {
    return jsonResult(400, { message: 'malformed pkt-line request' });
  }
  const command = lines.find((line) => line.startsWith('command='))?.slice(8).trim();
  if (gitProtocol === 'version=2') {
    if (command === 'ls-refs') {
      const peel = lines.some((line) => line.trim() === 'peel');
      const prefixes = lines
        .filter((line) => line.startsWith('ref-prefix '))
        .map((line) => line.slice(11).trim());
      const refs = collectRefs(repo);
      const chunks: Buffer[] = [];
      const tip = headTip(repo);
      const includeHead = prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
      if (includeHead) {
        if (tip === ZERO_OID) chunks.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
        else chunks.push(pktLine(`${tip} HEAD symref-target:refs/heads/main\n`));
      }
      for (const ref of refs) {
        if (prefixes.length > 0 && !prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
        let line = `${ref.oid} ${ref.name}`;
        if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
        chunks.push(pktLine(`${line}\n`));
      }
      chunks.push(pktFlush());
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(chunks) };
    }
    if (command === 'fetch') {
      const request = readFetchRequest(lines);
      const plan = buildFetchPlan(store, repo, request);
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: respondV2Fetch(plan, request.depth) };
    }
    return jsonResult(400, { message: `unknown v2 command ${command ?? ''}` });
  }
  // v0 fetch.
  const request = readFetchRequest(lines);
  const plan = buildFetchPlan(store, repo, request);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: respondV0Fetch(plan, request.depth) };
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface RefUpdate {
  oldOid: string;
  newOid: string;
  ref: string;
}

function readPush(body: Buffer): { updates: RefUpdate[]; capabilities: string; pack: Buffer } {
  const { packets, rest } = splitAtFlush(body);
  const updates: RefUpdate[] = [];
  let capabilities = '';
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length !== 3) continue;
    updates.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  return { updates, capabilities, pack: rest };
}

export function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): HttpResult {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  let parsed: { updates: RefUpdate[]; capabilities: string; pack: Buffer };
  try {
    parsed = readPush(body);
  } catch {
    return jsonResult(400, { message: 'malformed receive-pack request' });
  }
  const { updates, capabilities, pack } = parsed;
  const sideband = capabilities.split(' ').includes('side-band-64k');
  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = '';
  if (pack.length > 0) {
    try {
      const { objects } = readPack(pack);
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }
  if (!unpackOk) {
    reportLines.push(`unpack ${unpackDetail}\n`);
    for (const update of updates) reportLines.push(`ng ${update.ref} unpack error\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const update of updates) {
      const current = repo.refs.get(update.ref);
      let ok = false;
      if (update.newOid === ZERO_OID) {
        // Delete: the ref must exist and the old oid must match.
        if (current !== undefined && update.oldOid === current) {
          repo.refs.delete(update.ref);
          ok = true;
        }
      } else if (current === undefined) {
        // Create: the old oid must be zero and the new object must be stored.
        if (update.oldOid === ZERO_OID && repo.objects.has(update.newOid)) {
          repo.refs.set(update.ref, update.newOid);
          ok = true;
        }
      } else if (update.oldOid === current && store.isAncestor(repo, current, update.newOid)) {
        repo.refs.set(update.ref, update.newOid);
        ok = true;
      }
      reportLines.push(ok ? `ok ${update.ref}\n` : `ng ${update.ref} non-fast-forward\n`);
    }
  }
  if (sideband) {
    const chunks: Buffer[] = [];
    for (const line of reportLines) {
      chunks.push(pktLine(Buffer.concat([Buffer.from([1]), pktLine(line)])));
    }
    chunks.push(pktFlush());
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(chunks) };
  }
  const chunks = reportLines.map((line) => pktLine(line));
  chunks.push(pktFlush());
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(chunks) };
}
