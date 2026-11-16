'use strict';
// Devicetree source (.dts, .dtsi, Zephyr .overlay) parser, written for this extension from the public Devicetree
// Specification (release 0.4, chapter 6 "Devicetree Source (DTS) Format"). No code from other device tree tools.
// The C preprocessor is not run: #include lines are listed, object-like #define values are kept for the compiler,
// and macro names in cells (GPIO_ACTIVE_HIGH, PWM_MSEC(20)) stay as text.
// parse(text) -> { root, refBlocks, includes, defines, memreserve, plugin, v1, errors } where a property value is a
// list of chunks: { t: 'str', v } | { t: 'cells', bits, v: [{ n: BigInt } | { ref } | { expr }] } | { t: 'bytes', v: [int] }
// | { t: 'ref', v } (a path reference). merge() applies repeated nodes, &label blocks and /delete-*/ the usual way.

const NAME_CH = /[A-Za-z0-9,._+*#?@-]/;
const LABEL_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DIRECTIVES = /^#\s*(include|define|undef|if|ifdef|ifndef|else|elif|endif|pragma|error|warning|line)\b/;

class DtsError extends Error { constructor(msg, line) { super(`Line ${line}: ${msg}`); this.line = line; this.short = msg; } }

function parse(text) {
  const src = String(text).replace(/^﻿/, '');
  let i = 0, line = 1;
  const out = { root: null, refBlocks: [], includes: [], defines: {}, memreserve: [], plugin: false, v1: false, errors: [], deletes: [], lines: src.split('\n').length };
  const peek = (k = 0) => src[i + k];
  const adv = (n = 1) => { for (let k = 0; k < n && i < src.length; k++) { if (src[i] === '\n') line++; i++; } };
  const fail = (msg) => { throw new DtsError(msg, line); };
  const atLineStart = () => { let k = i - 1; while (k >= 0 && (src[k] === ' ' || src[k] === '\t')) k--; return k < 0 || src[k] === '\n'; };

  function directive() {
    const startLine = line;
    let s = '';
    for (;;) { // a directive runs to the end of the line, with backslash continuations
      while (i < src.length && src[i] !== '\n') { s += src[i]; adv(); }
      if (s.endsWith('\\') && i < src.length) { s = s.slice(0, -1) + ' '; adv(); continue; }
      break;
    }
    s = s.replace(/\/\*.*?\*\//g, ' ').replace(/\/\/.*$/, '').trim();
    let m;
    if ((m = /^#\s*include\s*([<"])([^>"]+)[>"]/.exec(s))) out.includes.push({ file: m[2], system: m[1] === '<', line: startLine, kind: 'cpp' });
    else if ((m = /^#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)(\(([^)]*)\))?\s*(.*)$/.exec(s))) {
      out.defines[m[1]] = { params: m[2] ? m[3].split(',').map((x) => x.trim()).filter(Boolean) : null, body: m[4].trim(), line: startLine };
    } else if ((m = /^#\s*undef\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(s))) delete out.defines[m[1]];
  }

  function ws() {
    for (;;) {
      const c = src[i];
      if (c === undefined) return;
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { adv(); continue; }
      if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') adv(); continue; }
      if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); if (e < 0) fail('a /* comment has no end'); adv(e + 2 - i); continue; }
      if (c === '#' && atLineStart() && DIRECTIVES.test(src.slice(i, i + 12))) { directive(); continue; }
      return;
    }
  }
  const expect = (ch, what) => { ws(); if (src[i] !== ch) fail(`expected "${ch}"${what ? ` ${what}` : ''}, found ${src[i] === undefined ? 'the end of the file' : `"${src.slice(i, i + 12).split('\n')[0]}"`}`); adv(); };
  const startsWith = (s) => src.startsWith(s, i);

  function name() {
    const s = i;
    while (i < src.length && NAME_CH.test(src[i])) adv();
    return src.slice(s, i);
  }
  function quoted() {
    // at the opening quote
    adv();
    let s = '';
    while (i < src.length && src[i] !== '"') {
      if (src[i] === '\n') fail('a string has no closing quote');
      if (src[i] === '\\') {
        const n = src[i + 1];
        const map = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', '\\': '\\', '"': '"', "'": "'" };
        if (n in map) { s += map[n]; adv(2); continue; }
        if (n === 'x') { const m = /^[0-9a-fA-F]{1,2}/.exec(src.slice(i + 2)); if (m) { s += String.fromCharCode(parseInt(m[0], 16)); adv(2 + m[0].length); continue; } }
        if (/[0-7]/.test(n)) { const m = /^[0-7]{1,3}/.exec(src.slice(i + 1)); s += String.fromCharCode(parseInt(m[0], 8)); adv(1 + m[0].length); continue; }
        s += n; adv(2); continue;
      }
      s += src[i]; adv();
    }
    if (src[i] !== '"') fail('a string has no closing quote');
    adv();
    return s;
  }
  function reference() {
    // at '&'
    adv();
    if (src[i] === '{') { const e = src.indexOf('}', i); if (e < 0) fail('a &{/path} reference has no closing brace'); const p = src.slice(i + 1, e); adv(e + 1 - i); return { ref: p, path: true }; }
    const s = i;
    while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) adv();
    const l = src.slice(s, i);
    if (!l) fail('expected a label after "&"');
    return { ref: l };
  }
  function balanced(open, close) {
    // at open; returns the text including the brackets
    const s = i; let depth = 0;
    do {
      if (i >= src.length) fail(`a "${open}" has no matching "${close}"`);
      if (src[i] === open) depth++; else if (src[i] === close) depth--;
      adv();
    } while (depth > 0);
    return src.slice(s, i);
  }
  function number(tok) {
    const m = /^(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)([uUlL]*)$/.exec(tok);
    if (!m) return null;
    const t = m[1];
    return t.startsWith('0x') || t.startsWith('0X') ? BigInt(t) : t.length > 1 && t[0] === '0' ? BigInt('0o' + t.slice(1)) : BigInt(t);
  }
  function cells(bits) {
    // at '<'
    adv();
    const v = [];
    for (;;) {
      ws();
      const c = src[i];
      if (c === undefined) fail('a "<" cell list has no closing ">"');
      if (c === '>') { adv(); break; }
      if (c === '&') { v.push(reference()); continue; }
      if (c === '(') { v.push({ expr: balanced('(', ')') }); continue; }
      if (c === "'") {
        const m = /^'(\\.|[^\\'])'/.exec(src.slice(i));
        if (!m) fail('a character literal is not closed');
        const ch = m[1].length === 2 ? ({ n: 10, t: 9, r: 13, 0: 0, '\\': 92, "'": 39 })[m[1][1]] ?? m[1].charCodeAt(1) : m[1].charCodeAt(0);
        v.push({ n: BigInt(ch) }); adv(m[0].length); continue;
      }
      if (c === '-' || c === '~' || c === '!') { // a unary sign before a literal or macro: keep as an expression
        const s = i; adv(); ws();
        if (src[i] === '(') balanced('(', ')'); else { while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) adv(); }
        v.push({ expr: src.slice(s, i) }); continue;
      }
      if (/[A-Za-z0-9_]/.test(c)) {
        const s = i;
        while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) adv();
        let tok = src.slice(s, i);
        if (src[i] === ':' && LABEL_RE.test(tok)) { adv(); continue; } // a label inside the cells: ignored
        const n = number(tok);
        if (n !== null) { v.push({ n }); continue; }
        if (/^[0-9]/.test(tok)) fail(`"${tok}" is not a number`);
        if (src[i] === '(') tok += balanced('(', ')');
        v.push({ expr: tok });
        continue;
      }
      fail(`unexpected "${c}" in a cell list`);
    }
    return { t: 'cells', bits, v };
  }
  function bytesVal() {
    adv();
    const e = src.indexOf(']', i);
    if (e < 0) fail('a "[" byte string has no closing "]"');
    const body = src.slice(i, e).replace(/\s+/g, '');
    if (!/^([0-9a-fA-F]{2})*$/.test(body)) fail('a [byte string] must hold pairs of hex digits');
    adv(e + 1 - i);
    const v = [];
    for (let k = 0; k < body.length; k += 2) v.push(parseInt(body.slice(k, k + 2), 16));
    return { t: 'bytes', v };
  }
  function value() {
    const chunks = [];
    for (;;) {
      ws();
      const c = src[i];
      if (c === '"') chunks.push({ t: 'str', v: quoted() });
      else if (c === '<') chunks.push(cells(32));
      else if (c === '[') chunks.push(bytesVal());
      else if (c === '&') { const r = reference(); chunks.push({ t: 'ref', v: r.ref, path: !!r.path }); }
      else if (startsWith('/bits/')) {
        adv(6); ws();
        const s = i; while (i < src.length && /[0-9]/.test(src[i])) adv();
        const bits = Number(src.slice(s, i));
        if (![8, 16, 32, 64].includes(bits)) fail('/bits/ must be 8, 16, 32 or 64');
        ws(); if (src[i] !== '<') fail('expected "<" after /bits/');
        chunks.push(cells(bits));
      } else if (/[A-Za-z_]/.test(c || '')) { // a macro that expands to a value
        const s = i; while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) adv();
        let tok = src.slice(s, i); if (src[i] === '(') tok += balanced('(', ')');
        chunks.push({ t: 'macro', v: tok });
      } else if (c === ':') fail('a label inside a value is not supported');
      else fail(`expected a value ("string", <cells>, [bytes] or &label), found ${c === undefined ? 'the end of the file' : `"${c}"`}`);
      ws();
      if (src[i] === ',') { adv(); continue; }
      break;
    }
    return chunks;
  }
  function labels() {
    const ls = [];
    for (;;) {
      ws();
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:(?!:)/.exec(src.slice(i, i + 200));
      if (!m || src[i + m[0].length] === '=') break;
      ls.push(m[1]); adv(m[0].length);
    }
    return ls;
  }
  function body(node) {
    // after '{'
    for (;;) {
      ws();
      if (src[i] === undefined) fail(`node "${node.name || '/'}" has no closing "};"`);
      if (src[i] === '}') { adv(); expect(';', `after the "}" of node "${node.name || '/'}"`); return; }
      if (startsWith('/delete-property/')) { adv(17); ws(); const n = name(); expect(';'); node.items.push({ del: 'prop', name: n, line }); continue; }
      if (startsWith('/delete-node/')) { adv(13); ws(); let n; if (src[i] === '&') n = '&' + reference().ref; else n = name(); expect(';'); node.items.push({ del: 'node', name: n, line }); continue; }
      if (startsWith('/omit-if-no-ref/')) { adv(16); continue; }
      const ls = labels();
      ws();
      const startLine = line;
      const n = name();
      if (!n) fail(`expected a property or node name, found "${src.slice(i, i + 12).split('\n')[0]}"`);
      ws();
      if (src[i] === '{') { adv(); const child = { name: n, labels: ls, items: [], line: startLine }; node.items.push({ node: child }); body(child); child.endLine = line; continue; } // pushed first: a syntax error inside keeps what was read
      if (src[i] === '=') { adv(); const v = value(); expect(';', `after the value of "${n}"`); node.items.push({ prop: { name: n, labels: ls, val: v, line: startLine } }); continue; }
      if (src[i] === ';') { adv(); node.items.push({ prop: { name: n, labels: ls, val: [], line: startLine } }); continue; }
      fail(`expected "=", ";" or "{" after "${n}"`);
    }
  }

  const tops = [];
  try {
    for (;;) {
      ws();
      if (i >= src.length) break;
      if (startsWith('/dts-v1/')) { adv(8); expect(';'); out.v1 = true; continue; }
      if (startsWith('/plugin/')) { adv(8); expect(';'); out.plugin = true; continue; }
      if (startsWith('/include/')) { const l = line; adv(9); ws(); if (src[i] !== '"') fail('expected a "file" after /include/'); out.includes.push({ file: quoted(), system: false, line: l, kind: 'dts' }); continue; }
      if (startsWith('/memreserve/')) {
        const l = line; adv(12); ws();
        const a = cellsLike(); ws(); const s = cellsLike(); expect(';');
        out.memreserve.push({ address: a, size: s, line: l });
        continue;
      }
      if (startsWith('/delete-node/')) { const l = line; adv(13); ws(); const r = src[i] === '&' ? reference() : { ref: name(), path: true }; expect(';'); out.deletes.push({ ...r, line: l }); continue; }
      if (startsWith('/omit-if-no-ref/')) { adv(16); continue; }
      const ls = labels();
      ws();
      const startLine = line;
      if (src[i] === '/' ) {
        adv(); ws(); expect('{', 'after "/"');
        const n = { name: '', labels: ls, items: [], line: startLine }; tops.push({ root: n }); body(n); n.endLine = line;
        continue;
      }
      if (src[i] === '&') {
        const r = reference(); ws(); expect('{', `after "&${r.path ? `{${r.ref}}` : r.ref}"`);
        const n = { name: r.path ? `&{${r.ref}}` : `&${r.ref}`, labels: ls, items: [], line: startLine, target: r }; tops.push({ ref: n }); body(n); n.endLine = line;
        continue;
      }
      fail(`expected "/ {", "&label {" or a /directive/, found "${src.slice(i, i + 16).split('\n')[0]}"`);
    }
  } catch (e) {
    if (!(e instanceof DtsError)) throw e;
    out.errors.push({ line: e.line, message: e.short });
  }
  function cellsLike() {
    const s = i; while (i < src.length && /[0-9a-fA-FxX]/.test(src[i])) adv();
    const n = number(src.slice(s, i)); if (n === null) fail('/memreserve/ needs two numbers'); return n;
  }
  out.tops = tops;
  return out;
}

