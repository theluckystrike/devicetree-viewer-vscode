'use strict';
// The three Zovo Pro tools: Compare two device trees, Export and compile, Address and pin map. Each asks
// pro.allowed() on every click and calls pro.produced() only after its result is there (the report or map drawn in
// its panel, the exported file written and opened), so Escape, Cancel or an error never uses a free try. Everything
// runs on this computer; files are read and written through VS Code's file system API.
const vscode = require('vscode');
const path = require('path');
const M = require('./core/model');
const D = require('./core/diff');
const A = require('./core/addrmap');
const { loadFile, VIEW_DTB, DT_RE } = require('./editor');
const { panelHtml } = require('./html');
const support = require('./support');

const PREFIX = 'dtViewer';
const setting = (k, d) => vscode.workspace.getConfiguration(PREFIX).get(k, d);
const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const base = (uri) => path.posix.basename(uri.path);
const stem = (uri) => base(uri).replace(/\.[^.]+$/, '');
const FILTERS = { 'Device tree files': ['dtb', 'dtbo', 'dts', 'dtsi', 'overlay'], 'All files': ['*'] };
const MAX_ROWS = 5000;

function sibling(uri, name) { return vscode.Uri.joinPath(uri, '..', name); }
async function writeBytes(uri, bytes) { await vscode.workspace.fs.writeFile(uri, bytes instanceof Uint8Array ? bytes : Buffer.from(bytes, 'utf8')); }
const sameFile = (a, b) => a && b && a.toString() === b.toString();

