'use strict';
// Extension tests with the vscode stub: listing, activation, the custom editors' messages for DTB, DTBO, DTS and
// overlay files and for broken ones, the DTS text view, the DeviceTree view in the Explorer, the three Pro tools with
// 1 free try each (the 2nd use opens the Pro panel, also on another file and after a reload), README and support links.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadExtension, tmpDir, cleanup } = require('./support/vscode-stub');
const { editorHtml, panelHtml } = require('../src/html');
const F = require('../src/core/fdt');
const M = require('../src/core/model');

const ROOT = path.join(__dirname, '..');
const SAMPLES = path.join(ROOT, 'samples');
const FIX = path.join(__dirname, 'fixtures');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await tick(10); } return f(); };
test.after(() => cleanup());

function fakePanel() {
  let onMsg;
  const posted = [];
  return {
    posted, viewColumn: 1, active: true,
    webview: { options: {}, html: '', cspSource: 'vscode-resource:', asWebviewUri: (u) => u, postMessage: async (m) => { posted.push(m); return true; }, onDidReceiveMessage: (f) => { onMsg = f; return { dispose() {} }; } },
    onDidChangeViewState: () => ({ dispose() {} }), onDidDispose: () => ({ dispose() {} }), reveal() {},
    send: (m) => onMsg(m),
  };
}

const activated = [];
/** Activates with a fresh stub. state: entries to put into globalState first (a "reload" of the window). */
function activate(folder, state) {
  const s = loadExtension();
  if (folder) s.vscode.workspace.workspaceFolders = [{ uri: s.vscode.Uri.file(folder), name: 'ws' }];
  if (state) for (const [k, v] of state) s.state.set(k, v);
  s.api = s.ext.activate(s.context);
  activated.push(s);
  // tool panels answer "show" with "shown" like the real panel does after drawing
  s.log.onPost = (panel, m) => { if (m.type === 'show' && m.html) panel.send({ type: 'shown' }); };
  s.opened = [];
  s.commands.set('vscode.openWith', async (uri, viewType) => {
    s.opened.push([uri.fsPath, viewType]);
    if (!/^dtViewer\./.test(viewType)) return undefined;
    const prov = s.api.provider;
    for (const d of prov.docs) if (d.uri.toString() === uri.toString() && d.panels.size) { prov.active = d; prov.activePanel = [...d.panels][0]; return undefined; }
    const e = await openEditor(s, uri.fsPath);
    prov.active = e.doc; prov.activePanel = e.panel;
    return undefined;
  });
  return s;
}
test.after(() => { for (const s of activated) s.api.provider.dispose(); });

async function openEditor(s, file) {
  const prov = s.api.provider;
  const handle = await prov.openCustomDocument(s.vscode.Uri.file(file));
  const panel = fakePanel();
  await prov.resolveCustomEditor(handle, panel);
  await panel.send({ type: 'ready' });
  const init = panel.posted.find((m) => m.type === 'init');
  if (init && init.kind === 'dt') await panel.send({ type: 'rendered', nodes: init.nodes.length });
  prov.active = handle._doc; prov.activePanel = panel;
  return { prov, handle, panel, doc: handle._doc, init };
}
function ws() {
  const dir = tmpDir('dt-ws-');
  for (const f of fs.readdirSync(SAMPLES)) fs.copyFileSync(path.join(SAMPLES, f), path.join(dir, f));
  for (const f of fs.readdirSync(FIX)) fs.copyFileSync(path.join(FIX, f), path.join(dir, f));
  fs.copyFileSync(path.join(SAMPLES, 'zovo-demo-board.dtb'), path.join(dir, 'BOARD.DTB'));
  // board B: the demo board with a changed watchdog timeout and no EEPROM
  const b = fs.readFileSync(path.join(SAMPLES, 'zovo-demo-board.dts'), 'utf8').replace('timeout-sec = <30>;', 'timeout-sec = <60>;').replace(/\n\t\t\teeprom@50 \{[\s\S]*?\n\t\t\t\};\n/, '\n');
  fs.writeFileSync(path.join(dir, 'board-b.dts'), b);
  fs.writeFileSync(path.join(dir, 'board-b.dtb'), M.compile(M.fromDts(b)));
  fs.writeFileSync(path.join(dir, 'cut.dtb'), fs.readFileSync(path.join(SAMPLES, 'zovo-demo-board.dtb')).subarray(0, 900));
  fs.writeFileSync(path.join(dir, 'empty.dtbo'), Buffer.alloc(0));
  return dir;
}
const proPanels = (s, title) => s.log.info.filter((m) => m.text === `${title} is part of Zovo Pro.`);

