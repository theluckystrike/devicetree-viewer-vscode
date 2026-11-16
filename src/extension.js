'use strict';
// DeviceTree Viewer, DTS & DTB by Zovo: opens compiled device trees (.dtb, .dtbo) as a node tree and DTS text, and
// .dts, .dtsi and Zephyr .overlay files as a tree on request (Open With, or the DeviceTree view in the Explorer).
// No network, no telemetry. Activation shows nothing: no message, no popup. The viewer opens only for files the user
// opens, and it never reopens a tab in another editor by itself.
const vscode = require('vscode');
const { DtEditorProvider, VIEW_DTB, VIEW_DTS, DTS_SCHEME, DT_RE } = require('./editor');
const { createTools } = require('./tools');
const { createPro } = require('./pro');
const { registerOutline } = require('./outline');
const { createRatingPrompt } = require('./rate');
const support = require('./support');
const { createReach } = require('./reach');
const reachConfig = require('./reach-config');

const PREFIX = 'dtViewer';
const EXT_ID = 'zovo.zovo-devicetree-viewer';
const setting = (k, d) => vscode.workspace.getConfiguration(PREFIX).get(k, d);

function activate(context) {
  const sub = (d) => context.subscriptions.push(d);
  let rating = { success() {}, failure() {} };
  try { rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: PREFIX, name: 'DeviceTree Viewer' }); } catch (e) { /* rating is optional */ }
  support.registerSupport({ vscode, context, prefix: PREFIX, selfId: EXT_ID });
  const pro = createPro({ vscode, context });
  const reach = createReach({ vscode, ...reachConfig, maximum: pro.TRIAL_USES, context, licensed: () => !!pro.licensed, shown: () => setting('showProTools', true) !== false });
  reach.registerCtx();
  sub(pro.onDidChange(() => reach.refresh()));

  let outline = null;
  const provider = new DtEditorProvider(context, {
    reach: () => reach,
    onSuccess: (doc) => rating.success(doc.uri),
    onFailure: () => rating.failure(),
    onActive: () => { if (outline) outline.update(); },
    onChange: () => { if (outline) outline.update(); },
  });
  const opts = { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true };
  sub(vscode.window.registerCustomEditorProvider(VIEW_DTB, provider, opts));
  sub(vscode.window.registerCustomEditorProvider(VIEW_DTS, provider, opts));
  sub(provider);
  sub(vscode.workspace.registerTextDocumentContentProvider(DTS_SCHEME, { provideTextDocumentContent: (u) => provider.dtsTextFor(u) }));
  const tools = createTools({ context, provider, pro, reach });
  outline = registerOutline(context, provider);

  const reg = (id, fn) => sub(vscode.commands.registerCommand(id, async (...a) => {
    try { return await fn(...a); } catch (e) { vscode.window.showErrorMessage(String((e && e.message) || e)); return undefined; }
  }));
  const target = (uri) => (uri && uri.scheme ? uri : undefined);
  const sample = (name) => vscode.Uri.joinPath(context.extensionUri, 'samples', name);
  const viewFor = (u) => (/\.dtbo?$/i.test(u.path) ? VIEW_DTB : VIEW_DTS);
  reg(`${PREFIX}.openWithViewer`, (uri) => {
    const u = uri && uri.scheme ? uri : (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
    if (!u || !DT_RE.test(u.path)) { vscode.window.showInformationMessage('Select a .dtb, .dtbo, .dts, .dtsi or .overlay file first.'); return undefined; }
    return vscode.commands.executeCommand('vscode.openWith', u, viewFor(u));
  });
  reg(`${PREFIX}.openAsText`, (uri) => {
    const u = uri && uri.scheme ? uri : (provider.active && provider.active.uri);
    if (!u) return undefined;
    if (/\.dtbo?$/i.test(u.path)) return provider.openDtsText(u, 0);
    return vscode.commands.executeCommand('vscode.openWith', u, 'default');
  });
  reg(`${PREFIX}.openSample`, () => vscode.commands.executeCommand('vscode.openWith', sample('zovo-demo-board.dtb'), VIEW_DTB));
  reg(`${PREFIX}.openSampleDts`, () => vscode.commands.executeCommand('vscode.openWith', sample('zovo-demo-board.dts'), VIEW_DTS));
  reg(`${PREFIX}.openWalkthrough`, () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#${PREFIX}.start`, false));
  reg(`${PREFIX}.diff`, reach.wrap((uri, extra) => tools.diff(target(uri), extra && !extra.scheme && !Array.isArray(extra) ? extra : {})));
  reg(`${PREFIX}.export`, reach.wrap((uri, extra) => tools.exportTree(target(uri), extra && !extra.scheme && !Array.isArray(extra) ? extra : {})));
  reg(`${PREFIX}.addressMap`, reach.wrap((uri) => tools.addressMap(target(uri))));
  sub(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration(`${PREFIX}.showProTools`)) reach.refresh(); }));
  sub(vscode.window.registerUriHandler({ handleUri: (uri) => pro.handleUri(uri) }));
  return { provider, tools, pro, outline };
}

function deactivate() {}

module.exports = { activate, deactivate };