// ---------- merge into one tree ----------

function mkNode(name, line) { return { name, labels: [], props: [], children: [], line, lines: line ? [line] : [] }; }

function applyItems(node, items) {
  for (const it of items) {
    if (it.prop) {
      const k = node.props.findIndex((p) => p.name === it.prop.name);
      const p = { name: it.prop.name, labels: it.prop.labels, val: it.prop.val, line: it.prop.line };
      if (k >= 0) node.props[k] = p; else node.props.push(p);
    } else if (it.node) {
      let c = node.children.find((x) => x.name === it.node.name);
      if (!c) { c = mkNode(it.node.name, it.node.line); c.endLine = it.node.endLine; node.children.push(c); } else c.lines.push(it.node.line);
      for (const l of it.node.labels) if (!c.labels.includes(l)) c.labels.push(l);
      applyItems(c, it.node.items);
    } else if (it.del === 'prop') {
      node.props = node.props.filter((p) => p.name !== it.name);
    } else if (it.del === 'node') {
      if (it.name.startsWith('&')) node.deleteRefs = (node.deleteRefs || []).concat(it.name.slice(1));
      else node.children = node.children.filter((c) => c.name !== it.name && c.name.split('@')[0] !== it.name);
    }
  }
}

function walk(node, fn, path = '/') {
  fn(node, path);
  for (const c of node.children) walk(c, fn, path === '/' ? `/${c.name}` : `${path}/${c.name}`);
}