// ---------- package.json and listing ----------
test('listing: display name with the phrase first, 30 characters or less, description starts with the phrase, 5 keywords, engines', () => {
  assert.equal(pkg.displayName, 'DeviceTree Viewer, DTS & DTB');
  assert.ok(pkg.displayName.length <= 30);
  assert.match(pkg.description, /^Devicetree viewer/);
  assert.deepEqual(pkg.keywords, ['devicetree', 'device tree', 'dts', 'dtb', 'embedded linux']);
  assert.equal(pkg.engines.vscode, '^1.75.0');
  assert.equal(pkg.publisher, 'zovo');
  assert.equal(pkg.name, 'zovo-devicetree-viewer');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.repository.url, 'https://github.com/theluckystrike/devicetree-viewer-vscode');
  assert.deepEqual(pkg.activationEvents, ['onUri', 'onLanguage:dts', 'onLanguage:devicetree']);
  assert.ok(fs.existsSync(path.join(ROOT, 'icon.png')));
});
test('editors: .dtb and .dtbo by default; .dts, .dtsi and .overlay only as an option; no language, grammar or theme', () => {
  const [dtb, dts] = pkg.contributes.customEditors;
  assert.deepEqual(dtb.selector.map((s) => s.filenamePattern), ['*.dtb', '*.dtbo']);
  assert.equal(dtb.priority, 'default');
  assert.deepEqual(dts.selector.map((s) => s.filenamePattern), ['*.dts', '*.dtsi', '*.overlay']);
  assert.equal(dts.priority, 'option');
  assert.ok(!pkg.contributes.themes && !pkg.contributes.grammars && !pkg.contributes.languages && !pkg.contributes.configurationDefaults);
  assert.deepEqual(pkg.contributes.views.explorer.map((v) => v.id), ['dtViewer.outline']);
});
test('menus: one backslash before the dots in the final package.json; the right-click regex matches upper case; no title on menu items', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
  assert.ok(!raw.includes('\\\\\\\\.'));
  const items = Object.values(pkg.contributes.menus).flat();
  assert.ok(items.every((m) => !('title' in m)));
  const ctx = pkg.contributes.menus['explorer/context'].find((m) => m.command === 'dtViewer.zovoPro.addressMap');
  const re = new RegExp(/resourceFilename =~ \/(.*)\/i/.exec(ctx.when)[1], 'i');
  for (const f of ['BOARD.DTB', 'x.dtbo', 'a.dts', 'b.DTSI', 'nrf52840dk_nrf52840.overlay']) assert.ok(re.test(f), f);
  assert.ok(!re.test('a.txt') && !re.test('a.dtb.bak'));
  const wrappers = pkg.contributes.commands.filter((c) => /\.zovoPro\./.test(c.command));
  assert.equal(wrappers.length, 3);
  assert.ok(wrappers.every((c) => c.title.startsWith('Zovo Pro: ')));
  for (const w of wrappers) assert.ok(pkg.contributes.menus.commandPalette.some((m) => m.command === w.command && m.when === 'false'));
  assert.equal(pkg.contributes.views.explorer[0].when, 'dtViewer.outlineShown');
});
test('every contributed command is registered, and every registered dtViewer command is contributed', () => {
  const s = activate();
  const contributed = pkg.contributes.commands.map((c) => c.command);
  for (const c of contributed) assert.ok(s.commands.has(c), c);
  for (const c of s.commands.keys()) if (c.startsWith('dtViewer.')) assert.ok(contributed.includes(c), c);
});
test('activation shows nothing: no message, no panel, no editor', () => {
  const s = activate();
  assert.equal(s.log.info.length + s.log.warn.length + s.log.error.length, 0);
  assert.equal(s.log.panel, undefined);
  assert.equal(s.opened.length, 0);
});

