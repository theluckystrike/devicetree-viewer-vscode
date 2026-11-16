'use strict';
// One device tree model for both inputs: a DTB/DTBO read by fdt.js and a DTS read by dts.js.
// A document: { kind: 'dtb' | 'dts', root, orphans, labels: Map(label -> node), phandles: Map(number -> node), header,
// reserve, includes, defines, plugin, errors }. A node: { name, path, parent, labels, props, children, line }.
// A property: { name, val: chunks, raw? (DTB bytes), line? }. Chunks are described in dts.js; DTB cells carry
// { n, ref?, target? } where a cell was found to be a phandle.
const fdt = require('./fdt');
const dts = require('./dts');

// ---------- property knowledge (Devicetree Specification 0.4, chapter 2 and the common bindings) ----------

const STRING_PROPS = /^(compatible|model|status|name|device_type|label|bootargs|stdout-path|linux,stdout-path|clock-output-names|.*-names|regulator-name|enable-method|method|entry-method|phy-mode|phy-connection-type|dr_mode|fsl,.*-name|pinctrl-names|target-path|function|groups|pins|default-state|linux,default-trigger|bias-.*names)$/;
const CELL_PROPS = /^(#.*-cells|reg|ranges|dma-ranges|interrupts|interrupts-extended|interrupt-parent|interrupt-map|interrupt-map-mask|phandle|linux,phandle|clock-frequency|timebase-frequency|reg-shift|reg-io-width|cache-.*|.*-supply|clocks|resets|dmas|.*-gpios?|gpios?|pwms|phys|power-domains|iommus|mboxes|pinctrl-\d+|virtual-reg|bus-range|cpu|target|.*-microvolt|.*-microamp|.*-us|.*-ms|.*-hz)$/;
// Specifier lists: <&phandle cells... &phandle cells...> where the cell count comes from the target node.
const SPEC = [
  [/^(assigned-clocks|assigned-clock-parents|clocks)$/, '#clock-cells'],
  [/^resets$/, '#reset-cells'], [/^dmas$/, '#dma-cells'], [/^pwms$/, '#pwm-cells'], [/^phys$/, '#phy-cells'],
  [/^power-domains$/, '#power-domain-cells'], [/^iommus$/, '#iommu-cells'], [/^mboxes$/, '#mbox-cells'],
  [/^interrupts-extended$/, '#interrupt-cells'], [/^io-channels$/, '#io-channel-cells'], [/^thermal-sensors$/, '#thermal-sensor-cells'],
  [/^cooling-device$/, '#cooling-cells'], [/^sound-dai$/, '#sound-dai-cells'], [/^interconnects$/, '#interconnect-cells'],
  [/^hwlocks$/, '#hwlock-cells'], [/^msi-parent$/, '#msi-cells'], [/^nvmem-cells$/, '#nvmem-cell-cells'],
  [/^gpio-ranges$/, 3], [/^((.+-)?gpios?)$/, '#gpio-cells'],
];
// Plain phandle lists: every cell is a phandle.
const PLAIN = /^(target|interrupt-parent|pinctrl-\d+|memory-region|remote-endpoint|phy-handle|next-level-cache|operating-points-v2|cpu|.*-supply|.*-handle|.*-parent|power-supply|i2c-bus|ddc-i2c-bus|nvmem|cpu-idle-states)$/;

function specOf(name) {
  if (/^(gpio-controller|ngpios|gpio-line-names|gpio-reserved-ranges|#.*)$/.test(name)) return null;
  for (const [re, cells] of SPEC) if (re.test(name)) return { cells };
  if (PLAIN.test(name)) return { cells: 0, plain: true };
  return null;
}

// ---------- DTB raw bytes -> chunks ----------

function printableStrings(raw) {
  if (!raw.length || raw[raw.length - 1] !== 0) return null;
  const out = [];
  let s = 0;
  let nul = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === 0) { out.push(Buffer.from(raw.slice(s, i)).toString('utf8')); s = i + 1; nul++; continue; }
    if (c < 0x20 && c !== 9 && c !== 10 && c !== 13) return null;
    if (c === 0x7f) return null;
  }
  // empty strings are fine while the NUL bytes are not more than the text bytes (the usual rule for telling text from cells)
  if (nul > raw.length - nul) return null;
  return out;
}

function decodeRaw(name, raw) {
  if (!raw || raw.length === 0) return [];
  const strs = printableStrings(raw);
  const cellish = raw.length % 4 === 0;
  if (strs && (STRING_PROPS.test(name) || !(cellish && CELL_PROPS.test(name)))) {
    // a 4-byte value that happens to look like text ("abc\0") stays cells unless the name says string
    if (!(cellish && raw.length === 4 && !STRING_PROPS.test(name) && strs[0].length < 3)) return strs.map((v) => ({ t: 'str', v }));
  }
  if (cellish) {
    const v = [];
    for (let i = 0; i < raw.length; i += 4) v.push({ n: BigInt(((raw[i] << 24) | (raw[i + 1] << 16) | (raw[i + 2] << 8) | raw[i + 3]) >>> 0) });
    return [{ t: 'cells', bits: 32, v }];
  }
  return [{ t: 'bytes', v: Array.from(raw) }];
}

// ---------- building documents ----------

function link(root) {
  const all = [];
  const visit = (n, parent, path) => {
    n.parent = parent; n.path = path; all.push(n);
    for (const c of n.children) visit(c, n, path === '/' ? `/${c.name}` : `${path}/${c.name}`);
  };
  visit(root, null, '/');
  return all;
}

const prop = (node, name) => (node ? node.props.find((p) => p.name === name) : undefined);
const cellsOf = (p) => (p && p.val.length === 1 && p.val[0].t === 'cells' ? p.val[0].v : null);
function numCells(p) {
  const c = cellsOf(p);
  if (!c || c.some((x) => x.n === undefined)) return null;
  return c.map((x) => x.n);
}
function u32Prop(node, name, dflt) { const n = numCells(prop(node, name)); return n && n.length >= 1 ? Number(n[0]) : dflt; }
function strProp(node, name) { const p = prop(node, name); return p && p.val.length && p.val.every((c) => c.t === 'str') ? p.val.map((c) => c.v) : null; }

function nodeByPath(root, path) {
  if (!path || path === '/') return root;
  let n = root;
  for (const part of path.replace(/^\//, '').replace(/\/$/, '').split('/')) {
    n = n.children.find((c) => c.name === part) || n.children.find((c) => c.name.split('@')[0] === part && !part.includes('@'));
    if (!n) return null;
  }
  return n;
}

/** Marks phandle cells in DTB properties with their target node (in place). */
function annotatePhandles(doc) {
  const { phandles } = doc;
  const fix = doc.fixups || new Map(); // "path:prop" -> [{ offset, label }]
  for (const n of doc.all) {
    if (prop(n, 'gpio-hog')) continue;
    for (const p of n.props) {
      const c = cellsOf(p);
      if (!c) continue;
      const fx = fix.get(`${n.path}:${p.name}`);
      if (fx) for (const f of fx) { const k = f.offset / 4; if (c[k]) { c[k].ref = f.label; c[k].unresolved = !doc.labels.has(f.label); c[k].target = doc.labels.get(f.label) || null; } }
      if (/^(phandle|linux,phandle)$/.test(p.name)) continue;
      const spec = specOf(p.name);
      if (!spec) continue;
      const marks = [];
      let ok = true;
      for (let k = 0; k < c.length;) {
        const ph = Number(c[k].n);
        const t = phandles.get(ph);
        if (!t) { if (c[k].ref) break; ok = false; break; } // an overlay fixup to an outside label: its cell count is unknown
        marks.push([k, t]);
        const cnt = spec.plain ? 0 : typeof spec.cells === 'number' ? spec.cells : u32Prop(t, spec.cells, -1);
        if (cnt < 0) { ok = false; break; }
        k += 1 + cnt;
        if (k > c.length) { ok = false; break; }
      }
      if (!ok) continue;
      for (const [k, t] of marks) { c[k].target = t; c[k].ref = labelOrPath(doc, t); }
    }
  }
}
function labelOrPath(doc, node) { return node.labels && node.labels.length ? node.labels[0] : `{${node.path}}`; }

/** Builds a document from DTB bytes. Throws fdt.FdtError on a broken blob. */
function fromDtb(bytes) {
  const t = fdt.read(bytes);
  const conv = (fn) => ({ name: fn.name, labels: [], props: fn.props.map((p) => ({ name: p.name, raw: p.raw, val: decodeRaw(p.name, p.raw) })), children: fn.children.map(conv) });
  const root = conv(t.root);
  const all = link(root);
  const doc = { kind: 'dtb', root, orphans: [], all, header: t.header, reserve: t.reserve, counts: t.counts, size: t.bytes, labels: new Map(), phandles: new Map(), includes: [], defines: {}, errors: [] };
  for (const n of all) for (const pn of ['phandle', 'linux,phandle']) { const v = numCells(prop(n, pn)); if (v && v.length === 1 && !doc.phandles.has(Number(v[0]))) doc.phandles.set(Number(v[0]), n); }
  const sym = root.children.find((c) => c.name === '__symbols__');
  if (sym) for (const p of sym.props) { const s = strProp(sym, p.name); if (s && s.length === 1) { const n = nodeByPath(root, s[0]); if (n) { n.labels.push(p.name); if (!doc.labels.has(p.name)) doc.labels.set(p.name, n); } } }
  const fx = root.children.find((c) => c.name === '__fixups__');
  doc.overlay = !!(fx || root.children.some((c) => /^fragment@/.test(c.name) || c.name === '__overlay__'));
  if (fx) {
    doc.fixups = new Map();
    for (const p of fx.props) for (const s of strProp(fx, p.name) || []) {
      const m = /^(.*):([^:]+):(\d+)$/.exec(s);
      if (!m) continue;
      const k = `${m[1]}:${m[2]}`;
      if (!doc.fixups.has(k)) doc.fixups.set(k, []);
      doc.fixups.get(k).push({ offset: Number(m[3]), label: p.name });
    }
  }
  annotatePhandles(doc);
  return doc;
}

/** Builds a document from DTS text (one file, no preprocessor). Never throws: syntax errors land in doc.errors. */
function fromDts(text) {
  const parsed = dts.parse(text);
  const m = dts.merge(parsed);
  const all = link(m.root);
  for (const o of m.orphans) { const sub = link(o); sub.forEach((n) => { n.path = n === o ? o.name : `${o.name}${n.path}`; }); all.push(...sub); }
  const doc = { kind: 'dts', root: m.root, hasRoot: m.hasRoot, orphans: m.orphans, all, header: null, reserve: parsed.memreserve, labels: new Map(), phandles: new Map(), includes: parsed.includes, defines: parsed.defines, plugin: parsed.plugin, v1: parsed.v1, errors: parsed.errors, lines: parsed.lines };
  for (const n of all) for (const l of n.labels) if (!doc.labels.has(l)) doc.labels.set(l, n);
  for (const n of all) for (const p of n.props) for (const ch of p.val) {
    if (ch.t === 'cells') for (const c of ch.v) if (c.ref !== undefined) c.target = resolveRef(doc, c);
    if (ch.t === 'ref') ch.target = resolveRef(doc, { ref: ch.v, path: ch.path });
  }
  return doc;
}
function resolveRef(doc, r) { return r.path ? nodeByPath(doc.root, r.ref) : doc.labels.get(r.ref) || null; }

// ---------- formatting ----------

const hex = (n) => `0x${BigInt(n).toString(16)}`;
function escapeStr(s) { return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r'); }
function refText(c) { return c.path ? `&{${c.ref}}` : c.ref && c.ref.startsWith('{') ? `&${c.ref}` : `&${c.ref}`; }

/** Value parts for display: [[text, targetNode|null], ...]. dtsMode prints numbers for unresolved overlay fixups. */
function valueParts(p, dtsMode) {
  const parts = [];
  const add = (s, t = null) => parts.push([s, t]);
  p.val.forEach((ch, i) => {
    if (i) add(', ');
    if (ch.t === 'str') add(`"${escapeStr(ch.v)}"`);
    else if (ch.t === 'bytes') add(`[${ch.v.map((b) => b.toString(16).padStart(2, '0')).join(' ')}]`);
    else if (ch.t === 'ref') add(ch.path ? `&{${ch.v}}` : `&${ch.v}`, ch.target || null);
    else if (ch.t === 'macro') add(ch.v);
    else if (ch.t === 'cells') {
      add(`${ch.bits !== 32 ? `/bits/ ${ch.bits} ` : ''}<`);
      ch.v.forEach((c, k) => {
        if (k) add(' ');
        if (c.ref !== undefined && !(dtsMode && (c.unresolved || (c.n !== undefined && !c.target)))) add(refText(c), c.target || null);
        else if (c.n !== undefined) add(hex(c.n));
        else add(c.expr);
      });
      add('>');
    }
  });
  return parts;
}
const valueText = (p, dtsMode) => valueParts(p, dtsMode).map((x) => x[0]).join('');

/** DTS text of a document, with the line of each node (1-based). */
function toDts(doc) {
  const lines = ['/dts-v1/;'];
  if (doc.plugin || (doc.kind === 'dtb' && doc.overlay && false)) lines.push('/plugin/;');
  const lineOf = new Map();
  const rsv = doc.kind === 'dtb' ? doc.reserve : [];
  if (rsv.length) { lines.push(''); for (const r of rsv) lines.push(`/memreserve/ ${hex(r.address)} ${hex(r.size)};`); }
  lines.push('');
  const emit = (n, depth) => {
    const ind = '\t'.repeat(depth);
    lineOf.set(n, lines.length + 1);
    const head = n === doc.root ? '/' : n.name;
    lines.push(`${ind}${n !== doc.root ? n.labels.filter((l) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(l)).map((l) => `${l}: `).join('') : ''}${head} {`);
    for (const p of n.props) lines.push(`${ind}\t${p.name}${p.val.length ? ` = ${valueText(p, true)}` : ''};`);
    for (const c of n.children) { if (n.props.length || c !== n.children[0]) lines.push(''); emit(c, depth + 1); }
    lines.push(`${ind}};`);
  };
  emit(doc.root, 0);
  for (const o of doc.orphans || []) { lines.push(''); emit(o, 0); }
  return { text: lines.join('\n') + '\n', lineOf };
}

// ---------- JSON and YAML ----------

function jsonChunk(ch) {
  if (ch.t === 'str') return ch.v;
  if (ch.t === 'bytes') return ch.v.map((b) => b.toString(16).padStart(2, '0')).join('');
  if (ch.t === 'ref') return ch.path ? `&{${ch.v}}` : `&${ch.v}`;
  if (ch.t === 'macro') return ch.v;
  return ch.v.map((c) => (c.ref !== undefined && (c.target || c.n === undefined) ? refText(c) : c.n !== undefined ? (c.n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(c.n) : hex(c.n)) : c.expr));
}
function jsonValue(p) {
  if (!p.val.length) return true;
  if (p.val.every((c) => c.t === 'str')) return p.val.length === 1 ? p.val[0].v : p.val.map((c) => c.v);
  if (p.val.length === 1) return jsonChunk(p.val[0]);
  return p.val.map(jsonChunk);
}
function toJsonObject(doc) {
  const node = (n) => {
    const o = { name: n === doc.root ? '/' : n.name, path: n.path };
    if (n.labels.length) o.labels = n.labels.slice();
    o.properties = {};
    for (const p of n.props) o.properties[p.name] = jsonValue(p);
    o.children = n.children.map(node);
    return o;
  };
  const out = { format: doc.kind === 'dtb' ? (doc.overlay ? 'dtbo' : 'dtb') : 'dts', root: node(doc.root) };
  if (doc.kind === 'dtb') { out.header = { version: doc.header.version, last_comp_version: doc.header.last_comp_version, boot_cpuid_phys: doc.header.boot_cpuid_phys }; out.memreserve = doc.reserve.map((r) => ({ address: hex(r.address), size: hex(r.size) })); }
  if (doc.orphans && doc.orphans.length) out.references = doc.orphans.map(node);
  return out;
}
const toJson = (doc) => JSON.stringify(toJsonObject(doc), null, 2) + '\n';

function yamlScalar(v, flow) {
  if (v === true || v === false || v === null) return String(v);
  if (typeof v === 'number') return String(v);
  const s = String(v);
  const plain = flow ? /^[A-Za-z_/][A-Za-z0-9_.@/+-]*$/ : /^[A-Za-z_/][A-Za-z0-9_.,@/+-]*$/;
  if (plain.test(s) && !/^(true|false|null|yes|no|on|off|y|n)$/i.test(s)) return s;
  return JSON.stringify(s);
}
function toYaml(doc) {
  const out = [];
  const emit = (v, ind, key) => {
    const pad = '  '.repeat(ind);
    const k = key === undefined ? '' : `${yamlScalar(key)}:`;
    if (Array.isArray(v)) {
      if (!v.length) { out.push(`${pad}${k} []`); return; }
      if (v.every((x) => typeof x !== 'object' || x === null)) { out.push(`${pad}${k}${k ? ' ' : ''}[${v.map((x) => yamlScalar(x, true)).join(', ')}]`); return; }
      if (k) out.push(`${pad}${k}`);
      for (const x of v) {
        if (x && typeof x === 'object' && !Array.isArray(x)) {
          const sub = []; const save = out.length; emit(x, ind + 1); const lines = out.splice(save);
          lines[0] = `${pad}- ${lines[0].trimStart()}`; out.push(...lines); void sub;
        } else if (Array.isArray(x)) out.push(`${pad}- [${x.map((y) => yamlScalar(y, true)).join(', ')}]`);
        else out.push(`${pad}- ${yamlScalar(x)}`);
      }
      return;
    }
    if (v && typeof v === 'object') {
      if (k) out.push(`${pad}${k}`);
      const keys = Object.keys(v);
      if (!keys.length) { if (k) out[out.length - 1] += ' {}'; else out.push(`${pad}{}`); return; }
      for (const kk of keys) emit(v[kk], k ? ind + 1 : ind, kk);
      return;
    }
    out.push(`${pad}${k} ${yamlScalar(v)}`);
  };
  emit(toJsonObject(doc), 0);
  return out.join('\n') + '\n';
}

// ---------- compiler (DTS -> DTB) ----------

class CompileError extends Error { constructor(msg, line) { super(line ? `Line ${line}: ${msg}` : msg); this.line = line; } }

function expandMacros(text, defines, depth = 0) {
  if (depth > 20) throw new CompileError(`macros nest too deep in "${text}"`);
  let changed = false;
  const out = text.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\b(\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\))?/g, (m, name, call, args) => {
    const d = defines[name];
    if (!d) return m;
    changed = true;
    if (d.params) {
      if (call === undefined) return m;
      const vals = args.split(',').map((x) => x.trim());
      let b = d.body;
      d.params.forEach((pn, i) => { b = b.replace(new RegExp(`\\b${pn}\\b`, 'g'), vals[i] !== undefined ? `(${vals[i]})` : ''); });
      return `(${b})`;
    }
    return `(${d.body})${call || ''}`;
  });
  return changed ? expandMacros(out, defines, depth + 1) : out;
}

/** Evaluates a C integer expression (the subset device tree cells accept) with BigInt. */
function evalExpr(text, defines = {}, line) {
  const src = expandMacros(text, defines);
  const toks = [];
  const re = /\s*(0[xX][0-9a-fA-F]+[uUlL]*|[0-9]+[uUlL]*|'(?:\\.|[^\\'])'|[A-Za-z_][A-Za-z0-9_]*|<<|>>|<=|>=|==|!=|&&|\|\||[-+*/%()~!<>&^|?:])/y;
  let i = 0;
  while (i < src.length) {
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) { if (/^\s*$/.test(src.slice(i))) break; throw new CompileError(`cannot read the expression "${text}"`, line); }
    toks.push(m[1]); i = re.lastIndex;
  }
  let k = 0;
  const peek = () => toks[k];
  const next = () => toks[k++];
  const BIN = { '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6, '<': 7, '>': 7, '<=': 7, '>=': 7, '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10 };
  const M64 = (1n << 64n) - 1n;
  function primary() {
    const t = next();
    if (t === undefined) throw new CompileError(`the expression "${text}" ends too early`, line);
    if (t === '(') { const v = ternary(); if (next() !== ')') throw new CompileError(`missing ")" in "${text}"`, line); return v; }
    if (t === '-') return (-primary()) & M64;
    if (t === '+') return primary();
    if (t === '~') return (~primary()) & M64;
    if (t === '!') return primary() === 0n ? 1n : 0n;
    if (/^[0-9]/.test(t)) { const s = t.replace(/[uUlL]+$/, ''); return s.startsWith('0x') || s.startsWith('0X') ? BigInt(s) : s.length > 1 && s[0] === '0' ? BigInt('0o' + s.slice(1)) : BigInt(s); }
    if (t[0] === "'") { const c = t.slice(1, -1); return BigInt(c.length === 2 ? ({ n: 10, t: 9, r: 13, 0: 0 })[c[1]] ?? c.charCodeAt(1) : c.charCodeAt(0)); }
    throw new CompileError(`"${t}" is not defined in this file (a macro from an included header?)`, line);
  }
  function binary(minPrec) {
    let l = primary();
    for (;;) {
      const op = peek();
      const p = BIN[op];
      if (!p || p < minPrec) return l;
      next();
      const r = binary(p + 1);
      switch (op) {
        case '+': l = (l + r) & M64; break; case '-': l = (l - r) & M64; break; case '*': l = (l * r) & M64; break;
        case '/': if (r === 0n) throw new CompileError(`division by zero in "${text}"`, line); l = l / r; break;
        case '%': if (r === 0n) throw new CompileError(`division by zero in "${text}"`, line); l = l % r; break;
        case '<<': l = (l << r) & M64; break; case '>>': l = l >> r; break;
        case '&': l = l & r; break; case '|': l = l | r; break; case '^': l = l ^ r; break;
        case '==': l = l === r ? 1n : 0n; break; case '!=': l = l !== r ? 1n : 0n; break;
        case '<': l = l < r ? 1n : 0n; break; case '>': l = l > r ? 1n : 0n; break; case '<=': l = l <= r ? 1n : 0n; break; case '>=': l = l >= r ? 1n : 0n; break;
        case '&&': l = l && r ? 1n : 0n; break; case '||': l = l || r ? 1n : 0n; break;
        default: break;
      }
    }
  }
  function ternary() {
    const c = binary(1);
    if (peek() !== '?') return c;
    next(); const a = ternary(); if (next() !== ':') throw new CompileError(`missing ":" in "${text}"`, line); const b = ternary();
    return c ? a : b;
  }
  const v = ternary();
  if (k !== toks.length) throw new CompileError(`unexpected "${toks[k]}" in "${text}"`, line);
  return v;
}

