// The git object layer: SHA-1 ids, commit and tree codecs, pack reading
// and writing (with OFS/REF delta resolution), and pkt-line framing.
// Everything here is pure bytes in, bytes out; the store owns the objects,
// the HTTP handlers own the wire.

import { inflateSync, deflateSync } from 'node:zlib';
import { createHash as createCryptoHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitParts {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** The SHA-1 hex of `buffer`. */
export function sha1hex(buffer: Buffer): string {
  return createCryptoHash('sha1').update(buffer).digest('hex');
}

/** The object id of a git object: sha1("<type> <length>\0" + data). */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const prefix = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1hex(Buffer.concat([prefix, data]));
}

/** Whether `value` is a 40-character hex object id (any case). */
export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

// ---------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------

export type GitPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' };

/** Encode one pkt-line carrying `payload` (a string or bytes). */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const size = body.length + 4;
  const head = Buffer.from(size.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

/** The flush packet, `0000`. */
export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** The delimiter packet, `0001`. */
export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Parse a buffer of pkt-lines into packets. Throws on a bad length prefix
 * or a truncated line. Returns the packets and the offset where parsing
 * stopped (the byte after the last complete packet). */
export function parsePktLines(buffer: Buffer): { packets: GitPacket[]; consumed: number } {
  const packets: GitPacket[] = [];
  let at = 0;
  while (at + 4 <= buffer.length) {
    const head = buffer.subarray(at, at + 4).toString('ascii');
    if (head === '0000') {
      packets.push({ kind: 'flush' });
      at += 4;
      continue;
    }
    if (head === '0001') {
      packets.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    const size = Number.parseInt(head, 16);
    if (!Number.isFinite(size) || size < 4 || at + size > buffer.length) {
      throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    }
    packets.push({ kind: 'data', payload: buffer.subarray(at + 4, at + size) });
    at += size;
  }
  if (at !== buffer.length) throw new Error('truncated pkt-line');
  return { packets, consumed: at };
}

/** Split a buffer at the first flush packet: the packets up to and
 * including it, and the bytes after it. */
export function splitAtFlush(buffer: Buffer): { packets: GitPacket[]; rest: Buffer } {
  let at = 0;
  const packets: GitPacket[] = [];
  while (at + 4 <= buffer.length) {
    const head = buffer.subarray(at, at + 4).toString('ascii');
    if (head === '0000') {
      packets.push({ kind: 'flush' });
      return { packets, rest: buffer.subarray(at + 4) };
    }
    if (head === '0001') {
      packets.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    const size = Number.parseInt(head, 16);
    if (!Number.isFinite(size) || size < 4 || at + size > buffer.length) {
      throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    }
    packets.push({ kind: 'data', payload: buffer.subarray(at + 4, at + size) });
    at += size;
  }
  throw new Error('no flush packet in git request');
}

// ---------------------------------------------------------------------------
// commits
// ---------------------------------------------------------------------------

/** Parse a commit object's bytes into its parts. The message is the text
 * after the blank line, with one trailing newline stripped (git stores the
 * message with a trailing newline; the API shows it without). */
export function parseCommit(data: Buffer): CommitParts {
  const text = data.toString('utf8');
  const gap = text.indexOf('\n\n');
  const head = gap === -1 ? text : text.slice(0, gap);
  let message = gap === -1 ? '' : text.slice(gap + 2);
  if (message.endsWith('\n')) message = message.slice(0, -1);
  const parts: CommitParts = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) parts.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parts.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) parts.author = line.slice(7);
    else if (line.startsWith('committer ')) parts.committer = line.slice(10);
  }
  return parts;
}

/** Build a commit object's bytes. `message` is stored with a trailing
 * newline, as git writes it. */
export function buildCommit(parts: CommitParts): Buffer {
  const lines: string[] = [`tree ${parts.tree}`];
  for (const parent of parts.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${parts.author}`);
  lines.push(`committer ${parts.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${parts.message}\n`, 'utf8');
}

/** Parse a tag object's bytes: object, type, tag name and tagger, then the
 * message after the blank line. */
export function parseTag(data: Buffer): { object: string; type: string; tag: string; message: string } {
  const text = data.toString('utf8');
  const gap = text.indexOf('\n\n');
  const head = gap === -1 ? text : text.slice(0, gap);
  const message = gap === -1 ? '' : text.slice(gap + 2).replace(/\n$/, '');
  const out = { object: '', type: '', tag: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4).trim();
  }
  return out;
}

// ---------------------------------------------------------------------------
// trees
// ---------------------------------------------------------------------------

/** Parse a tree object's bytes into entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space === -1) throw new Error('malformed tree: no space after mode');
    const nul = data.indexOf(0x00, space);
    if (nul === -1 || nul + 21 > data.length) throw new Error('malformed tree: no NUL after name');
    const mode = data.subarray(at, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    at = nul + 21;
  }
  return entries;
}

/** Git's tree sort: entries compare by name, with a directory's name
 * treated as if it ended in '/'. */
export function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Build a tree object's bytes from entries, sorted git's way. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const chunks: Buffer[] = [];
  for (const entry of sorted) {
    chunks.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    chunks.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// packs
// ---------------------------------------------------------------------------

interface PackEntry {
  type: GitObjectType;
  data: Buffer;
  deltaBase?: string | number;
}

const PACK_TYPES: Record<number, GitObjectType | 'ofs-delta' | 'ref-delta'> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
  6: 'ofs-delta',
  7: 'ref-delta',
};

/** Read one pack entry header: the first byte carries the type in bits 4-6
 * and the low 4 bits of the size; each following byte carries 7 more size
 * bits, starting at shift 4. Returns [typeNumber, size, nextOffset]. */
function readPackEntryHeader(data: Buffer, offset: number): [number, number, number] {
  let byte = data[offset]!;
  const typeNumber = (byte >> 4) & 0x7;
  let size = byte & 0x0f;
  let pos = offset + 1;
  let shift = 4;
  while ((byte & 0x80) !== 0) {
    byte = data[pos]!;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    pos += 1;
  }
  return [typeNumber, size, pos];
}

/** Adler-32, the checksum a zlib stream ends with. */
function adler32(buffer: Buffer): number {
  let a = 1;
  let b = 0;
  for (const byte of buffer) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** The length in bytes of the zlib stream starting at `start`, whose
 * decompressed form is `expectedSize` bytes. Node's inflateSync stops at
 * the end of one stream and ignores what follows, so the stream is
 * inflated once for its bytes; its end is the Adler-32 tail of those
 * bytes, verified by a second inflation of exactly that span. */
function packInflatedLength(pack: Buffer, start: number, expectedSize: number): number {
  const inflated = inflateSync(pack.subarray(start));
  if (inflated.length !== expectedSize) throw new Error('pack entry decompresses to the wrong size');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(adler32(inflated));
  let from = start + 2;
  for (;;) {
    const hit = pack.indexOf(tail, from);
    if (hit === -1) throw new Error('zlib stream end not found in pack');
    const end = hit + 4;
    try {
      const again = inflateSync(pack.subarray(start, end));
      if (again.length === expectedSize && again.equals(inflated)) return end - start;
    } catch {
      // A coincidental Adler-32 inside the deflate data: keep scanning.
    }
    from = hit + 1;
  }
}

/** Apply a git delta to `base`, returning the reconstructed object bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const varint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos]!;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = varint();
  if (sourceSize !== base.length) throw new Error('delta source size mismatch');
  const targetSize = varint();
  const parts: Buffer[] = [];
  let total = 0;
  while (pos < delta.length) {
    const opcode = delta[pos]!;
    pos += 1;
    if (opcode & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if (opcode & (1 << i)) {
          offset |= delta[pos]! << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (opcode & (0x10 << i)) {
          size |= delta[pos]! << (8 * i);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
      total += size;
    } else if (opcode !== 0) {
      parts.push(delta.subarray(pos, pos + opcode));
      pos += opcode;
      total += opcode;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (total !== targetSize) throw new Error('delta target size mismatch');
  return Buffer.concat(parts);
}

export interface ReadPackResult {
  version: number;
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/** Parse a whole packfile. Deltas are resolved against bases in the same
 * pack (OFS by negative offset, REF by object id). Throws on a bad header,
 * a bad tail checksum, or a truncated entry. */
export function readPack(pack: Buffer): ReadPackResult {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const tail = pack.subarray(pack.length - 20).toString('hex');
  const actual = sha1hex(pack.subarray(0, pack.length - 20));
  if (tail !== actual) throw new Error('pack tail checksum mismatch');
  const objects = new Map<string, GitObject>();
  const atOffset = new Map<number, GitObject>();
  let deltaCount = 0;
  let pos = 12;
  const waiting: Array<{ offset: number; type: GitObjectType; data: Buffer; base: string | number }> = [];
  for (let index = 0; index < count; index += 1) {
    const entryStart = pos;
    const [typeNumber, size, afterHeader] = readPackEntryHeader(pack, pos);
    pos = afterHeader;
    const kind = PACK_TYPES[typeNumber];
    if (kind === undefined) throw new Error(`unknown pack object type ${typeNumber}`);
    let base: string | number | undefined;
    if (kind === 'ofs-delta') {
      let byte = pack[pos]!;
      pos += 1;
      let offset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = pack[pos]!;
        pos += 1;
        offset = ((offset + 1) << 7) | (byte & 0x7f);
      }
      base = entryStart - offset;
    } else if (kind === 'ref-delta') {
      base = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    }
    const inflated = inflateSync(pack.subarray(pos));
    const consumed = packInflatedLength(pack, pos, size);
    pos += consumed;
    if (kind === 'ofs-delta' || kind === 'ref-delta') {
      deltaCount += 1;
      waiting.push({ offset: entryStart, type: 'blob', data: inflated, base: base as string | number });
      continue;
    }
    const type = kind as GitObjectType;
    const oid = hashObject(type, inflated);
    const object = { type, data: inflated };
    objects.set(oid, object);
    atOffset.set(entryStart, object);
  }
  // Resolve deltas in file order; a delta's base may itself be a delta.
  const fixDelta = (entry: { offset: number; type: GitObjectType; data: Buffer; base: string | number }): GitObject => {
    const baseObject = typeof entry.base === 'number' ? atOffset.get(entry.base) : objects.get(entry.base);
    if (baseObject === undefined) throw new Error('delta base not in pack');
    const data = applyDelta(baseObject.data, entry.data);
    const object = { type: baseObject.type, data };
    const oid = hashObject(object.type, data);
    objects.set(oid, object);
    atOffset.set(entry.offset, object);
    return object;
  };
  for (const entry of waiting) {
    // A waiting delta whose base is another waiting delta is resolved when
    // its turn comes only if the base was already resolved; walk the chain.
    const chain: typeof waiting = [];
    let current: { offset: number; type: GitObjectType; data: Buffer; base: string | number } | undefined = entry;
    const seen = new Set<number>();
    while (current !== undefined && !seen.has(current.offset)) {
      seen.add(current.offset);
      const baseObject = typeof current.base === 'number' ? atOffset.get(current.base) : objects.get(current.base);
      if (baseObject !== undefined) break;
      chain.push(current);
      current =
        typeof current.base === 'number' ? waiting.find((candidate) => candidate.offset === current!.base) : undefined;
    }
    for (let i = chain.length - 1; i >= 0; i -= 1) fixDelta(chain[i]!);
    if (!atOffset.has(entry.offset)) fixDelta(entry);
  }
  return { version, objects, deltaCount };
}

/** Write a packfile (version 2) holding `objects` plain, with no deltas:
 * header, one zlib-deflated entry per object, and the SHA-1 tail. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const typeNumbers: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  chunks.push(header);
  for (const object of objects) {
    const typeNumber = typeNumbers[object.type];
    const size = object.data.length;
    const head: number[] = [(typeNumber << 4) | (size & 0x0f)];
    let rest = size >> 4;
    while (rest > 0) {
      head[head.length - 1] |= 0x80;
      head.push(rest & 0x7f);
      rest >>= 7;
    }
    chunks.push(Buffer.from(head));
    chunks.push(deflateSync(object.data));
  }
  const body = Buffer.concat(chunks);
  const tail = Buffer.from(sha1hex(body), 'hex');
  return Buffer.concat([body, tail]);
}