// ---------- the viewer ----------
test('viewer: the sample DTB sends the nodes, facts and DTS text; rating success once after it rendered', async () => {
  const s = activate();
  const { init, doc } = await openEditor(s, path.join(SAMPLES, 'zovo-demo-board.dtb'));
  assert.equal(init.kind, 'dt');
  assert.equal(init.source, 'dtb');
  assert.equal(init.label, 'DTB');
  assert.equal(init.nodes.length, F.read(fs.readFileSync(path.join(SAMPLES, 'zovo-demo-board.dtb'))).counts.nodes);
  assert.match(init.dts, /^\/dts-v1\/;/);
  const gpio = init.nodes.find((n) => n.path === '/soc/gpio@10000');
  assert.equal(init.dts.split('\n')[gpio.line - 1].trim(), 'gpio0: gpio@10000 {');
  assert.ok(init.facts.some((f) => f.k === 'Model' && f.v === 'Zovo Demo Board'));
  assert.ok(doc.rendered && doc.rendered.nodes === init.nodes.length);
});
test('viewer: DTS, Zephyr overlay and a file with a syntax error; the error names its line and the nodes before it show', async () => {
  const s = activate();
  const a = await openEditor(s, path.join(SAMPLES, 'zovo-demo-board.dts'));
  assert.equal(a.init.source, 'dts');
  assert.equal(a.init.label, 'DTS');
  assert.equal(a.init.nodes.find((n) => n.path === '/soc/serial@20000').line, fs.readFileSync(path.join(SAMPLES, 'zovo-demo-board.dts'), 'utf8').split('\n').findIndex((l) => l.includes('uart0: serial@20000 {')) + 1);
  const o = await openEditor(s, path.join(FIX, 'zephyr-led-strip-esp32c3.overlay'));
  assert.equal(o.init.label, 'Overlay');
  assert.deepEqual(o.init.nodes.filter((n) => n.orphan).map((n) => n.name), ['&spi2', '&pinctrl']);
  const b = await openEditor(s, path.join(FIX, 'broken.dts'));
  assert.equal(b.init.kind, 'dt');
  assert.deepEqual(b.init.errors.map((e) => e.line), [7]);
  assert.equal(s.log.error.length, 0);
});
test('viewer: not a device tree, empty and cut files give plain notes, no error message, and no tab is reopened by itself', async () => {
  const dir = ws();
  const s = activate(dir);
  const n = await openEditor(s, path.join(dir, 'not-a-tree.dtb'));
  assert.equal(n.init.kind, 'notfdt');
  assert.match(n.init.error, /does not start with the device tree magic 0xd00dfeed/);
  const e = await openEditor(s, path.join(dir, 'empty.dtbo'));
  assert.equal(e.init.kind, 'empty');
  const c = await openEditor(s, path.join(dir, 'cut.dtb'));
  assert.equal(c.init.kind, 'error');
  assert.match(c.init.error, /cut off/);
  assert.equal(s.log.error.length + s.log.warn.length + s.log.info.length, 0);
  assert.equal(s.opened.length, 0);
});
test('viewer: Open DTS Text of a DTB opens a read-only DTS document at the node line; a DTS node opens its source line', async () => {
  const s = activate();
  const a = await openEditor(s, path.join(SAMPLES, 'zovo-demo-board.dtb'));
  await a.panel.send({ type: 'openText', line: 12 });
  const shown = s.log.opened.pop();
  assert.equal(shown.uri.scheme, 'dtviewer-dts');
  assert.match(shown.getText(), /gpio0: gpio@10000 \{/);
  assert.equal(shown.getText(), a.init.dts);
  const b = await openEditor(s, path.join(SAMPLES, 'zovo-demo-board.dts'));
  await b.panel.send({ type: 'reveal', line: 30 });
  const t = s.log.opened.pop();
  assert.equal(t.uri.fsPath, path.join(SAMPLES, 'zovo-demo-board.dts'));
  await b.panel.send({ type: 'openText' });
  assert.deepEqual(s.opened.pop(), [path.join(SAMPLES, 'zovo-demo-board.dts'), 'default']);
});
test('DeviceTree view: lists the nodes of the active DTS text editor and a click goes to the node line', async () => {
  const s = activate();
  const file = path.join(SAMPLES, 'zovo-demo-board.dts');
  const ed = s.show(fs.readFileSync(file, 'utf8'), 'plaintext', file);
  for (const f of s.listeners.active) f(ed);
  const tree = s.providers.trees.get('dtViewer.outline');
  const roots = tree.getChildren();
  assert.equal(roots.length, 1);
  const kids = tree.getChildren(roots[0]).map((n) => n.name);
  assert.deepEqual(kids.slice(0, 4), ['aliases', 'chosen', 'cpus', 'memory@80000000']);
  const soc = tree.getChildren(roots[0]).find((n) => n.name === 'soc');
  const item = tree.getTreeItem(tree.getChildren(soc).find((n) => n.name === 'serial@20000'));
  assert.equal(item.description, 'uart0:');
  assert.equal(item.command.command, 'dtViewer.outlineReveal');
  s.vscode.window.visibleTextEditors = [ed];
  await s.vscode.commands.executeCommand(item.command.command, ...item.command.arguments);
  const opened = s.log.opened.pop();
  assert.equal(opened.uri.fsPath, file);
  assert.deepEqual(s.log.commands.filter((c) => c[0] === 'setContext').pop(), ['setContext', 'dtViewer.outlineShown', true]);
  // another text file becomes active: the view hides
  const other = s.show('hello', 'plaintext', path.join(ROOT, 'README.md'));
  for (const f of s.listeners.active) f(other);
  assert.deepEqual(s.log.commands.filter((c) => c[0] === 'setContext').pop(), ['setContext', 'dtViewer.outlineShown', false]);
});

// ---------- webview safety ----------
test('webview HTML: strict CSP, nonce scripts, no remote URLs, no blob, worker or connect sources', () => {
  const e = editorHtml({ cspSource: 'vscode-resource:', scriptUri: 'media/viewer.js', styleUri: 'media/viewer.css', title: 'x<y', showSupportLinks: true, nonce: 'abc' });
  const p = panelHtml({ cspSource: 'vscode-resource:', scriptUri: 'media/panel.js', styleUri: 'media/viewer.css', title: 't', nonce: 'abc' });
  for (const h of [e, p]) {
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(h)[1];
    assert.match(csp, /^default-src 'none'/);
    assert.match(csp, /script-src 'nonce-abc'(;|$)/);
    assert.doesNotMatch(csp, /unsafe-eval|unsafe-inline|connect-src|worker-src|blob:|https?:/);
    assert.ok([...h.matchAll(/<script\b[^>]*>/g)].every((m) => /nonce="abc"/.test(m[0])));
    assert.doesNotMatch(h.replace(/https:\/\/(marketplace\.visualstudio\.com|github\.com|www\.paypal\.com|open-vsx\.org)[^"]*/g, ''), /https?:\/\//);
  }
  assert.match(e, /<title>x&lt;y<\/title>/);
});
test('media scripts load nothing remote and open no connection', () => {
  for (const f of ['viewer.js', 'panel.js']) {
    const t = fs.readFileSync(path.join(ROOT, 'media', f), 'utf8');
    assert.doesNotMatch(t, /fetch\(|XMLHttpRequest|WebSocket|new Worker|importScripts|https?:\/\/|eval\(/, f);
  }
});
test('no source file opens a network connection', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(path.join(ROOT, 'src')).filter((x) => x.endsWith('.js') && !x.includes(`${path.sep}license${path.sep}`))) {
    const t = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(t, /require\(['"](https?|net|tls|dgram|child_process)['"]\)|fetch\(/, f);
  }
});

// ---------- Pro: compare ----------
test('Pro Compare: DTB A with DTS B gives the changed timeout and the missing EEPROM; Markdown saved; try counted after the report showed', async () => {
  const dir = ws();
  const s = activate(dir);
  const a = s.vscode.Uri.file(path.join(dir, 'zovo-demo-board.dtb'));
  s.ui.quick.push((items) => items.find((i) => i.label === 'board-b.dts'));
  const r = await s.api.tools.diff(a);
  assert.deepEqual(r.onlyA, ['/soc/i2c@21000/eeprom@50']);
  assert.deepEqual(r.onlyB, []);
  assert.deepEqual(r.changed.map((c) => c.path), ['/soc/watchdog@23000']);
  await until(() => s.api.pro.left('diff') === 0);
  const show = s.log.panel.posted.find((m) => m.type === 'show');
  assert.match(show.html, /<b id="nOnlyA">1<\/b>/);
  assert.match(show.html, /timeout-sec/);
  s.ui.save.push(s.vscode.Uri.file(path.join(dir, 'report.md')));
  await s.log.panel.send({ type: 'action', id: 'md' });
  const md = fs.readFileSync(path.join(dir, 'report.md'), 'utf8');
  assert.match(md, /^# Device tree comparison\n\n- A: zovo-demo-board\.dtb\n- B: board-b\.dts\n/);
  assert.match(md, /\| timeout-sec \| changed \| `<0x1e>` \| `<0x3c>` \|/);
  s.ui.save.push(s.vscode.Uri.file(path.join(dir, 'report.html')));
  await s.log.panel.send({ type: 'action', id: 'html' });
  assert.match(fs.readFileSync(path.join(dir, 'report.html'), 'utf8'), /<h1>Device tree comparison<\/h1>/);
  assert.equal(s.api.pro.used('diff'), 1);
});
test('Pro Compare A then B: after one use, comparing another pair opens the Pro panel; Escape in the pick used no try', async () => {
  const dir = ws();
  const s = activate(dir);
  const a = s.vscode.Uri.file(path.join(dir, 'zovo-demo-board.dtb'));
  s.ui.quick.push(undefined); // Escape
  assert.equal(await s.api.tools.diff(a), undefined);
  assert.equal(s.api.pro.left('diff'), 1);
  await s.api.tools.diff(a, { other: s.vscode.Uri.file(path.join(dir, 'board-b.dtb')) });
  await until(() => s.api.pro.left('diff') === 0);
  const r = await s.api.tools.diff(s.vscode.Uri.file(path.join(dir, 'board-b.dts')), { other: s.vscode.Uri.file(path.join(dir, 'zovo-demo-board.dts')) });
  assert.equal(r, undefined);
  assert.equal(proPanels(s, 'Compare two device trees').length, 1);
  assert.equal(s.log.panel.posted.filter((m) => m.type === 'show').length, 1);
});

// ---------- Pro: export and compile ----------
test('Pro Export: the DTB as JSON (file written and opened); try counted after the file was written', async () => {
  const dir = ws();
  const s = activate(dir);
  const a = s.vscode.Uri.file(path.join(dir, 'zovo-demo-board.dtb'));
  s.ui.quick.push((items) => { assert.deepEqual(items.map((i) => i.id), ['dts', 'json', 'yaml']); return items.find((i) => i.id === 'json'); });
  s.ui.save.push(s.vscode.Uri.file(path.join(dir, 'out.json')));
  const r = await s.api.tools.exportTree(a);
  assert.equal(r.format, 'json');
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8'));
  assert.equal(j.root.properties.model, 'Zovo Demo Board');
  assert.equal(s.log.opened.pop().uri.fsPath, path.join(dir, 'out.json'));
  assert.equal(s.api.pro.used('export'), 1);
});
test('Pro Export: a DTS compiles to a DTB that reads back to the same tree, and opens in the viewer', async () => {
  const dir = ws();
  const s = activate(dir);
  const src = s.vscode.Uri.file(path.join(dir, 'board-b.dts'));
  s.ui.quick.push((items) => { assert.equal(items[0].id, 'dtb'); return items[0]; });
  s.ui.save.push(s.vscode.Uri.file(path.join(dir, 'compiled.dtb')));
  const r = await s.api.tools.exportTree(src);
  assert.equal(r.format, 'dtb');
  const out = fs.readFileSync(path.join(dir, 'compiled.dtb'));
  assert.equal(Buffer.compare(out, fs.readFileSync(path.join(dir, 'board-b.dtb'))), 0);
  assert.deepEqual(s.opened.pop(), [path.join(dir, 'compiled.dtb'), 'dtViewer.dtb']);
});
test('Pro Export: a compile error names the line and uses no try; Cancel in the save dialog uses no try; never writes over its own file', async () => {
  const dir = ws();
  const s = activate(dir);
  const ex = s.vscode.Uri.file(path.join(dir, 'exprs.dts'));
  assert.equal(await s.api.tools.exportTree(ex, { format: 'dtb' }), undefined);
  assert.match(s.log.error.pop().text, /exprs\.dts could not be compiled\. Line 19: "SOME_HEADER_MACRO" is not defined/);
  s.ui.save.push(undefined);
  assert.equal(await s.api.tools.exportTree(ex, { format: 'json' }), undefined);
  assert.equal(await s.api.tools.exportTree(ex, { format: 'dts', dest: ex }), undefined);
  assert.match(s.log.error.pop().text, /never writes over the file it reads/);
  assert.equal(s.api.pro.left('export'), 1);
});
test('Pro Export A then B: after the YAML of file A, the export of file B opens the Pro panel', async () => {
  const dir = ws();
  const s = activate(dir);
  await s.api.tools.exportTree(s.vscode.Uri.file(path.join(dir, 'zovo-demo-board.dtb')), { format: 'yaml', dest: s.vscode.Uri.file(path.join(dir, 'a.yaml')) });
  assert.match(fs.readFileSync(path.join(dir, 'a.yaml'), 'utf8'), /^format: dtb\n/);
  assert.equal(s.api.pro.left('export'), 0);
  const r = await s.api.tools.exportTree(s.vscode.Uri.file(path.join(dir, 'board-b.dts')), { format: 'dtb', dest: s.vscode.Uri.file(path.join(dir, 'b.dtb')) });
  assert.equal(r, undefined);
  assert.ok(!fs.existsSync(path.join(dir, 'b.dtb')));
  assert.equal(proPanels(s, 'Export and compile').length, 1);
});

// ---------- Pro: address and pin map ----------
test('Pro Address map: the table shows, the GPIO used twice is flagged, CSV saved; try counted after the map showed', async () => {
  const dir = ws();
  const s = activate(dir);
  const a = s.vscode.Uri.file(path.join(dir, 'zovo-demo-board.dtb'));
  const m = await s.api.tools.addressMap(a);
  assert.equal(m.gpioDup, 1);
  await until(() => s.api.pro.left('addressMap') === 0);
  const show = s.log.panel.posted.find((x) => x.type === 'show');
  assert.match(show.html, /<b id="nGpioDup">1<\/b>/);
  assert.match(show.html, /<tr data-kind="reg" class=""><td>reg<\/td><td><code>\/soc\/serial@20000<\/code><\/td><td>uart0<\/td><td>okay<\/td><td><code>0x40020000<\/code><\/td>/);
  s.ui.save.push(s.vscode.Uri.file(path.join(dir, 'map.csv')));
  await s.log.panel.send({ type: 'action', id: 'csv' });
  const csv = fs.readFileSync(path.join(dir, 'map.csv'), 'utf8').trim().split('\n');
  assert.equal(csv[0], 'kind,node,label,compatible,status,start,end,size,controller,detail,flags');
  assert.equal(csv.length, m.rows.length + 1);
});
test('Pro Address map A then B: used on the DTB, the click on the DTS opens the Pro panel (from the active viewer too)', async () => {
  const dir = ws();
  const s = activate(dir);
  await s.api.tools.addressMap(s.vscode.Uri.file(path.join(dir, 'zovo-demo-board.dtb')));
  await until(() => s.api.pro.left('addressMap') === 0);
  const panels = s.log.posted.filter((m) => m.type === 'show').length;
  await openEditor(s, path.join(dir, 'board-b.dts'));
  const r = await s.vscode.commands.executeCommand('dtViewer.addressMap');
  assert.equal(r, undefined);
  assert.equal(proPanels(s, 'Address and pin map').length, 1);
  assert.equal(s.log.posted.filter((m) => m.type === 'show').length, panels);
});

// ---------- tries across tools, reloads and the panel ----------
test('a window reload keeps the counts: after a reload every used tool opens the Pro panel', async () => {
  const dir = ws();
  const s = activate(dir);
  await s.api.tools.addressMap(s.vscode.Uri.file(path.join(dir, 'zovo-demo-board.dtb')));
  await s.api.tools.diff(s.vscode.Uri.file(path.join(dir, 'zovo-demo-board.dtb')), { other: s.vscode.Uri.file(path.join(dir, 'board-b.dtb')) });
  await until(() => s.api.pro.left('addressMap') === 0 && s.api.pro.left('diff') === 0);
  const s2 = activate(dir, s.state);
  assert.deepEqual(s2.api.pro.tries(), { diff: 0, export: 1, addressMap: 0 });
  assert.equal(await s2.api.tools.addressMap(s2.vscode.Uri.file(path.join(dir, 'board-b.dts'))), undefined);
  assert.equal(proPanels(s2, 'Address and pin map').length, 1);
  assert.equal(await s2.api.tools.diff(s2.vscode.Uri.file(path.join(dir, 'board-b.dtb')), { other: s2.vscode.Uri.file(path.join(dir, 'zovo-demo-board.dtb')) }), undefined);
  assert.equal(proPanels(s2, 'Compare two device trees').length, 1);
});
test('the Pro panel names the other tools with their tries and no URL is opened when it is cancelled', async () => {
  const dir = ws();
  const s = activate(dir);
  await s.api.tools.addressMap(s.vscode.Uri.file(path.join(dir, 'zovo-demo-board.dtb')));
  await until(() => s.api.pro.left('addressMap') === 0);
  await s.api.tools.addressMap(s.vscode.Uri.file(path.join(dir, 'zovo-demo-board.dtb')));
  const p = proPanels(s, 'Address and pin map')[0];
  assert.ok(p && p.opts.modal);
  assert.match(p.opts.detail, /You used the free try of Address and pin map on this computer\./);
  assert.match(p.opts.detail, /Compare two device trees: 0 of 1 free try used/);
  assert.match(p.opts.detail, /Export and compile: 0 of 1 free try used/);
  assert.equal(s.log.external.length, 0);
});
test('the Explorer entry runs the tool on the clicked file', async () => {
  const dir = ws();
  const s = activate(dir);
  const m = await s.vscode.commands.executeCommand('dtViewer.zovoPro.addressMap', s.vscode.Uri.file(path.join(dir, 'BOARD.DTB')));
  assert.equal(m.gpioDup, 1);
  assert.equal(s.log.panel.title, 'Address and pin map: BOARD.DTB');
});
test('the toolbar row lists the 3 Pro tools with 1 free try each; one constant; the proinfo tries key matches', () => {
  const s = activate();
  const reachCfg = require('../src/reach-config');
  assert.deepEqual(reachCfg.tools.map((t) => t.id), ['diff', 'export', 'addressMap']);
  const pro = require('../src/pro');
  assert.equal(pro.TRIAL_USES, 1);
  const cfg = require('../src/license/config');
  assert.equal(cfg.listing, 'devicetree');
  assert.equal(cfg.pro_info.triesKey, pro.TRIAL_KEY);
  assert.equal(reachCfg.triesKey, pro.TRIAL_KEY);
  assert.equal(cfg.pro_info.triesMax, undefined);
  assert.deepEqual(cfg.pro_info.tools.map((t) => t.id), ['diff', 'export', 'addressMap']);
  assert.deepEqual(Object.keys(s.api.pro.tries()), ['diff', 'export', 'addressMap']);
  const row = s.api.provider.hooks.reach().rowHtml();
  assert.equal((row.match(/<small>1 free try<\/small>/g) || []).length, 3);
  assert.match(row, /Get Zovo Pro/);
});

// ---------- README and text ----------
test('README: first screen has the main use, a screenshot of this product, the free list and the price; by Zovo; no rival names', () => {
  const md = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const first = md.split('\n').slice(0, 30).join('\n');
  assert.match(first, /^# DeviceTree Viewer, DTS & DTB/);
  assert.match(first, /\(images\/screenshot\.png\)/);
  assert.match(first, /Zovo Pro: USD 19 once/);
  assert.match(md, /by Zovo/i);
  for (const f of ['README.md', 'CHANGELOG.md', 'package.json', 'walkthrough/source.md', 'walkthrough/related.md', 'THIRD-PARTY-NOTICES.md', 'src/core/fdt.js', 'src/core/dts.js', 'src/core/model.js', 'src/core/diff.js', 'src/core/addrmap.js', 'src/core/view.js', 'src/editor.js', 'src/tools.js', 'src/outline.js', 'src/extension.js', 'media/viewer.js', 'media/panel.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), /\bdtc\b|libfdt|plorefice|nordic-semiconductor|nrf-devicetree|dts-lsp|KyleMicallef|trond-snekvik|legale|dts-formatter|SiliconBlade|dtb-editor/i, f);
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'images', 'screenshot.png')));
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8'), /^images\/?(\*\*|\*\.png|screenshot)?\s*$/m);
});
test('support links name this listing and related Zovo tools', () => {
  const support = require('../src/support');
  assert.equal(support.SELF_ID, 'zovo.zovo-devicetree-viewer');
  assert.ok(support.RELATED.length >= 3 && !support.RELATED.includes(support.SELF_ID));
  assert.equal(support.PRO.getPro, 'dtViewer.getPro');
  const steps = pkg.contributes.walkthroughs[0].steps;
  const links = steps.flatMap((st) => [...st.description.matchAll(/command:extension\.open\?%5B%22([^%]+)%22%5D/g)].map((m) => m[1]));
  assert.deepEqual(links, ['zovo.zovo-elf-pe-viewer', 'zovo.zovo-intel-hex-viewer', 'zovo.zovo-linker-map-viewer']);
  for (const id of links) assert.ok(fs.existsSync(path.join(ROOT, '..', id.replace('zovo.zovo-', '') + '-vscode')), id);
});
