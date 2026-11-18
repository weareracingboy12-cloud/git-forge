// git smart HTTP: info/refs advertisements, v2 ls-refs and fetch, v0 fetch,
// and v0 receive-pack. The protocol rules this file implements:
//
//   upload-pack honours Git-Protocol: version=2 (a v2 advertisement: `version
//   2` plus capability lines, including fetch, ls-refs=unborn and
//   object-format=sha1); without it, a v0 advertisement (the `# service=`
//   preamble, ref lines, the first carrying the capabilities after a NUL).
//   receive-pack is v0 only, advertising report-status, side-band-64k and
//   delete-refs.
//   ls-refs answers HEAD with its symref target, peels annotated tags, and
//   honours ref-prefix filtering (HEAD is only listed without a prefix).
//   fetch sends only the objects the client does not hold: the walk stops at
//   haves and at shallow boundaries, and a deepen limit cuts the history at
//   exactly that many generations, naming the new boundary in shallow-info.
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

const UPLOAD_V0_CAPS = 'side-band-64k multi_ack_detailed thin-pack ofs-delta shallow symref=HEAD:refs/heads/main agent=git-forge/1.0';
const RECEIVE_V0_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=git-forge/1.0';

/** The refs of a repository, sorted by name, with peeled tag targets. */
interface ListedRef {
  name: string;
  oid: string;
  peeled?: string;
}

function listRefs(repo: Repo): ListedRef[] {
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

/** The tip of the default branch, or the zero oid when the repo is unborn. */
function defaultTip(repo: Repo): string {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ]);
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const chunks: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = listRefs(repo);
  if (refs.length === 0) {
    chunks.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const tip = defaultTip(repo);
    chunks.push(pktLine(`${tip} HEAD\0${caps}\n`));
    for (const ref of refs) {
      chunks.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) chunks.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

export function handleInfoRefs(store: Store, owner: string, repoName: string, service: string, gitProtocol: string | undefined): HttpResult {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0Advertisement(repo, 'git-upload-pack') };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0Advertisement(repo, 'git-receive-pack') };
  }
  return jsonResult(400, { message: `unknown service ${service}` });
}

// ---------------------------------------------------------------------------
// pkt-line request parsing
// ---------------------------------------------------------------------------

/** The text lines of a pkt-line request body (data packets only). */
function requestLines(body: Buffer): string[] {
  const lines: string[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (head === '0000' || head === '0001') {
      offset += 4;
      continue;
    }
    const length = Number.parseInt(head, 16);
    if (!Number.isFinite(length) || length < 4 || offset + length > body.length) throw new Error('bad pkt-line in request');
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

function parseFetchLines(lines: readonly string[]): FetchRequest {
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
  newShallow: string[];
  unshallow: string[];
}

/** Which objects a fetch sends: the closure of the wants, stopping at haves,
 * at shallow boundaries, and at the deepen limit. A commit at exactly
 * depth-1 generations becomes a new shallow boundary; a previously shallow
 * commit whose parent is now sent stops being one. */
function planFetch(store: Store, repo: Repo, request: FetchRequest): FetchPlan {
  const haveSet = new Set(request.haves);
  const shallowSet = new Set(request.shallow);
  const depth = request.depth;
  const send = new Map<string, GitObject>();
  const sentCommits = new Set<string>();
  const newShallow: string[] = [];
  const distance = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  for (const want of request.wants) queue.push([want, 0]);

  // Everything reachable from a held commit — a have, or a shallow boundary
  // the client already holds — is already on the client and must never be
  // re-sent: not the commit, not its tree, not a shared blob. The walk
  // stops at a shallow boundary: the client holds that commit and its tree,
  // but not its parents, and deepening exists to fetch exactly those.
  const heldObjects = new Set<string>();
  const markHeld = (oid: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined || heldObjects.has(oid)) return;
    heldObjects.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      markHeld(commit.tree);
      if (!shallowSet.has(oid)) {
        for (const parent of commit.parents) markHeld(parent);
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) markHeld(entry.oid);
    } else if (object.type === 'tag') {
      markHeld(parseTag(object.data).object);
    }
  };
  for (const oid of [...request.haves, ...request.shallow]) markHeld(oid);

  const includeTreeClosure = (treeOid: string): void => {
    const walk = (oid: string): void => {
      const object = repo.objects.get(oid);
      if (object === undefined || send.has(oid) || heldObjects.has(oid)) return;
      send.set(oid, object);
      if (object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) walk(entry.oid);
    };
    walk(treeOid);
  };

  while (queue.length > 0) {
    const [oid, dist] = queue.shift()!;
    const known = distance.get(oid);
    if (known !== undefined && known <= dist) continue;
    distance.set(oid, dist);
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
        for (const parent of commit.parents) queue.push([parent, dist + 1]);
      }
      continue;
    }
    if (heldObjects.has(oid)) continue;
    if (object.type === 'tag') {
      send.set(oid, object);
      const target = parseTag(object.data).object;
      if (target !== '') queue.push([target, dist]);
      continue;
    }
    if (object.type !== 'commit') {
      send.set(oid, object);
      continue;
    }
    send.set(oid, object);
    sentCommits.add(oid);
    const commit = parseCommit(object.data);
    includeTreeClosure(commit.tree);
    if (depth !== undefined && dist === depth - 1) newShallow.push(oid);
    for (const parent of commit.parents) queue.push([parent, dist + 1]);
  }

  const unshallow: string[] = [];
  if (depth !== undefined) {
    for (const old of request.shallow) {
      if (newShallow.includes(old)) continue;
      const commit = store.readCommit(repo, old);
      if (commit !== undefined && commit.parents.some((parent) => sentCommits.has(parent))) unshallow.push(old);
    }
  }
  return { objects: [...send.values()], newShallow, unshallow };
}