/** Compiles a DTS document to DTB bytes. Throws CompileError with the line of the first problem. */
function compile(doc) {
  if (doc.kind !== 'dts') throw new CompileError('Only a DTS source can be compiled.');
  if (doc.errors.length) throw new CompileError(doc.errors[0].message, doc.errors[0].line);
  if (!doc.hasRoot) throw new CompileError('The file has no root node "/ { ... };", so there is no tree to compile (a .dtsi or an overlay is compiled with the file that includes it).');
  if (doc.orphans.length) { const o = doc.orphans[0]; throw new CompileError(`${o.name} refers to a label that is not defined in this file (it comes from an included file).`, o.line); }
  const nodes = link(doc.root);
  // phandles: keep explicit ones, give the others the next free number
  const used = new Set();
  const ph = new Map();
  for (const n of nodes) { const p = prop(n, 'phandle') || prop(n, 'linux,phandle'); if (p) { const c = cellsOf(p); if (c && c.length === 1) { const v = c[0].n !== undefined ? c[0].n : evalExpr(c[0].expr, doc.defines, p.line); used.add(Number(v)); ph.set(n, Number(v)); } } }
  let nextPh = 1;
  const want = (t, line, ref) => {
    if (!t) throw new CompileError(`the reference &${ref} points to no node in this file`, line);
    if (!ph.has(t)) { while (used.has(nextPh)) nextPh++; ph.set(t, nextPh); used.add(nextPh); t.__newPhandle = nextPh; }
    return ph.get(t);
  };
  const enc = (n, line) => {
    const out = [];
    for (const p of n.props) {
      const parts = [];
      for (const ch of p.val) {
        if (ch.t === 'str') parts.push(Buffer.from(ch.v + '\0', 'utf8'));
        else if (ch.t === 'bytes') parts.push(Buffer.from(ch.v));
        else if (ch.t === 'macro') throw new CompileError(`"${ch.v}" in "${p.name}" is a macro this file does not define`, p.line);
        else if (ch.t === 'ref') { if (!ch.target) throw new CompileError(`the reference &${ch.v} in "${p.name}" points to no node in this file`, p.line); parts.push(Buffer.from(ch.target.path + '\0', 'utf8')); }
        else if (ch.t === 'cells') {
          const w = ch.bits / 8;
          const b = Buffer.alloc(ch.v.length * w);
          const mask = (1n << BigInt(ch.bits)) - 1n;
          ch.v.forEach((c, k) => {
            let v;
            if (c.ref !== undefined) { if (ch.bits !== 32) throw new CompileError(`a reference in /bits/ ${ch.bits} cells of "${p.name}"`, p.line); v = BigInt(want(c.target, p.line, c.path ? `{${c.ref}}` : c.ref)); }
            else if (c.n !== undefined) v = c.n;
            else v = evalExpr(c.expr, doc.defines, p.line);
            v &= mask;
            if (w === 1) b.writeUInt8(Number(v), k); else if (w === 2) b.writeUInt16BE(Number(v), k * 2); else if (w === 4) b.writeUInt32BE(Number(v), k * 4); else b.writeBigUInt64BE(v, k * 8);
          });
          parts.push(b);
        }
      }
      out.push({ name: p.name, raw: new Uint8Array(Buffer.concat(parts)) });
    }
    void line;
    return out;
  };
  const conv = (n) => ({ name: n.name, props: enc(n), children: n.children.map(conv), src: n });
  const tree = conv(doc.root);
  // add the phandle property to nodes that got a new number (the usual compiler behaviour)
  const addPh = (t) => { if (t.src.__newPhandle) { const b = Buffer.alloc(4); b.writeUInt32BE(t.src.__newPhandle); t.props.push({ name: 'phandle', raw: new Uint8Array(b) }); delete t.src.__newPhandle; } t.children.forEach(addPh); };
  addPh(tree);
  // labels as a __symbols__ node (the symbols table overlays need), unless the source already has one
  if (!tree.children.some((c) => c.name === '__symbols__')) {
    const sym = [];
    for (const n of nodes) for (const l of n.labels) if (n !== doc.root && !sym.some((x) => x.name === l)) sym.push({ name: l, raw: new Uint8Array(Buffer.from(n.path + '\0', 'utf8')) });
    if (sym.length) tree.children.push({ name: '__symbols__', props: sym, children: [] });
  }
  const reserve = (doc.reserve || []).map((r) => ({ address: r.address, size: r.size }));
  return fdt.write({ root: tree, reserve, bootCpu: 0 });
}

