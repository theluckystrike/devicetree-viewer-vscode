'use strict';
// Diff of two device trees by node path and property (Zovo Pro tool "Compare two device trees"). Works on any pair of
// documents from model.js (DTB vs DTB, DTS vs DTB, board A vs board B). Phandle numbers are compared by the node they
// point to, so two builds that number phandles differently do not show as changed. The generated nodes __symbols__,
// __fixups__ and __local_fixups__ and the phandle properties are left out.
const M = require('./model');

const SKIP_NODES = /^(__symbols__|__fixups__|__local_fixups__)$/;
const SKIP_PROPS = /^(phandle|linux,phandle)$/;

/** A property value in one canonical text: references as the path of the node they point to, adjacent 32-bit cell
 *  lists joined, macros evaluated where this file defines them, path references as the path string. */
function canon(p, doc) {
  const out = [];
  let cells = null;
  const flush = () => { if (cells) { out.push(`<${cells.join(' ')}>`); cells = null; } };
  for (const ch of p.val) {
    if (ch.t === 'cells' && ch.bits === 32) {
      cells = cells || [];
      for (const c of ch.v) {
        if (c.target) cells.push(`&{${c.target.path}}`);
        else if (c.ref !== undefined && c.n === undefined) cells.push(`&${c.ref}`);
        else if (c.n !== undefined) cells.push(M.hex(c.n));
        else { let v = null; try { v = M.evalExpr(c.expr, (doc && doc.defines) || {}) & 0xffffffffn; } catch (e) { v = null; } cells.push(v === null ? c.expr : M.hex(v)); }
      }
      continue;
    }
    flush();
    if (ch.t === 'ref' && ch.target) out.push(`"${ch.target.path}"`);
    else out.push(M.valueText({ val: [ch] }));
  }
  flush();
  return out.join(', ');
}

function index(doc) {
  const map = new Map();
  const visit = (n, path) => {
    map.set(path, n);
    for (const c of n.children) if (!(n === doc.root && SKIP_NODES.test(c.name))) visit(c, path === '/' ? `/${c.name}` : `${path}/${c.name}`);
  };
  visit(doc.root, '/');
  for (const o of doc.orphans || []) visit(o, o.name);
  return map;
}

/** Compares a and b. Returns { onlyA, onlyB, changed: [{ path, props: [{ name, a, b, kind }] }], same, nodesA, nodesB }. */
function diff(a, b) {
  const A = index(a), B = index(b);
  const onlyA = [], onlyB = [], changed = [];
  let same = 0;
  const under = (set, p) => set.some((x) => p.startsWith(x === '/' ? '/' : `${x}/`));
  for (const [p] of A) if (!B.has(p) && !under(onlyA, p)) onlyA.push(p);
  for (const [p] of B) if (!A.has(p) && !under(onlyB, p)) onlyB.push(p);
  for (const [p, na] of A) {
    const nb = B.get(p);
    if (!nb) continue;
    const props = [];
    const pa = new Map(na.props.filter((x) => !SKIP_PROPS.test(x.name)).map((x) => [x.name, x]));
    const pb = new Map(nb.props.filter((x) => !SKIP_PROPS.test(x.name)).map((x) => [x.name, x]));
    for (const [k, x] of pa) {
      const y = pb.get(k);
      if (!y) props.push({ name: k, a: canon(x, a), b: null, kind: 'removed' });
      else { const ca = canon(x, a), cb = canon(y, b); if (ca !== cb) props.push({ name: k, a: ca, b: cb, kind: 'changed' }); }
    }
    for (const [k, y] of pb) if (!pa.has(k)) props.push({ name: k, a: null, b: canon(y, b), kind: 'added' });
    if (props.length) changed.push({ path: p, props }); else same++;
  }
  return { onlyA, onlyB, changed, same, nodesA: A.size, nodesB: B.size, propChanges: changed.reduce((s, c) => s + c.props.length, 0) };
}

const mdCell = (s) => (s === null ? '(none)' : `\`${String(s).replace(/`/g, "'").replace(/\|/g, '\\|').slice(0, 400)}\``);

function summaryLine(r) {
  return `${r.onlyA.length} node${r.onlyA.length === 1 ? '' : 's'} only in A, ${r.onlyB.length} only in B, ${r.changed.length} node${r.changed.length === 1 ? '' : 's'} with ${r.propChanges} property change${r.propChanges === 1 ? '' : 's'}, ${r.same} node${r.same === 1 ? '' : 's'} the same.`;
}

function toMarkdown(r, nameA, nameB) {
  const L = [`# Device tree comparison`, '', `- A: ${nameA}`, `- B: ${nameB}`, '', summaryLine(r), ''];
  L.push(`## Nodes only in A (${r.onlyA.length})`, '');
  for (const p of r.onlyA) L.push(`- \`${p}\``);
  if (!r.onlyA.length) L.push('None.');
  L.push('', `## Nodes only in B (${r.onlyB.length})`, '');
  for (const p of r.onlyB) L.push(`- \`${p}\``);
  if (!r.onlyB.length) L.push('None.');
  L.push('', `## Changed properties (${r.propChanges} in ${r.changed.length} nodes)`, '');
  if (!r.changed.length) L.push('None.');
  for (const c of r.changed) {
    L.push(`### \`${c.path}\``, '', '| Property | Change | A | B |', '| --- | --- | --- | --- |');
    for (const p of c.props) L.push(`| ${p.name} | ${p.kind} | ${mdCell(p.a)} | ${mdCell(p.b)} |`);
    L.push('');
  }
  return L.join('\n').replace(/\n+$/, '') + '\n';
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function toHtml(r, nameA, nameB) {
  const rows = [];
  for (const c of r.changed) for (const p of c.props) rows.push(`<tr class="${p.kind}"><td>${esc(c.path)}</td><td>${esc(p.name)}</td><td>${p.kind}</td><td><code>${p.a === null ? '' : esc(p.a)}</code></td><td><code>${p.b === null ? '' : esc(p.b)}</code></td></tr>`);
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Device tree comparison</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;color:#222}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:3px 6px;text-align:left;vertical-align:top}code{white-space:pre-wrap;word-break:break-all}tr.added td{background:#eaf7ea}tr.removed td{background:#fbeaea}tr.changed td{background:#fff8e1}li code{font-size:13px}</style></head>
<body><h1>Device tree comparison</h1><p>A: ${esc(nameA)}<br>B: ${esc(nameB)}</p><p>${esc(summaryLine(r))}</p>
<h2>Nodes only in A (${r.onlyA.length})</h2><ul>${r.onlyA.map((p) => `<li><code>${esc(p)}</code></li>`).join('') || '<li>None.</li>'}</ul>
<h2>Nodes only in B (${r.onlyB.length})</h2><ul>${r.onlyB.map((p) => `<li><code>${esc(p)}</code></li>`).join('') || '<li>None.</li>'}</ul>
<h2>Changed properties (${r.propChanges})</h2>
<table><thead><tr><th>Node</th><th>Property</th><th>Change</th><th>A</th><th>B</th></tr></thead><tbody>${rows.join('\n')}</tbody></table>
</body></html>
`;
}

module.exports = { diff, canon, toMarkdown, toHtml, summaryLine };
