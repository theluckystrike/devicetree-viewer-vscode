// DeviceTree Viewer webview: node tree, details table, DTS text (DTB files) and file facts. Data comes from the
// extension host; this page makes no network request (CSP default-src 'none').
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  let data = null;
  let sel = -1;
  const open = new Set();
  let query = '';
  let tab = 'tree';
  let matches = null;
  let refBy = null;

  function footer() {
    const f = $('zovo-footer');
    if (f && !$('footer').childElementCount) $('footer').innerHTML = f.innerHTML;
  }

  function status(t) { $('statusText').textContent = t; }

  function showMessage(html) { const m = $('msg'); m.innerHTML = html; m.hidden = !html; }

  function init(m) {
    data = m;
    document.body.dataset.kind = m.kind;
    footer();
    if (m.kind !== 'dt') {
      document.body.dataset.state = m.kind === 'notfdt' ? 'notfdt' : 'error';
      $('fmt').textContent = m.sizeText || '';
      $('tree').innerHTML = '';
      $('details').innerHTML = '';
      $('facts').innerHTML = '';
      const btns = [];
      if (m.hex) btns.push(`<button class="tb" id="mHex">Open in ${esc(m.hex)}</button>`);
      if (m.canOpenText) btns.push('<button class="tb" id="mText">Open as Text</button>');
      showMessage(`<p>${esc(m.error)}</p>${btns.length ? `<p>${btns.join(' ')}</p>` : ''}`);
      if ($('mHex')) $('mHex').onclick = () => vscode.postMessage({ type: 'openHex' });
      if ($('mText')) $('mText').onclick = () => vscode.postMessage({ type: 'openRaw' });
      $('openText').hidden = !m.canOpenText;
      ['search', 'expand', 'collapse'].forEach((id) => { $(id).disabled = true; });
      status(m.error);
      return;
    }
    ['search', 'expand', 'collapse'].forEach((id) => { $(id).disabled = false; });
    $('openText').hidden = false;
    $('openText').textContent = m.source === 'dtb' ? 'Open DTS Text' : 'Open as Text';
    $('openText').title = m.source === 'dtb' ? 'Open the DTS text of this file in a read-only editor tab' : 'Open the file in the text editor';
    $('fmt').textContent = `${m.label}, ${m.sizeText}`;
    $('tabs').hidden = m.source !== 'dtb';
    showMessage(m.errors && m.errors.length ? `<p>The file could not be read to the end. ${esc(m.errors.map((e) => `Line ${e.line}: ${e.message}`).join(' '))} The tree shows what was read before that line.</p>` : '');
    refBy = new Map();
    for (const n of m.nodes) for (const p of n.props) for (const [, t] of p.parts) if (t >= 0 && t !== n.id) { if (!refBy.has(t)) refBy.set(t, []); const l = refBy.get(t); if (!l.some((x) => x.id === n.id && x.prop === p.name)) l.push({ id: n.id, prop: p.name }); }
    if (!open.size) { open.add(0); for (const n of m.nodes) if (n.depth === 0) open.add(n.id); }
    if (sel >= m.nodes.length) sel = -1;
    facts();
    if (m.source === 'dtb') drawDts();
    applySearch();
    select(sel >= 0 ? sel : 0, false);
    setTab(tab);
    document.body.dataset.state = 'ready';
    const propCount = m.nodes.reduce((s, n) => s + n.props.length, 0);
    status(`${m.nodes.length.toLocaleString('en-US')} nodes, ${propCount.toLocaleString('en-US')} properties`);
    vscode.postMessage({ type: 'rendered', nodes: m.nodes.length });
  }

  function facts() {
    $('facts').innerHTML = `<h3>File</h3><dl>${data.facts.map((f) => `<dt>${esc(f.k)}</dt><dd>${esc(f.v)}</dd>`).join('')}</dl>`;
  }

  // ---------- tree ----------
  function hay(n) {
    const parts = [n.name, n.path, n.labels.join(' '), n.compatible];
    for (const p of n.props) { parts.push(p.name); parts.push(p.parts.map((x) => x[0]).join('')); }
    return parts.join('\n').toLowerCase();
  }
  function applySearch() {
    const q = query.trim().toLowerCase();
    if (!q) { matches = null; $('count').textContent = ''; drawTree(); const r = document.querySelector('#tree .node.sel'); if (r) r.scrollIntoView({ block: 'center' }); return; }
    matches = new Set();
    const show = new Set();
    for (const n of data.nodes) {
      if (hay(n).includes(q)) { matches.add(n.id); for (let p = n.id; p >= 0; p = data.nodes[p].parent) show.add(p); }
    }
    for (const id of show) open.add(id);
    $('count').textContent = `${matches.size} match${matches.size === 1 ? '' : 'es'}`;
    drawTree(show);
  }
  function visibleRows(show) {
    const out = [];
    const nodes = data.nodes;
    let skipDepth = -1;
    for (const n of nodes) {
      if (skipDepth >= 0) { if (n.depth > skipDepth && n.parent !== -1) continue; skipDepth = -1; }
      if (show && !show.has(n.id)) { skipDepth = n.depth; continue; }
      out.push(n);
      if (n.kids && !open.has(n.id)) skipDepth = n.depth;
    }
    return out;
  }
  function badge(n) {
    if (!n.status) return '';
    const ok = n.status === 'okay' || n.status === 'ok';
    return `<span class="st ${ok ? 'ok' : 'off'}">${esc(n.status)}</span>`;
  }
  function drawTree(show) {
    const rows = visibleRows(show || (matches ? (() => { const s = new Set(); for (const id of matches) for (let p = id; p >= 0; p = data.nodes[p].parent) s.add(p); return s; })() : null));
    $('tree').innerHTML = rows.map((n) => `<div class="node${n.id === sel ? ' sel' : ''}${matches && matches.has(n.id) ? ' hit' : ''}${n.enabled ? '' : ' disabled'}${n.orphan ? ' orphan' : ''}" role="treeitem" data-id="${n.id}" data-depth="${n.depth}"${n.kids ? ` aria-expanded="${open.has(n.id)}"` : ''}><span class="tw">${n.kids ? (open.has(n.id) ? '&#9662;' : '&#9656;') : ''}</span>${n.labels.length ? `<span class="lbl">${esc(n.labels.join(': '))}:</span> ` : ''}<span class="nm">${esc(n.name)}</span>${badge(n)}</div>`).join('');
    // indentation through the style object: the CSP allows no inline style attributes
    for (const el of $('tree').children) el.style.paddingLeft = `${6 + Number(el.dataset.depth) * 14}px`;
  }

  // ---------- details ----------
  function valueHtml(p) {
    return p.parts.map(([s, t]) => (t >= 0 ? `<a href="#" class="ref" data-id="${t}" title="${esc(data.nodes[t].path)}">${esc(s)}</a>` : esc(s))).join('') + (p.cut ? ' <span class="muted">(cut, open the text for the full value)</span>' : '');
  }
  function select(id, reveal) {
    if (!data || !data.nodes[id]) return;
    sel = id;
    const n = data.nodes[id];
    for (let p = n.parent; p >= 0; p = data.nodes[p].parent) open.add(p);
    drawTree();
    const row = document.querySelector(`#tree .node[data-id="${id}"]`);
    if (row && reveal !== false) row.scrollIntoView({ block: 'nearest' });
    const lineLink = n.line ? `<a href="#" id="goLine" data-line="${n.line}">${data.source === 'dts' ? `Line ${n.line}` : `DTS text line ${n.line}`}</a>` : '';
    const h = [];
    h.push(`<h2 id="dPath">${esc(n.path)}</h2>`);
    h.push(`<p class="meta">${n.labels.length ? `<span class="lbl">${esc(n.labels.map((l) => `&${l}`).join(' '))}</span> ` : ''}${badge(n)}${n.compatible ? ` <span class="compat">${esc(n.compatible)}</span>` : ''} ${lineLink}</p>`);
    if (n.orphan) h.push('<p class="muted">This block changes a node whose label is defined in an included file, so its place in the tree is not known from this file alone.</p>');
    h.push(n.props.length ? `<table id="props"><thead><tr><th>Property</th><th>Value</th></tr></thead><tbody>${n.props.map((p) => `<tr data-prop="${esc(p.name)}"><td class="pn">${esc(p.name)}</td><td class="pv">${valueHtml(p) || '<span class="muted">(empty, true)</span>'}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No properties.</p>');
    if (n.reg) h.push(`<h3>reg</h3><table id="regTable"><thead><tr><th>Address</th><th>Size</th><th>End</th></tr></thead><tbody>${n.reg.map((r) => `<tr><td>${esc(r.address)}</td><td>${esc(r.size)}</td><td>${esc(r.end)}</td></tr>`).join('')}</tbody></table><p class="muted">${esc(n.regCells)}</p>`);
    if (n.irqs) h.push(`<h3>Interrupts</h3><table id="irqTable"><thead><tr><th>Controller</th><th>Cells</th></tr></thead><tbody>${n.irqs.map((q) => `<tr><td>${q.ctlId >= 0 ? `<a href="#" class="ref" data-id="${q.ctlId}">${esc(q.ctl)}</a>` : esc(q.ctl)}</td><td>${esc(q.cells)}</td></tr>`).join('')}</tbody></table>`);
    const rb = refBy.get(id);
    if (rb && rb.length) h.push(`<h3>Referenced by</h3><ul id="refBy">${rb.slice(0, 200).map((r) => `<li><a href="#" class="ref" data-id="${r.id}">${esc(data.nodes[r.id].path)}</a> <span class="muted">${esc(r.prop)}</span></li>`).join('')}</ul>`);
    const kids = data.nodes.filter((c) => c.parent === id);
    if (kids.length) h.push(`<h3>Children (${kids.length})</h3><ul id="kids">${kids.slice(0, 500).map((c) => `<li><a href="#" class="ref" data-id="${c.id}">${esc(c.name)}</a>${badge(c)}</li>`).join('')}</ul>`);
    $('details').innerHTML = h.join('');
    vscode.postMessage({ type: 'select', id });
    if (tab === 'dts') scrollDts(n.line);
  }

  // ---------- DTS text (DTB) ----------
  function drawDts() {
    const lines = data.dts.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    $('dts').innerHTML = lines.map((l, i) => `<div class="l" data-line="${i + 1}"><i>${i + 1}</i>${esc(l) || ' '}</div>`).join('');
  }
  function scrollDts(line) {
    const prev = $('dts').querySelector('.l.hl');
    if (prev) prev.classList.remove('hl');
    const el = $('dts').querySelector(`.l[data-line="${line}"]`);
    if (el) { el.classList.add('hl'); el.scrollIntoView({ block: 'center' }); }
  }
  function setTab(t) {
    tab = data && data.source === 'dtb' ? t : 'tree';
    $('details').hidden = tab !== 'tree';
    $('dts').hidden = tab !== 'dts';
    document.querySelectorAll('#tabs .tab').forEach((b) => b.classList.toggle('sel', b.dataset.tab === tab));
    if (tab === 'dts' && sel >= 0) scrollDts(data.nodes[sel].line);
  }

  // ---------- events ----------
  $('tree').addEventListener('click', (e) => {
    const row = e.target.closest('.node');
    if (!row) return;
    const id = Number(row.dataset.id);
    const n = data.nodes[id];
    if (e.target.closest('.tw') && n.kids) { if (open.has(id)) open.delete(id); else open.add(id); drawTree(); return; }
    if (id === sel && n.kids && !open.has(id)) open.add(id);
    select(id, false);
  });
  $('tree').addEventListener('dblclick', (e) => {
    const row = e.target.closest('.node');
    if (!row) return;
    const n = data.nodes[Number(row.dataset.id)];
    if (n.line) vscode.postMessage({ type: 'reveal', line: n.line });
  });
  $('details').addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    e.preventDefault();
    if (a.id === 'goLine') { if (data.source === 'dtb') setTab('dts'); else vscode.postMessage({ type: 'reveal', line: Number(a.dataset.line) }); return; }
    if (a.classList.contains('ref')) select(Number(a.dataset.id));
  });
  $('dts').addEventListener('click', (e) => {
    const l = e.target.closest('.l');
    if (!l || !data) return;
    const line = Number(l.dataset.line);
    let best = -1;
    for (const n of data.nodes) if (n.line && n.line <= line && (best < 0 || n.line > data.nodes[best].line)) best = n.id;
    if (best >= 0 && best !== sel) { const t = tab; select(best); tab = t; }
  });
  $('tabs').addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (b) setTab(b.dataset.tab); });
  let timer = null;
  $('search').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { query = $('search').value; applySearch(); }, 150); });
  $('search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && matches && matches.size) { const list = [...matches].sort((a, b) => a - b); const next = list.find((x) => x > sel); select(next === undefined ? list[0] : next); }
  });
  $('expand').addEventListener('click', () => { for (const n of data.nodes) if (n.kids) open.add(n.id); drawTree(); });
  $('collapse').addEventListener('click', () => { open.clear(); for (const n of data.nodes) if (n.depth === 0) open.add(n.id); drawTree(); });
  $('openText').addEventListener('click', () => vscode.postMessage({ type: 'openText', line: sel >= 0 && data && data.nodes[sel] ? data.nodes[sel].line : 0 }));

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'init') init(m);
    else if (m.type === 'selectPath' && data) { const n = data.nodes.find((x) => x.path === m.path); if (n) select(n.id); }
  });
  footer();
  vscode.postMessage({ type: 'ready' });
}());
