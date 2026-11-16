'use strict';
// Flattened Device Tree (DTB, DTBO) reader and writer, written for this extension from the public Devicetree
// Specification (release 0.4, chapter 5 "Flattened Devicetree (DTB) Format"). No code from other device tree tools.
// read(bytes) -> { header, reserve: [{ address, size }], root } where every node is { name, props: [{ name, raw }],
// children } and raw is a Uint8Array. write(tree) builds a version 17 blob from the same shape.

const MAGIC = 0xd00dfeed;
const FDT_BEGIN_NODE = 1, FDT_END_NODE = 2, FDT_PROP = 3, FDT_NOP = 4, FDT_END = 9;
const HEADER_SIZE = 40;

class FdtError extends Error {}

function isFdt(bytes) {
  return !!bytes && bytes.length >= 4 && ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0 === MAGIC;
}

const u32 = (dv, o) => dv.getUint32(o, false);

function readHeader(bytes) {
  if (bytes.length < HEADER_SIZE) throw new FdtError(`The file is ${bytes.length} bytes, shorter than the 40-byte device tree header.`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const h = {
    magic: u32(dv, 0), totalsize: u32(dv, 4), off_dt_struct: u32(dv, 8), off_dt_strings: u32(dv, 12), off_mem_rsvmap: u32(dv, 16),
    version: u32(dv, 20), last_comp_version: u32(dv, 24), boot_cpuid_phys: u32(dv, 28), size_dt_strings: u32(dv, 32), size_dt_struct: u32(dv, 36),
  };
  if (h.magic !== MAGIC) throw new FdtError(`The file does not start with the device tree magic 0xd00dfeed (it starts with 0x${h.magic.toString(16).padStart(8, '0')}).`);
  if (h.version < 16) throw new FdtError(`Device tree version ${h.version} is older than 16, which this viewer does not read.`);
  if (h.totalsize > bytes.length) throw new FdtError(`The header says the tree is ${h.totalsize} bytes, but the file has only ${bytes.length}. The file is cut off.`);
  if (h.totalsize < HEADER_SIZE) throw new FdtError(`The header gives a total size of ${h.totalsize} bytes, less than the header itself.`);
  for (const [k, o, s] of [['structure block', h.off_dt_struct, h.size_dt_struct], ['strings block', h.off_dt_strings, h.size_dt_strings]]) {
    if (o + s > h.totalsize || o < HEADER_SIZE) throw new FdtError(`The ${k} (offset ${o}, ${s} bytes) lies outside the ${h.totalsize}-byte tree.`);
  }
  if (h.off_mem_rsvmap < HEADER_SIZE || h.off_mem_rsvmap >= h.totalsize) throw new FdtError(`The memory reservation map offset ${h.off_mem_rsvmap} lies outside the tree.`);
  return h;
}

function cstr(bytes, start, end) {
  let i = start;
  while (i < end && bytes[i] !== 0) i++;
  if (i >= end) return null;
  return { s: Buffer.from(bytes.buffer, bytes.byteOffset + start, i - start).toString('utf8'), next: i + 1 };
}

/** Reads a DTB or DTBO. Throws FdtError with a plain message when the blob is broken. */
function read(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const h = readHeader(bytes);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const reserve = [];
  for (let o = h.off_mem_rsvmap; ; o += 16) {
    if (o + 16 > h.totalsize) throw new FdtError('The memory reservation map has no end entry.');
    const address = dv.getBigUint64(o, false), size = dv.getBigUint64(o + 8, false);
    if (address === 0n && size === 0n) break;
    reserve.push({ address, size });
    if (reserve.length > 4096) throw new FdtError('The memory reservation map has more than 4096 entries.');
  }
  const sEnd = h.off_dt_strings + h.size_dt_strings;
  const strCache = new Map();
  const propName = (off) => {
    if (strCache.has(off)) return strCache.get(off);
    if (off >= h.size_dt_strings) throw new FdtError(`A property name points to string offset ${off}, past the ${h.size_dt_strings}-byte strings block.`);
    const r = cstr(bytes, h.off_dt_strings + off, sEnd);
    if (!r) throw new FdtError(`The property name at string offset ${off} has no end.`);
    strCache.set(off, r.s);
    return r.s;
  };
  const end = h.off_dt_struct + h.size_dt_struct;
  let o = h.off_dt_struct;
  const stack = [];
  let root = null;
  let nodes = 0, props = 0;
  const align = (x) => (x + 3) & ~3;
  for (;;) {
    if (o + 4 > end) throw new FdtError(`The structure block ends at byte ${end} before the end token. The file is cut off or damaged.`);
    const tok = u32(dv, o); o += 4;
    if (tok === FDT_BEGIN_NODE) {
      const r = cstr(bytes, o, end);
      if (!r) throw new FdtError(`A node name at byte ${o} has no end.`);
      o = align(r.next);
      const node = { name: r.s, props: [], children: [], offset: o };
      if (stack.length) stack[stack.length - 1].children.push(node);
      else if (root) throw new FdtError('The structure block has a second root node.');
      else root = node;
      stack.push(node);
      nodes++;
    } else if (tok === FDT_END_NODE) {
      if (!stack.length) throw new FdtError(`An end-of-node token at byte ${o - 4} has no open node.`);
      stack.pop();
    } else if (tok === FDT_PROP) {
      if (!stack.length) throw new FdtError(`A property at byte ${o - 4} sits outside any node.`);
      if (o + 8 > end) throw new FdtError(`A property header at byte ${o} is cut off.`);
      const len = u32(dv, o), nameoff = u32(dv, o + 4); o += 8;
      if (o + len > end) throw new FdtError(`A property at byte ${o} says it holds ${len} bytes, past the end of the structure block.`);
      stack[stack.length - 1].props.push({ name: propName(nameoff), raw: bytes.slice(o, o + len) });
      o = align(o + len);
      props++;
    } else if (tok === FDT_NOP) {
      // nothing
    } else if (tok === FDT_END) {
      if (stack.length) throw new FdtError(`The structure block ends with ${stack.length} node(s) still open.`);
      break;
    } else {
      throw new FdtError(`Unknown token 0x${tok.toString(16)} at byte ${o - 4} of the structure block.`);
    }
  }
  if (!root) throw new FdtError('The structure block has no root node.');
  return { header: h, reserve, root, counts: { nodes, props }, bytes: bytes.length };
}

/** Builds a version 17 DTB. tree: { root, reserve?: [{address, size}], bootCpu? }. Node props carry raw bytes. */
function write(tree) {
  const strings = [];
  const strOff = new Map();
  let strLen = 0;
  const nameOff = (n) => {
    if (strOff.has(n)) return strOff.get(n);
    const off = strLen; strOff.set(n, off); const b = Buffer.from(n + '\0', 'utf8'); strings.push(b); strLen += b.length; return off;
  };
  const parts = [];
  let len = 0;
  const push = (b) => { parts.push(b); len += b.length; };
  const tok = (t) => { const b = Buffer.alloc(4); b.writeUInt32BE(t); push(b); };
  const pad = () => { const p = (4 - (len % 4)) % 4; if (p) push(Buffer.alloc(p)); };
  const walk = (node, isRoot) => {
    tok(FDT_BEGIN_NODE);
    push(Buffer.from((isRoot ? '' : node.name) + '\0', 'utf8')); pad();
    for (const p of node.props) {
      const raw = Buffer.from(p.raw || []);
      tok(FDT_PROP);
      const hdr = Buffer.alloc(8); hdr.writeUInt32BE(raw.length, 0); hdr.writeUInt32BE(nameOff(p.name), 4); push(hdr);
      push(raw); pad();
    }
    for (const c of node.children) walk(c, false);
    tok(FDT_END_NODE);
  };
  walk(tree.root, true);
  tok(FDT_END);
  const struct = Buffer.concat(parts);
  const str = Buffer.concat(strings);
  const reserve = tree.reserve || [];
  const rsv = Buffer.alloc((reserve.length + 1) * 16);
  reserve.forEach((r, i) => { rsv.writeBigUInt64BE(BigInt(r.address), i * 16); rsv.writeBigUInt64BE(BigInt(r.size), i * 16 + 8); });
  const offRsv = HEADER_SIZE; // 40 is 8-byte aligned
  const offStruct = offRsv + rsv.length;
  const offStr = offStruct + struct.length;
  const total = offStr + str.length;
  const hdr = Buffer.alloc(HEADER_SIZE);
  [MAGIC, total, offStruct, offStr, offRsv, 17, 16, (tree.bootCpu >>> 0) || 0, str.length, struct.length].forEach((v, i) => hdr.writeUInt32BE(v >>> 0, i * 4));
  return new Uint8Array(Buffer.concat([hdr, rsv, struct, str]));
}

module.exports = { read, write, isFdt, readHeader, FdtError, MAGIC };