// ---------- reg, interrupts, status ----------

function addrCells(parent) { return u32Prop(parent, '#address-cells', 2); }
function sizeCells(parent) { return u32Prop(parent, '#size-cells', 1); }
const join = (cells) => cells.reduce((a, c) => (a << 32n) | c, 0n);

/** reg decoded with the parent's #address-cells and #size-cells: [{ address, size }] (BigInt), or null. */
function regOf(node) {
  const p = prop(node, 'reg');
  if (!p || !node.parent) return null;
  const c = numCells(p);
  if (!c) return null;
  const ac = addrCells(node.parent), sc = sizeCells(node.parent);
  if (ac + sc === 0 || c.length % (ac + sc) !== 0) return null;
  const out = [];
  for (let i = 0; i < c.length; i += ac + sc) out.push({ address: join(c.slice(i, i + ac)), size: sc ? join(c.slice(i + ac, i + ac + sc)) : null });
  return { ac, sc, entries: out };
}

function interruptParent(doc, node) {
  for (let n = node; n; n = n.parent) {
    const p = prop(n, 'interrupt-parent');
    if (p) { const c = cellsOf(p); if (c && c[0]) return c[0].target || (c[0].n !== undefined ? doc.phandles.get(Number(c[0].n)) : null) || null; return null; }
  }
  return null;
}