function labelMap(root) {
  const m = new Map();
  walk(root, (n, p) => { for (const l of n.labels) if (!m.has(l)) m.set(l, { node: n, path: p }); });
  return m;
}
function byPath(root, p) {
  if (p === '/' || p === '') return root;
  let n = root;
  for (const part of p.replace(/^\//, '').split('/')) {
    n = n.children.find((c) => c.name === part) || n.children.find((c) => c.name.split('@')[0] === part && !part.includes('@'));
    if (!n) return null;
  }
  return n;
}

/** Applies the parsed blocks in order: / { } blocks and &label { } blocks whose label is defined in this file. The
 *  others stay as orphans (their label comes from an included file). */
function merge(parsed) {
  const root = mkNode('', 0);
  const orphans = [];
  for (const t of parsed.tops || []) {
    if (t.root) { root.lines.push(t.root.line); if (!root.line) { root.line = t.root.line; root.endLine = t.root.endLine; } for (const l of t.root.labels) root.labels.push(l); applyItems(root, t.root.items); continue; }
    const r = t.ref;
    let target = null;
    if (r.target.path) target = byPath(root, r.target.ref);
    else { const hit = labelMap(root).get(r.target.ref); target = hit && hit.node; }
    if (target) { target.lines.push(r.line); for (const l of r.labels) if (!target.labels.includes(l)) target.labels.push(l); applyItems(target, r.items); continue; }
    let o = orphans.find((x) => x.name === r.name);
    if (!o) { o = mkNode(r.name, r.line); o.ref = r.target; o.endLine = r.endLine; o.orphan = true; orphans.push(o); } else o.lines.push(r.line);
    for (const l of r.labels) if (!o.labels.includes(l)) o.labels.push(l);
    applyItems(o, r.items);
  }
  // /delete-node/ &label at the top level and inside nodes
  const delLabels = new Set(parsed.deletes.filter((d) => !d.path).map((d) => d.ref));
  walk(root, (n) => { for (const l of n.deleteRefs || []) delLabels.add(l); });
  const delPaths = parsed.deletes.filter((d) => d.path).map((d) => d.ref);
  const prune = (n) => { n.children = n.children.filter((c) => !c.labels.some((l) => delLabels.has(l))); n.children.forEach(prune); };
  prune(root);
  for (const p of delPaths) { const parts = p.replace(/^\//, '').split('/'); const last = parts.pop(); const parent = byPath(root, '/' + parts.join('/')); if (parent) parent.children = parent.children.filter((c) => c.name !== last); }
  return { root, orphans, hasRoot: (parsed.tops || []).some((t) => t.root) };
}

module.exports = { parse, merge, walk, labelMap, byPath, DtsError, NAME_CH };