/** Sideband framing: the pack bytes split into band-1 packets. */
function sidebandPack(pack: Buffer): Buffer {
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

function v2FetchResponse(plan: FetchPlan, depth: number | undefined): Buffer {
  const chunks: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), pktDelim()];
  if (depth !== undefined) {
    chunks.push(pktLine('shallow-info\n'));
    for (const oid of plan.newShallow) chunks.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) chunks.push(pktLine(`unshallow ${oid}\n`));
    chunks.push(pktDelim());
  }
  chunks.push(pktLine('packfile\n'));
  chunks.push(sidebandPack(writePack(plan.objects)));
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

function v0FetchResponse(plan: FetchPlan, depth: number | undefined): Buffer {
  const chunks: Buffer[] = [pktLine('NAK\n')];
  if (depth !== undefined) {
    for (const oid of plan.newShallow) chunks.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) chunks.push(pktLine(`unshallow ${oid}\n`));
  }
  chunks.push(sidebandPack(writePack(plan.objects)));
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

export function handleUploadPack(store: Store, owner: string, repoName: string, body: Buffer, gitProtocol: string | undefined): HttpResult {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  let lines: string[];
  try {
    lines = requestLines(body);
  } catch {
    return jsonResult(400, { message: 'malformed pkt-line request' });
  }
  const command = lines.find((line) => line.startsWith('command='))?.slice(8).trim();
  if (gitProtocol === 'version=2') {
    if (command === 'ls-refs') {
      const peel = lines.some((line) => line.trim() === 'peel');
      const prefixes = lines.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice(11).trim());
      const refs = listRefs(repo);
      const chunks: Buffer[] = [];
      const tip = defaultTip(repo);
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
      const request = parseFetchLines(lines);
      const plan = planFetch(store, repo, request);
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v2FetchResponse(plan, request.depth) };
    }
    return jsonResult(400, { message: `unknown v2 command ${command ?? ''}` });
  }
  // v0 fetch.
  const request = parseFetchLines(lines);
  const plan = planFetch(store, repo, request);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v0FetchResponse(plan, request.depth) };
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parsePushCommands(body: Buffer): { commands: PushCommand[]; capabilities: string; pack: Buffer } {
  const { packets, rest } = splitAtFlush(body);
  const commands: PushCommand[] = [];
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
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  return { commands, capabilities, pack: rest };
}

export function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): HttpResult {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  let parsed: { commands: PushCommand[]; capabilities: string; pack: Buffer };
  try {
    parsed = parsePushCommands(body);
  } catch {
    return jsonResult(400, { message: 'malformed receive-pack request' });
  }
  const { commands, capabilities, pack } = parsed;
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
    for (const command of commands) reportLines.push(`ng ${command.ref} unpack error\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      let ok = false;
      if (command.newOid === ZERO_OID) {
        // Delete: the ref must exist and the old oid must match.
        if (current !== undefined && command.oldOid === current) {
          repo.refs.delete(command.ref);
          ok = true;
        }
      } else if (current === undefined) {
        // Create: the old oid must be zero and the new object must be stored.
        if (command.oldOid === ZERO_OID && repo.objects.has(command.newOid)) {
          repo.refs.set(command.ref, command.newOid);
          ok = true;
        }
      } else if (command.oldOid === current && store.isAncestor(repo, current, command.newOid)) {
        repo.refs.set(command.ref, command.newOid);
        ok = true;
      }
      reportLines.push(ok ? `ok ${command.ref}\n` : `ng ${command.ref} non-fast-forward\n`);
    }
  }
  if (sideband) {
    const chunks: Buffer[] = [];
    for (const line of reportLines) chunks.push(pktLine(Buffer.concat([Buffer.from([1]), pktLine(line)])));
    chunks.push(pktFlush());
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(chunks) };
  }
  const chunks = reportLines.map((line) => pktLine(line));
  chunks.push(pktFlush());
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(chunks) };
}
