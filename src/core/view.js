'use strict';
// What the viewer webview shows: a flat list of nodes (tree order) with decoded values, reg ranges, interrupts and
// resolved references, plus the file facts. Pure code, no vscode import, so the unit tests call it directly.
const M = require('./model');

const MAX_VALUE = 2000; // characters of one value drawn in the table (long blobs are cut, with a note)

function sizeText(n) {
  if (n < 1024) return `${n} bytes`;
  const u = ['KB', 'MB', 'GB']; let v = n / 1024; let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}
const plural = (n, w) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;

function build(doc, opts = {}) {
  const ids = new Map();
  const order = [];
  const visit = (n, parent, depth) => { ids.set(n, order.length); order.push({ n, parent, depth }); for (const c of n.children) visit(c, n, depth + 1); };
  visit(doc.root, null, 0);
  for (const o of doc.orphans || []) visit(o, null, 0);
  const dtsLines = opts.lineOf || null;
  const nodes = order.map(({ n, parent, depth }, id) => {
    const props = n.props.map((p) => {
      let parts = M.valueParts(p).map(([s, t]) => [s, t && ids.has(t) ? ids.get(t) : -1]);
      let cut = false;
      let len = 0;
      const kept = [];
      for (const x of parts) { if (len > MAX_VALUE) { cut = true; break; } kept.push(x); len += x[0].length; }
      parts = kept;
      return { name: p.name, parts, line: p.line || 0, cut, bytes: p.raw ? p.raw.length : undefined };
    });
    const reg = n.parent ? M.regOf(n) : null;
    const irqs = M.interruptsOf(doc, n);
    const st = M.statusOf(n);
    const compat = M.strProp(n, 'compatible');
    return {
      id, parent: parent ? ids.get(parent) : -1, depth, name: n === doc.root ? '/' : n.name, path: n.path, labels: n.labels.slice(),
      status: st, enabled: M.enabled(n), compatible: compat ? compat.join(', ') : '', orphan: !!n.orphan,
      line: doc.kind === 'dts' ? n.line || 0 : dtsLines && dtsLines.has(n) ? dtsLines.get(n) : 0,
      kids: n.children.length, props,
      reg: reg ? reg.entries.map((e) => ({ address: M.hex(e.address), size: e.size === null ? '' : M.hex(e.size), end: e.size ? M.hex(e.address + e.size - 1n) : '' })) : null,
      regCells: reg ? `#address-cells = ${reg.ac}, #size-cells = ${reg.sc} (from ${n.parent === doc.root ? '/' : n.parent.path})` : '',
      irqs: irqs ? irqs.map((q) => ({ ctl: q.parent ? (q.parent.labels[0] ? `&${q.parent.labels[0]}` : q.parent.path) : '(no interrupt-parent found)', ctlId: q.parent && ids.has(q.parent) ? ids.get(q.parent) : -1, cells: `<${q.cells.map((c) => (typeof c === 'bigint' ? M.hex(c) : c)).join(' ')}>` })) : null,
    };
  });
  return { nodes, facts: facts(doc, nodes) };
}

function facts(doc, nodes) {
  const f = [];
  const add = (k, v) => f.push({ k, v: String(v) });
  const propCount = nodes.reduce((s, n) => s + n.props.length, 0);
  const root = doc.root;
  const model = M.strProp(root, 'model');
  const compat = M.strProp(root, 'compatible');
  if (model) add('Model', model[0]);
  if (compat) add('Compatible', compat.join(', '));
  if (doc.kind === 'dtb') {
    const h = doc.header;
    add('Format', `${doc.overlay ? 'DTBO (overlay)' : 'DTB'}, version ${h.version}, last compatible version ${h.last_comp_version}`);
    add('Total size', `${sizeText(h.totalsize)} (${h.totalsize.toLocaleString('en-US')} bytes)`);
    add('Boot CPU', `0x${h.boot_cpuid_phys.toString(16)}`);
    add('Memory reservations', doc.reserve.length ? doc.reserve.map((r) => `${M.hex(r.address)} size ${M.hex(r.size)}`).join('; ') : 'none');
    add('Structure block', `${h.size_dt_struct.toLocaleString('en-US')} bytes at offset ${h.off_dt_struct}`);
    add('String table', `${h.size_dt_strings.toLocaleString('en-US')} bytes at offset ${h.off_dt_strings}`);
    if (doc.overlay) {
      const frags = root.children.filter((c) => /^fragment@/.test(c.name));
      const tgt = frags.map((fr) => { const tp = M.strProp(fr, 'target-path'); if (tp) return tp[0]; const t = M.cellsOf(M.prop(fr, 'target')); return t && t[0] ? (t[0].ref ? `&${t[0].ref}` : M.hex(t[0].n)) : '?'; });
      add('Fragments', `${frags.length}${tgt.length ? `: ${[...new Set(tgt)].slice(0, 20).join(', ')}` : ''}`);
    }
  } else {
    add('Format', `Device tree source${doc.v1 ? ' (/dts-v1/)' : ''}${doc.plugin ? ', overlay (/plugin/)' : ''}`);
    add('Includes', doc.includes.length ? doc.includes.map((x) => `${x.system ? `<${x.file}>` : `"${x.file}"`} (line ${x.line})`).join('; ') : 'none');
    if (doc.orphans.length) add('Changes to nodes defined elsewhere', `${doc.orphans.length} (&label blocks whose label comes from an included file)`);
    const d = Object.keys(doc.defines).length;
    if (d) add('Macros defined here', d);
    if (doc.reserve.length) add('Memory reservations', doc.reserve.map((r) => `${M.hex(r.address)} size ${M.hex(r.size)}`).join('; '));
  }
  add('Nodes', nodes.length.toLocaleString('en-US'));
  add('Properties', propCount.toLocaleString('en-US'));
  add('Labels', doc.labels.size.toLocaleString('en-US'));
  const off = nodes.filter((n) => n.status && n.status !== 'okay' && n.status !== 'ok').length;
  add('Status', `${nodes.filter((n) => n.status === 'okay' || n.status === 'ok').length} okay, ${off} disabled or other`);
  return f;
}

module.exports = { build, sizeText, plural };
