'use strict';
// Read-only custom editors: dtViewer.dtb (default for .dtb and .dtbo) and dtViewer.dts (an "Open With" option for
// .dts, .dtsi and .overlay, so the text editor and the language extensions stay in charge of editing). The extension
// host reads the file through VS Code's file system API (Remote SSH, WSL and containers work the same), builds the tree
// with src/core and hands it to the webview. The webview has no network access (CSP default-src 'none').
// A .dtb without the device tree magic gets a plain note with buttons to open it elsewhere: no error popup, and the
// viewer never reopens a tab by itself.
const vscode = require('vscode');
const path = require('path');
const M = require('./core/model');
const V = require('./core/view');
const { editorHtml } = require('./html');
const support = require('./support');

const VIEW_DTB = 'dtViewer.dtb';
const VIEW_DTS = 'dtViewer.dts';
const PREFIX = 'dtViewer';
const DTS_SCHEME = 'dtviewer-dts';
const MAX_BYTES = 64 * 1024 * 1024;
const DT_RE = /\.(dtb|dtbo|dts|dtsi|overlay)$/i;
const setting = (k, d) => vscode.workspace.getConfiguration(PREFIX).get(k, d);
const HEX_EDITORS = [['zovo.zovo-hex-viewer', 'hexViewer.editor', 'Hex Viewer'], ['ms-vscode.hexeditor', 'hexEditor.hexedit', 'Hex Editor']];

function formatLabel(name, doc) {
  if (doc.kind === 'dtb') return doc.overlay ? 'DTBO' : 'DTB';
  const ext = (/\.([^.]+)$/.exec(name) || [])[1] || '';
  return ext.toLowerCase() === 'overlay' ? 'Overlay' : ext.toLowerCase() === 'dtsi' ? 'DTSI' : 'DTS';
}

/** Reads and parses a device tree file. Shared by the viewer and the Pro tools. text overrides the file (unsaved edits). */
async function loadFile(uri, text) {
  const name = path.posix.basename(uri.path);
  const out = { uri, name, size: 0, kind: 'error', doc: null, error: '' };
  let bytes;
  if (typeof text === 'string') bytes = Buffer.from(text, 'utf8');
  else {
    try { const st = await vscode.workspace.fs.stat(uri); if (st && st.size > MAX_BYTES) { out.error = `This file is ${V.sizeText(st.size)}, more than the 64 MB the viewer reads.`; return out; } } catch (e) { /* stat is optional */ }
    bytes = await vscode.workspace.fs.readFile(uri);
  }
  out.size = bytes.byteLength;
  if (!bytes.byteLength) { out.kind = 'empty'; out.error = 'This file is empty.'; return out; }
  try {
    out.doc = M.load(bytes, name);
  } catch (e) {
    out.error = String((e && e.message) || e);
    out.kind = /device tree magic/.test(out.error) ? 'notfdt' : 'error';
    return out;
  }
  if (out.doc.kind === 'dts' && /\u0000/.test(Buffer.from(bytes.slice(0, 4096)).toString('latin1'))) { out.kind = 'notfdt'; out.error = 'This file holds binary data, not device tree source text.'; out.doc = null; return out; }
  out.kind = 'dt';
  out.label = formatLabel(name, out.doc);
  if (out.doc.kind === 'dtb') { const t = M.toDts(out.doc); out.dtsText = t.text; out.lineOf = t.lineOf; }
  return out;
}

class DtDocument {
  constructor(uri) { this.uri = uri; this.panels = new Set(); this.listeners = []; this.data = null; this.rendered = null; }
  get name() { return path.posix.basename(this.uri.path); }
  async load(text) {
    try { this.data = await loadFile(this.uri, text); } catch (e) { this.data = { kind: 'error', error: String((e && e.message) || e), name: this.name }; }
    this.rendered = null;
  }
  dispose() { for (const l of this.listeners) { try { l.dispose(); } catch (e) { /* gone */ } } }
}