function createTools({ context, provider, pro, reach }) {
  const panels = {};

  function openPanel(kind, title) {
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    const old = panels[kind];
    if (old && !old.disposed) old.panel.dispose();
    const panel = vscode.window.createWebviewPanel(`${PREFIX}.${kind}`, title, { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media],
      enableCommandUris: (reach ? reach.commandIds() : []).concat(support.commandUris(PREFIX)),
    });
    panel.webview.html = panelHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'viewer.css')).toString(),
      title, head: reach ? (n) => reach.headHtml(n) : undefined, showSupportLinks: setting('showSupportLinks', true) !== false,
    });
    if (reach) reach.attach(panel.webview, panel);
    let readyFn;
    const p = { panel, kind, disposed: false, actions: null, shown: null };
    p.ready = new Promise((r) => { readyFn = r; });
    p.post = (msg) => { try { const r = panel.webview.postMessage(msg); if (r && r.then) r.then(undefined, () => false); } catch (e) { /* disposed */ } };
    p.show = async (o) => { await p.ready; p.post({ type: 'show', ...o }); };
    panel.webview.onDidReceiveMessage(async (m) => {
      if (reach && reach.onMessage(m)) return;
      if (!m || typeof m !== 'object') return;
      try {
        if (m.type === 'ready') readyFn();
        else if (m.type === 'shown') { if (p.shown) { const f = p.shown; p.shown = null; await f(m); } }
        else if (m.type === 'action' && p.actions) await p.actions(m.id, m);
      } catch (e) { vscode.window.showErrorMessage(String((e && e.message) || e)); }
    });
    panel.onDidDispose(() => { p.disposed = true; if (panels[kind] === p) delete panels[kind]; });
    panels[kind] = p;
    return p;
  }

  /** The file a tool works on: the clicked one, else the file of the active viewer or text editor, else a dialog. */
  async function targetFile(arg, title) {
    if (arg && arg.scheme) return arg;
    if (provider.active) return provider.active.uri;
    const ed = vscode.window.activeTextEditor;
    if (ed && DT_RE.test(ed.document.uri.path)) return ed.document.uri;
    const r = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Choose', title, filters: FILTERS });
    return r && r[0];
  }

  /** The device tree document of uri: the viewer's own when it is open, else read now (unsaved text edits included). */
  async function docFor(uri) {
    for (const d of provider.docs) if (d.uri.toString() === uri.toString() && d.data && d.data.kind === 'dt') return d.data.doc;
    const td = (vscode.workspace.textDocuments || []).find((t) => t.uri.toString() === uri.toString() && t.isDirty);
    const data = await loadFile(uri, td && !/\.dtbo?$/i.test(uri.path) ? td.getText() : undefined);
    if (data.kind !== 'dt') throw new Error(`${base(uri)} could not be read as a device tree: ${data.error}`);
    return data.doc;
  }

  async function pickOther(uriA, title) {
    const items = [];
    const seen = new Set([uriA.toString()]);
    for (const d of provider.docs) if (!seen.has(d.uri.toString()) && d.data && d.data.kind === 'dt') { seen.add(d.uri.toString()); items.push({ label: d.name, description: 'open in the viewer', uri: d.uri }); }
    let files = [];
    try { files = await vscode.workspace.findFiles('**/*.{dtb,dtbo,dts,dtsi,overlay}', '**/node_modules/**', 300); } catch (e) { files = []; }
    for (const u of files) if (!seen.has(u.toString())) { seen.add(u.toString()); items.push({ label: base(u), description: vscode.workspace.asRelativePath ? vscode.workspace.asRelativePath(u) : u.fsPath, uri: u }); }
    items.push({ label: 'Choose a file...', description: 'DTB, DTBO, DTS, DTSI or overlay', file: true });
    const pick = await vscode.window.showQuickPick(items, { ignoreFocusOut: true, title, placeHolder: 'The device tree to compare with (B)', matchOnDescription: true });
    if (!pick) return undefined;
    if (!pick.file) return pick.uri;
    const r = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Compare', title, filters: FILTERS });
    return r && r[0];
  }

  // ---------- 1. Compare two device trees ----------
  async function diff(arg, extra = {}) {
    if (!(await pro.allowed('diff', arg))) return undefined;
    const uriA = await targetFile(arg, 'Compare: choose the first device tree (A)');
    if (!uriA) return undefined;
    const uriB = extra.other || await pickOther(uriA, `Compare ${base(uriA)} with...`);
    if (!uriB) return undefined;
    const a = await docFor(uriA);
    const b = await docFor(uriB);
    const r = D.diff(a, b);
    const nameA = base(uriA), nameB = base(uriB);
    const title = `Compare: ${nameA} and ${nameB}`;
    const p = openPanel('diff', title);
    p.result = r;
    p.shown = async () => { await pro.produced('diff'); };
    const fileName = `${stem(uriA)}-vs-${stem(uriB)}`;
    p.actions = async (id) => {
      const md = id === 'md';
      if (id !== 'md' && id !== 'html') return;
      const dest = await vscode.window.showSaveDialog({ defaultUri: sibling(uriA, `${fileName}.diff.${md ? 'md' : 'html'}`), filters: md ? { Markdown: ['md'] } : { HTML: ['html'] }, title: `Save the comparison as ${md ? 'Markdown' : 'HTML'}` });
      if (!dest) return;
      await writeBytes(dest, md ? D.toMarkdown(r, nameA, nameB) : D.toHtml(r, nameA, nameB));
      p.post({ type: 'patch', target: 'saved', html: `Saved ${esc(dest.fsPath || dest.path)}.` });
    };
    const rows = [];
    for (const c of r.changed) for (const x of c.props) rows.push(`<tr class="${x.kind}" data-kind="${x.kind}"><td><code>${esc(c.path)}</code></td><td><code>${esc(x.name)}</code></td><td>${x.kind}</td><td><code>${x.a === null ? '' : esc(x.a.slice(0, 600))}</code></td><td><code>${x.b === null ? '' : esc(x.b.slice(0, 600))}</code></td></tr>`);
    const list = (arr, id) => (arr.length ? `<ul id="${id}">${arr.slice(0, MAX_ROWS).map((x) => `<li><code>${esc(x)}</code></li>`).join('')}</ul>` : `<p id="${id}" class="muted">None.</p>`);
    const html = `<p class="row"><button class="tb act" data-id="md">Save as Markdown...</button> <button class="tb act" data-id="html">Save as HTML...</button> <span id="saved" class="muted"></span></p>
<div class="stats"><div><b id="nOnlyA">${r.onlyA.length}</b><span>nodes only in A</span></div><div><b id="nOnlyB">${r.onlyB.length}</b><span>nodes only in B</span></div><div><b id="nChanged">${r.propChanges}</b><span>property changes in ${r.changed.length} nodes</span></div><div><b id="nSame">${r.same}</b><span>nodes the same</span></div></div>
<p class="muted">A: ${esc(nameA)} (${a.kind === 'dtb' ? (a.overlay ? 'DTBO' : 'DTB') : 'DTS'}, ${r.nodesA} nodes). B: ${esc(nameB)} (${b.kind === 'dtb' ? (b.overlay ? 'DTBO' : 'DTB') : 'DTS'}, ${r.nodesB} nodes). Nodes are matched by path and properties by name; a reference is compared by the node it points to, not by its phandle number. phandle properties and the generated __symbols__ and __fixups__ nodes are left out.</p>
<h3>Nodes only in A</h3>${list(r.onlyA, 'onlyA')}
<h3>Nodes only in B</h3>${list(r.onlyB, 'onlyB')}
<h3>Changed properties</h3>${rows.length ? `<table id="diffTable" class="sort"><thead><tr><th>Node</th><th>Property</th><th>Change</th><th>A</th><th>B</th></tr></thead><tbody>${rows.slice(0, MAX_ROWS).join('')}</tbody></table>` : '<p class="muted">None.</p>'}`;
    await p.show({ title, html });
    return r;
  }

  // ---------- 2. Export and compile ----------
  async function exportTree(arg, extra = {}) {
    if (!(await pro.allowed('export', arg))) return undefined;
    const uri = await targetFile(arg, 'Export: choose a device tree file');
    if (!uri) return undefined;
    const doc = await docFor(uri);
    const items = [];
    if (doc.kind === 'dts') items.push({ label: 'Compile to DTB', description: '.dtb, with the built-in device tree writer', id: 'dtb' });
    items.push({ label: doc.kind === 'dts' ? 'DTS (one file, merged)' : 'DTS text', description: '.dts', id: 'dts' });
    items.push({ label: 'JSON', description: '.json, nodes with their properties and children', id: 'json' });
    items.push({ label: 'YAML', description: '.yaml, the same structure as the JSON', id: 'yaml' });
    let id = extra.format;
    if (!id) {
      const pick = await vscode.window.showQuickPick(items, { ignoreFocusOut: true, title: `Export ${base(uri)}`, placeHolder: 'Save the tree as...' });
      if (!pick) return undefined;
      id = pick.id;
    }
    let out;
    try {
      if (id === 'dtb') out = M.compile(doc);
      else if (id === 'dts') out = M.toDts(doc).text;
      else if (id === 'json') out = M.toJson(doc);
      else if (id === 'yaml') out = M.toYaml(doc);
      else return undefined;
    } catch (e) {
      if (e instanceof M.CompileError) {
        const line = e.line;
        const pick = await vscode.window.showErrorMessage(`${base(uri)} could not be compiled. ${e.message}`, ...(line ? ['Go to Line'] : []));
        if (pick === 'Go to Line') await provider.revealLine(uri, line);
        return undefined;
      }
      throw e;
    }
    const ext = id === 'yaml' ? 'yaml' : id;
    let name = `${stem(uri)}.${ext}`;
    if (id === 'dts' && /\.dts$/i.test(base(uri))) name = `${stem(uri)}.merged.dts`;
    const dest = extra.dest || await vscode.window.showSaveDialog({ defaultUri: sibling(uri, name), filters: { [id.toUpperCase()]: [ext] }, title: id === 'dtb' ? `Compile ${base(uri)} to DTB` : `Save ${base(uri)} as ${id.toUpperCase()}` });
    if (!dest) return undefined;
    if (sameFile(dest, uri)) { vscode.window.showErrorMessage('Choose another file name: the export never writes over the file it reads.'); return undefined; }
    await writeBytes(dest, out);
    const size = out.length;
    if (id === 'dtb') await vscode.commands.executeCommand('vscode.openWith', dest, VIEW_DTB, { viewColumn: vscode.ViewColumn.Beside, preview: true });
    else { const td = await vscode.workspace.openTextDocument(dest); await vscode.window.showTextDocument(td, { viewColumn: vscode.ViewColumn.Beside, preview: true }); }
    vscode.window.setStatusBarMessage(`Saved ${base(dest)} (${size.toLocaleString('en-US')} bytes)`, 8000);
    await pro.produced('export');
    return { dest, format: id, size };
  }

  // ---------- 3. Address and pin map ----------
  async function addressMap(arg) {
    if (!(await pro.allowed('addressMap', arg))) return undefined;
    const uri = await targetFile(arg, 'Address and pin map: choose a device tree file');
    if (!uri) return undefined;
    const doc = await docFor(uri);
    const map = A.build(doc);
    const title = `Address and pin map: ${base(uri)}`;
    const p = openPanel('addressMap', title);
    p.result = map;
    p.shown = async () => { await pro.produced('addressMap'); };
    p.actions = async (id) => {
      if (id !== 'csv') return;
      const dest = await vscode.window.showSaveDialog({ defaultUri: sibling(uri, `${stem(uri)}.address-map.csv`), filters: { CSV: ['csv'] }, title: 'Save the address and pin map as CSV' });
      if (!dest) return;
      await writeBytes(dest, A.toCsv(map));
      p.post({ type: 'patch', target: 'saved', html: `Saved ${esc(dest.fsPath || dest.path)} (${map.rows.length} rows).` });
    };
    const kinds = ['reg', 'reserved', 'bus', 'interrupt', 'gpio', 'pinctrl'];
    const kname = { reg: 'Address ranges', reserved: 'Reserved memory', bus: 'Bus addresses', interrupt: 'Interrupts', gpio: 'GPIOs', pinctrl: 'Pinctrl' };
    const flagged = map.rows.filter((r) => r.flags).length;
    const rows = map.rows.slice(0, MAX_ROWS).map((r) => `<tr data-kind="${r.kind}" class="${r.flags ? 'flag' : ''}"><td>${r.kind}</td><td><code>${esc(r.node)}</code></td><td>${esc(r.label)}</td><td>${esc(r.status)}</td><td><code>${esc(r.start)}</code></td><td><code>${esc(r.end)}</code></td><td><code>${esc(r.size)}</code></td><td><code>${esc(r.controller)}</code></td><td><code>${esc(r.detail)}</code></td><td>${esc(r.flags)}</td></tr>`).join('');
    const html = `<p class="row"><button class="tb act" data-id="csv">Save as CSV...</button> <span id="saved" class="muted"></span></p>
<div class="stats"><div><b id="nRows">${map.rows.length}</b><span>entries</span></div><div><b id="nOverlaps">${map.overlaps}</b><span>overlapping address ranges</span></div><div><b id="nGpioDup">${map.gpioDup}</b><span>GPIO pins used twice</span></div><div><b id="nBusDup">${map.busDup}</b><span>bus addresses used twice</span></div></div>
<p class="muted">Addresses are CPU addresses, translated through the ranges of every parent bus; a bus address shows when there is no translation. Only enabled nodes (status okay or no status) are checked for overlaps and pins used twice. ${doc.kind === 'dts' ? 'Values written with macros from included headers are listed as text and not checked.' : ''}</p>
<div class="filters" id="kindFilter">${kinds.map((k) => `<label><input type="checkbox" value="${k}" checked> ${kname[k]} (${map.counts[k]})</label>`).join('')}<label><input type="checkbox" id="onlyFlags"> Only flagged (${flagged})</label> <span class="muted">Shown: <span id="shownCount">${Math.min(map.rows.length, MAX_ROWS)}</span></span></div>
<table id="mapTable" class="sort"><thead><tr><th>Kind</th><th>Node</th><th>Label</th><th>Status</th><th>Start</th><th>End</th><th>Size</th><th>Controller</th><th>Detail</th><th>Flags</th></tr></thead><tbody>${rows}</tbody></table>`;
    await p.show({ title, html });
    return map;
  }

  return { diff, exportTree, addressMap, panels, docFor, targetFile };
}

module.exports = { createTools, sibling };
