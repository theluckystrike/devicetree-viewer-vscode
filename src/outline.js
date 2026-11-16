'use strict';
// The "DeviceTree" view in the Explorer: the node tree of the active .dts, .dtsi or .overlay text editor (or of the
// active DeviceTree Viewer tab). A click on a node jumps to its line in the text, or selects it in the viewer.
// The view shows only while such a file is the active editor (context key dtViewer.outlineShown, set here once the
// extension runs); it never opens anything.
const vscode = require('vscode');
const M = require('./core/model');

const TEXT_RE = /\.(dts|dtsi|overlay)$/i;

class Outline {
  constructor(provider) {
    this.provider = provider;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.doc = null;
    this.uri = null;
    this.source = '';
    this.timer = null;
  }
  update() {
    const ed = vscode.window.activeTextEditor;
    const prov = this.provider;
    if (ed && TEXT_RE.test(ed.document.uri.path)) {
      this.uri = ed.document.uri; this.source = 'text';
      try { this.doc = M.fromDts(ed.document.getText()); } catch (e) { this.doc = null; }
    } else if (!ed && prov.active && prov.activePanel && prov.activePanel.active && prov.active.data && prov.active.data.kind === 'dt') {
      this.uri = prov.active.uri; this.source = 'viewer'; this.doc = prov.active.data.doc;
    } else {
      this.shown(false);
      return false;
    }
    this.shown(true);
    this.emitter.fire(undefined);
    return true;
  }
  /** The view shows while a device tree is the active editor (context key dtViewer.outlineShown). */
  shown(on) {
    if (this._shown === on) return;
    this._shown = on;
    try { const r = vscode.commands.executeCommand('setContext', 'dtViewer.outlineShown', on); if (r && r.then) r.then(undefined, () => false); } catch (e) { /* older API */ }
  }
  later() { clearTimeout(this.timer); this.timer = setTimeout(() => this.update(), 500); }
  getChildren(n) {
    if (!this.doc) return [];
    if (!n) return this.doc.hasRoot === false ? this.doc.orphans.slice() : [this.doc.root, ...(this.doc.orphans || [])];
    return n.children;
  }
  getParent(n) { return n.parent || undefined; }
  getTreeItem(n) {
    const isRoot = n === this.doc.root;
    const state = n.children.length ? (isRoot ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed) : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(isRoot ? '/' : n.name, state);
    const st = M.statusOf(n);
    item.description = [n.labels.length ? n.labels.map((l) => `${l}:`).join(' ') : '', st && st !== 'okay' ? st : ''].filter(Boolean).join(' ');
    const compat = M.strProp(n, 'compatible');
    item.tooltip = `${n.path}${compat ? `\n${compat.join(', ')}` : ''}${n.line && this.source === 'text' ? `\nLine ${n.line}` : ''}`;
    item.command = { command: 'dtViewer.outlineReveal', title: 'Go to node', arguments: [n.path, n.line || 0] };
    item.contextValue = 'dtNode';
    return item;
  }
  async reveal(nodePath, line) {
    if (!this.uri) return;
    if (this.source === 'text') {
      const l = Math.max(0, (Number(line) || 1) - 1);
      const vis = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === this.uri.toString());
      const td = vis ? vis.document : await vscode.workspace.openTextDocument(this.uri);
      const ed = await vscode.window.showTextDocument(td, { viewColumn: vis ? vis.viewColumn : undefined, preserveFocus: false, selection: new vscode.Range(l, 0, l, 0) });
      if (ed && ed.revealRange) ed.revealRange(new vscode.Range(l, 0, l, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      return;
    }
    const f = this.provider.panelFor(this.uri);
    if (f) { f.panel.reveal && f.panel.reveal(undefined, true); this.provider.send(f.panel.webview, { type: 'selectPath', path: nodePath }); }
  }
}

function registerOutline(context, provider) {
  const o = new Outline(provider);
  const sub = (d) => context.subscriptions.push(d);
  sub(vscode.window.registerTreeDataProvider('dtViewer.outline', o));
  sub(vscode.window.onDidChangeActiveTextEditor(() => o.update()));
  sub(vscode.workspace.onDidChangeTextDocument((e) => { if (o.uri && o.source === 'text' && e.document.uri.toString() === o.uri.toString()) o.later(); }));
  sub(vscode.commands.registerCommand('dtViewer.outlineReveal', (p, line) => o.reveal(p, line)));
  o.update();
  return o;
}

module.exports = { Outline, registerOutline };