/** interrupts grouped by the interrupt parent's #interrupt-cells: { parent, groups: [[cell text...]] } or null. */
function interruptsOf(doc, node) {
  const p = prop(node, 'interrupts');
  const out = [];
  if (p) {
    const c = cellsOf(p);
    if (c) {
      const par = interruptParent(doc, node);
      const n = (par && u32Prop(par, '#interrupt-cells', 1)) || 1;
      for (let i = 0; i < c.length; i += n) out.push({ parent: par, cells: c.slice(i, i + n).map((x) => (x.n !== undefined ? x.n : x.expr)) });
    }
  }
  const e = prop(node, 'interrupts-extended');
  if (e) {
    const c = cellsOf(e);
    if (c) for (let i = 0; i < c.length;) {
      const t = c[i].target || null;
      const n = t ? u32Prop(t, '#interrupt-cells', 1) : 1;
      out.push({ parent: t, cells: c.slice(i + 1, i + 1 + n).map((x) => (x.n !== undefined ? x.n : x.expr)) });
      i += 1 + n;
    }
  }
  return out.length ? out : null;
}

function statusOf(node) {
  const s = strProp(node, 'status');
  if (!s) return '';
  return s[0];
}
const enabled = (node) => { for (let n = node; n; n = n.parent) { const s = statusOf(n); if (s && s !== 'okay' && s !== 'ok') return false; } return true; };

/** Loads a document from bytes and a file name: DTB/DTBO when the magic is there, DTS text otherwise. */
function load(bytes, name) {
  if (fdt.isFdt(bytes)) return fromDtb(bytes);
  if (/\.dtbo?$/i.test(name || '')) throw new fdt.FdtError(bytes.length === 0 ? 'The file is empty.' : `This file does not start with the device tree magic 0xd00dfeed (it starts with 0x${Buffer.from(bytes.slice(0, 4)).toString('hex').padEnd(8, '0')}), so it is not a compiled device tree.`);
  return fromDts(Buffer.from(bytes).toString('utf8'));
}

module.exports = {
  decodeRaw, fromDtb, fromDts, load, toDts, toJson, toJsonObject, toYaml, compile, evalExpr, expandMacros, CompileError,
  valueParts, valueText, regOf, interruptsOf, interruptParent, statusOf, enabled, prop, cellsOf, numCells, strProp, u32Prop,
  nodeByPath, specOf, hex, link, addrCells, sizeCells,
};