class DtEditorProvider {
  constructor(context, hooks = {}) {
    this.context = context;
    this.hooks = hooks;
    this.docs = new Set();
    this.active = null;
    this.activePanel = null;
    this._success = new WeakSet();
    this.dtsCache = new Map();
  }
  dispose() { for (const d of this.docs) d.dispose(); this.docs.clear(); }

  async openCustomDocument(uri) {
    const doc = new DtDocument(uri);
    const open = vscode.workspace.textDocuments && vscode.workspace.textDocuments.find((t) => t.uri.toString() === uri.toString() && t.isDirty);
    await doc.load(open && !/\.dtbo?$/i.test(uri.path) ? open.getText() : undefined);
    this.docs.add(doc);
    let timer = null;
    const refresh = (text) => { clearTimeout(timer); timer = setTimeout(async () => { await doc.load(text); for (const p of doc.panels) this.init(doc, p.webview); if (this.hooks.onChange) this.hooks.onChange(doc); }, 400); };
    try {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), path.posix.basename(uri.path)));
      doc.listeners.push(w, w.onDidChange(() => refresh()), w.onDidCreate(() => refresh()));
    } catch (e) { /* no watcher: the view still works */ }
    if (!/\.dtbo?$/i.test(uri.path) && vscode.workspace.onDidChangeTextDocument) {
      doc.listeners.push(vscode.workspace.onDidChangeTextDocument((e) => { if (e.document.uri.toString() === uri.toString()) refresh(e.document.getText()); }));
    }
    return { uri, dispose: () => { this.docs.delete(doc); doc.dispose(); if (this.active === doc) this.active = null; }, _doc: doc };
  }

  async resolveCustomEditor(handle, panel) {
    const doc = handle._doc;
    doc.panels.add(panel);
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const reach = this.hooks.reach ? this.hooks.reach() : null;
    panel.webview.options = {
      enableScripts: true, localResourceRoots: [media],
      enableCommandUris: (reach ? reach.commandIds() : []).concat(support.commandUris(PREFIX)),
    };
    panel.webview.html = editorHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'viewer.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'viewer.css')).toString(),
      title: doc.name,
      head: reach ? (n) => reach.headHtml(n) : undefined,
      showSupportLinks: setting('showSupportLinks', true) !== false,
    });
    if (reach) reach.attach(panel.webview, panel);
    const setActive = () => { if (panel.active) { this.active = doc; this.activePanel = panel; if (this.hooks.onActive) this.hooks.onActive(doc); } };
    setActive();
    panel.onDidChangeViewState(setActive);
    panel.onDidDispose(() => { doc.panels.delete(panel); if (this.activePanel === panel) { this.activePanel = null; if (this.active === doc) this.active = null; if (this.hooks.onActive) this.hooks.onActive(null); } });
    panel.webview.onDidReceiveMessage(async (m) => {
      if (reach && reach.onMessage(m)) return;
      if (!m || typeof m !== 'object') return;
      try { await this.onMessage(doc, panel, m); } catch (e) { vscode.window.showErrorMessage(String((e && e.message) || e)); }
    });
  }

  send(webview, msg) { try { const r = webview.postMessage(msg); if (r && r.then) r.then(undefined, () => false); } catch (e) { /* disposed */ } }

  hexEditor() {
    for (const [id, viewType, name] of HEX_EDITORS) { try { if (vscode.extensions.getExtension(id)) return { viewType, name }; } catch (e) { /* none */ } }
    return null;
  }

  init(doc, webview) {
    const d = doc.data || { kind: 'error', error: 'The file could not be read.' };
    const base = { type: 'init', name: doc.name, kind: d.kind, settings: { showPro: setting('showProTools', true) !== false } };
    if (d.kind !== 'dt') {
      const hex = this.hexEditor();
      this.send(webview, { ...base, error: d.error || 'The file could not be read.', hex: hex ? hex.name : '', canOpenText: d.kind !== 'empty', sizeText: V.sizeText(d.size || 0) });
      if (d.kind === 'error' && this.hooks.onFailure) this.hooks.onFailure(doc);
      return;
    }
    const vm = V.build(d.doc, { lineOf: d.lineOf });
    this.send(webview, {
      ...base, source: d.doc.kind, label: d.label, size: d.size, sizeText: V.sizeText(d.size), nodes: vm.nodes, facts: vm.facts,
      dts: d.dtsText || '', errors: d.doc.errors || [], overlay: !!d.doc.overlay,
    });
  }

  /** The panel showing uri (the active one first), or null. */
  panelFor(uri) {
    const key = uri.toString();
    if (this.active && this.active.uri.toString() === key && this.activePanel) return { doc: this.active, panel: this.activePanel };
    for (const d of this.docs) if (d.uri.toString() === key) for (const p of d.panels) return { doc: d, panel: p };
    return null;
  }

  async revealLine(uri, line) {
    const l = Math.max(0, (Number(line) || 1) - 1);
    const range = new vscode.Range(l, 0, l, 0);
    const td = await vscode.workspace.openTextDocument(uri);
    return vscode.window.showTextDocument(td, { viewColumn: vscode.ViewColumn.Beside, selection: range, preview: true, preserveFocus: false });
  }

  dtsUri(uri, line) {
    const base = path.posix.basename(uri.path).replace(/\.dtbo?$/i, '');
    return vscode.Uri.from({ scheme: DTS_SCHEME, path: `/${base}.dts`, query: encodeURIComponent(uri.toString()), fragment: line ? String(line) : '' });
  }

  /** Text of a DTS view of a DTB (the content provider for dtviewer-dts: documents). */
  async dtsTextFor(dtsUri) {
    const orig = vscode.Uri.parse(decodeURIComponent(dtsUri.query));
    for (const d of this.docs) if (d.uri.toString() === orig.toString() && d.data && d.data.dtsText) return d.data.dtsText;
    const data = await loadFile(orig);
    if (data.kind !== 'dt') return `// ${data.error}\n`;
    return data.dtsText || '';
  }

  async openDtsText(uri, line) {
    const u = this.dtsUri(uri);
    const td = await vscode.workspace.openTextDocument(u);
    const l = Math.max(0, (Number(line) || 1) - 1);
    return vscode.window.showTextDocument(td, { viewColumn: vscode.ViewColumn.Beside, selection: new vscode.Range(l, 0, l, 0), preview: true });
  }

  async onMessage(doc, panel, m) {
    const w = panel.webview;
    switch (m.type) {
      case 'ready': this.init(doc, w); return;
      case 'rendered':
        doc.rendered = { nodes: Number(m.nodes) || 0, at: Date.now() };
        if (!this._success.has(doc) && doc.data && doc.data.kind === 'dt') { this._success.add(doc); if (this.hooks.onSuccess) this.hooks.onSuccess(doc); }
        return;
      case 'openText':
        if (doc.data && doc.data.doc && doc.data.doc.kind === 'dtb') { await this.openDtsText(doc.uri, m.line); return; }
        await vscode.commands.executeCommand('vscode.openWith', doc.uri, 'default'); return;
      case 'openRaw': await vscode.commands.executeCommand('vscode.openWith', doc.uri, 'default'); return;
      case 'openHex': { const h = this.hexEditor(); if (h) await vscode.commands.executeCommand('vscode.openWith', doc.uri, h.viewType); return; }
      case 'reveal': if (doc.data && doc.data.doc && doc.data.doc.kind === 'dts') await this.revealLine(doc.uri, m.line); else await this.openDtsText(doc.uri, m.line); return;
      case 'copy': if (typeof m.text === 'string') { await vscode.env.clipboard.writeText(m.text.slice(0, 100000)); vscode.window.setStatusBarMessage(`Copied ${m.what || 'the text'}`, 3000); } return;
      case 'select': doc.selected = Number(m.id); return;
      default:
    }
  }
}

module.exports = { DtEditorProvider, DtDocument, loadFile, VIEW_DTB, VIEW_DTS, DTS_SCHEME, DT_RE, formatLabel };
