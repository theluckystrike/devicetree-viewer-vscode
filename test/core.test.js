'use strict';
// Core tests: FDT reader and writer, DTS parser and merge, values and phandles, reg and interrupts, DTS printer,
// compiler, JSON and YAML, diff and the address and pin map. Real files: two Zephyr overlays in test/fixtures, and,
// when the folder is there, Raspberry Pi DTB and DTBO files and kernel/Zephyr DTS files from DT_REAL_DIR (they are
// GPL-2.0 or Apache-2.0 files that this MIT repo does not ship; the gate uses the same files).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const F = require('../src/core/fdt');
const P = require('../src/core/dts');
const M = require('../src/core/model');
const D = require('../src/core/diff');
const A = require('../src/core/addrmap');
const V = require('../src/core/view');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const SAMPLE_DTS = fs.readFileSync(path.join(ROOT, 'samples', 'zovo-demo-board.dts'), 'utf8');
const SAMPLE_DTB = fs.readFileSync(path.join(ROOT, 'samples', 'zovo-demo-board.dtb'));
const REAL = process.env.DT_REAL_DIR || path.join(os.homedir(), 'plugin-market-intel-work', 'newb14-work', 'devicetree', 'dl');
const real = (rel) => path.join(REAL, rel);
const hasReal = fs.existsSync(real('rpi-fw-4b/bcm2711-rpi-4-b.dtb'));

// structural dump of an FDT: every node path and every property as hex, sorted
function flat(t) {
  const o = [];
  const w = (n, p) => { o.push(`${p}/`); for (const q of n.props) o.push(`${p}:${q.name}=${Buffer.from(q.raw).toString('hex')}`); for (const c of n.children) w(c, `${p}/${c.name}`); };
  w(t.root, '');
  return o.sort();
}
const byPath = (doc, p) => doc.all.find((n) => n.path === p);

// ---------- FDT ----------
test('fdt: the sample DTB has the header, memory reservation and nodes the sample DTS describes', () => {
  const t = F.read(SAMPLE_DTB);
  assert.equal(t.header.magic, 0xd00dfeed);
  assert.equal(t.header.version, 17);
  assert.equal(t.header.last_comp_version, 16);
  assert.equal(t.header.totalsize, SAMPLE_DTB.length);
  assert.deepEqual(t.reserve, [{ address: 0x80000000n, size: 0x10000n }]);
  assert.deepEqual(t.root.children.map((c) => c.name).slice(0, 4), ['aliases', 'chosen', 'cpus', 'memory@80000000']);
  assert.ok(t.counts.nodes >= 25);
});
test('fdt: write(read(x)) keeps every node and property byte for byte', () => {
  const t = F.read(SAMPLE_DTB);
  const b = F.write({ root: t.root, reserve: t.reserve, bootCpu: 3 });
  const t2 = F.read(b);
  assert.deepEqual(flat(t2), flat(t));
  assert.equal(t2.header.boot_cpuid_phys, 3);
  assert.equal(t2.header.off_mem_rsvmap % 8, 0);
  assert.equal(t2.header.off_dt_struct % 4, 0);
});
test('fdt: broken blobs give plain messages (no magic, cut file, bad offsets, unknown token, too short)', () => {
  assert.throws(() => F.read(Buffer.from('hello world, not a tree at all, padded to forty bytes....')), /does not start with the device tree magic/);
  assert.throws(() => F.read(SAMPLE_DTB.subarray(0, 1000)), /cut off/);
  assert.throws(() => F.read(SAMPLE_DTB.subarray(0, 20)), /shorter than the 40-byte/);
  const bad = Buffer.from(SAMPLE_DTB); bad.writeUInt32BE(0xffff, 8);
  assert.throws(() => F.read(bad), /structure block .* lies outside/);
  const tok = Buffer.from(SAMPLE_DTB); tok.writeUInt32BE(7, tok.readUInt32BE(8));
  assert.throws(() => F.read(tok), /Unknown token 0x7/);
  const old = Buffer.from(SAMPLE_DTB); old.writeUInt32BE(3, 20);
  assert.throws(() => F.read(old), /version 3 is older than 16/);
  assert.equal(F.isFdt(SAMPLE_DTB), true);
  assert.equal(F.isFdt(Buffer.from('abcd')), false);
});

// ---------- DTS ----------
test('dts: the sample parses with no error: nodes, labels, includes none, macros kept, memreserve', () => {
  const p = P.parse(SAMPLE_DTS);
  assert.deepEqual(p.errors, []);
  assert.equal(p.v1, true);
  assert.deepEqual(Object.keys(p.defines), ['GIC_SPI', 'IRQ_TYPE_LEVEL_HIGH', 'GPIO_ACTIVE_HIGH', 'GPIO_ACTIVE_LOW']);
  assert.deepEqual(p.memreserve.map((r) => [r.address, r.size]), [[0x80000000n, 0x10000n]]);
  const doc = M.fromDts(SAMPLE_DTS);
  assert.equal(doc.orphans.length, 0);
  assert.equal(byPath(doc, '/soc/gpio@10000').labels[0], 'gpio0');
  assert.equal(byPath(doc, '/soc/gpio@10000').line, SAMPLE_DTS.split('\n').findIndex((l) => l.includes('gpio0: gpio@10000 {')) + 1);
  const led = byPath(doc, '/leds/led-status');
  assert.equal(M.valueText(M.prop(led, 'gpios')), '<&gpio0 0x5 GPIO_ACTIVE_HIGH>');
  assert.equal(M.cellsOf(M.prop(led, 'gpios'))[0].target, byPath(doc, '/soc/gpio@10000'));
});
test('dts: a syntax error names the line and keeps the nodes read before it', () => {
  const doc = M.fromDts(fs.readFileSync(path.join(FIX, 'broken.dts'), 'utf8'));
  assert.equal(doc.errors.length, 1);
  assert.equal(doc.errors[0].line, 7);
  assert.match(doc.errors[0].message, /expected ";" after the value of "reg"/);
  assert.equal(M.strProp(doc.root, 'model')[0], 'Broken');
  assert.ok(byPath(doc, '/uart@1000'));
  assert.throws(() => M.compile(doc), /Line 7/);
});
test('dts: &label blocks, /delete-node/, /delete-property/, repeated root blocks and &{/path} merge into one tree', () => {
  const doc = M.fromDts(`/dts-v1/;
/ { a: x { p = <1>; q = "x"; }; y { z { }; }; };
/ { x { p = <2>; }; };
&a { r; /delete-property/ q; };
&{/y} { k = <3>; /delete-node/ z; };
&outside { s = <4>; };
/delete-node/ &a;
`);
  assert.deepEqual(doc.errors, []);
  assert.equal(byPath(doc, '/x'), undefined); // deleted by label at the end
  assert.deepEqual(byPath(doc, '/y').props.map((p) => p.name), ['k']);
  assert.equal(byPath(doc, '/y').children.length, 0);
  assert.deepEqual(doc.orphans.map((o) => o.name), ['&outside']);
  const d2 = M.fromDts('/ { a: x { p = <1>; q = "x"; }; }; / { x { p = <2>; }; }; &a { r; /delete-property/ q; };');
  assert.deepEqual(byPath(d2, '/x').props.map((p) => `${p.name}=${M.valueText(p)}`), ['p=<0x2>', 'r=']);
});
test('dts: real Zephyr overlays (Apache-2.0): &label blocks become references, macros stay text, labels inside them resolve', () => {
  const blinky = M.fromDts(fs.readFileSync(path.join(FIX, 'zephyr-blinky-pwm-nrf52840dk.overlay'), 'utf8'));
  assert.deepEqual(blinky.errors, []);
  assert.deepEqual(blinky.orphans.map((o) => o.name), ['&pwm0', '&sw_pwm', '&pwm_led0']);
  assert.equal(M.valueText(M.prop(blinky.orphans[2], 'pwms')), '<&sw_pwm 0x0 PWM_MSEC(20) PWM_POLARITY_INVERTED>');
  const strip = M.fromDts(fs.readFileSync(path.join(FIX, 'zephyr-led-strip-esp32c3.overlay'), 'utf8'));
  assert.deepEqual(strip.errors, []);
  assert.deepEqual(strip.includes.map((i) => i.file), ['zephyr/dt-bindings/led/led.h']);
  const ws = strip.all.find((n) => n.name === 'ws2812@0');
  assert.deepEqual(ws.labels, ['led_strip']);
  assert.equal(M.valueText(M.prop(ws, 'color-mapping')), '<LED_COLOR_ID_GREEN LED_COLOR_ID_RED LED_COLOR_ID_BLUE>');
  const alias = M.prop(byPath(strip, '/aliases'), 'led-strip');
  assert.equal(alias.val[0].target, ws);
});
test('dts: values: strings with escapes, /bits/, bytes, char literals, expressions, path and phandle references', () => {
  const doc = M.fromDts(fs.readFileSync(path.join(FIX, 'exprs.dts'), 'utf8'));
  assert.deepEqual(doc.errors, []);
  const n = byPath(doc, '/node@1000');
  assert.equal(M.valueText(M.prop(n, 'str')), '"tab\\there", "quote\\""');
  assert.equal(M.prop(n, 'str').val[0].v, 'tab\there');
  assert.equal(M.valueText(M.prop(n, 'wide')), '/bits/ 64 <0x123456789abcdef0>');
  assert.equal(M.valueText(M.prop(n, 'bytes')), '[01 02 0a ff]');
  assert.equal(M.valueText(M.prop(n, 'path')), '&a');
  assert.equal(M.prop(n, 'self').val[0].v[0].target, n);
});

// ---------- expressions and compiler ----------
test('expressions: C integer operators, precedence, macros with arguments, unknown macro named', () => {
  const defs = P.parse('#define A 3\n#define TWICE(x) ((x) * 2)\n#define B (A + 1)\n').defines;
  assert.equal(M.evalExpr('(1 + 2 * 3)'), 7n);
  assert.equal(M.evalExpr('((1 << 4) | 3)'), 19n);
  assert.equal(M.evalExpr('(TWICE(B))', defs), 8n);
  assert.equal(M.evalExpr('(10 > 3 ? 7 : 9)'), 7n);
  assert.equal(M.evalExpr('(-1)') & 0xffffffffn, 0xffffffffn);
  assert.equal(M.evalExpr("('A')"), 65n);
  assert.equal(M.evalExpr('(7 / 2 + 7 % 2)'), 4n);
  assert.throws(() => M.evalExpr('(GPIO_ACTIVE_HIGH)', {}, 12), /Line 12: "GPIO_ACTIVE_HIGH" is not defined in this file/);
  assert.throws(() => M.evalExpr('(1 / 0)'), /division by zero/);
});
test('compile: the sample DTS compiles to the shipped sample DTB, byte for byte', () => {
  const out = M.compile(M.fromDts(SAMPLE_DTS));
  assert.equal(Buffer.compare(Buffer.from(out), SAMPLE_DTB), 0);
});
test('compile: expressions, /bits/, bytes and references encode right; a phandle is added to the referenced node', () => {
  const src = fs.readFileSync(path.join(FIX, 'exprs.dts'), 'utf8').replace(/\s*unknown = <SOME_HEADER_MACRO>;/, '');
  const t = F.read(M.compile(M.fromDts(src)));
  const n = t.root.children[0];
  const hex = (name) => Buffer.from(n.props.find((p) => p.name === name).raw).toString('hex');
  assert.equal(hex('reg'), '0000100000000400');
  assert.equal(hex('flags'), '0000000affffffff0000004100000007');
  assert.equal(hex('wide'), '123456789abcdef0');
  assert.equal(hex('small'), '1234');
  assert.equal(hex('bytes'), '01020aff');
  assert.equal(Buffer.from(n.props.find((p) => p.name === 'path').raw).toString(), '/node@1000\0');
  assert.equal(hex('self'), '00000001');
  assert.equal(hex('phandle'), '00000001');
  assert.equal(Buffer.from(t.root.children.find((c) => c.name === '__symbols__').props[0].raw).toString(), '/node@1000\0');
});
test('compile: refuses with the line: unknown macro, overlay reference to an outside label, a .dtsi with no root, a syntax error', () => {
  assert.throws(() => M.compile(M.fromDts(fs.readFileSync(path.join(FIX, 'exprs.dts'), 'utf8'))), (e) => e instanceof M.CompileError && e.line === 19 && /SOME_HEADER_MACRO/.test(e.message));
  assert.throws(() => M.compile(M.fromDts(fs.readFileSync(path.join(FIX, 'plugin-overlay.dts'), 'utf8'))), /no root node/);
  assert.throws(() => M.compile(M.fromDts('/dts-v1/;\n/ { };\n&nolabel { x; };\n')), (e) => e.line === 3 && /&nolabel refers to a label that is not defined/.test(e.message));
  assert.throws(() => M.compile(M.fromDts('/ { a = <&missing>; };')), /&missing points to no node/);
  assert.throws(() => M.compile(M.fromDtb(SAMPLE_DTB)), /Only a DTS source/);
});

// ---------- DTB model ----------
test('dtb model: labels from __symbols__, phandle cells resolved by property kind, strings and cells told apart', () => {
  const doc = M.fromDtb(SAMPLE_DTB);
  const gpio = byPath(doc, '/soc/gpio@10000');
  assert.deepEqual(gpio.labels, ['gpio0']);
  assert.equal(doc.labels.get('uart0').path, '/soc/serial@20000');
  const led = byPath(doc, '/leds/led-error');
  assert.equal(M.valueText(M.prop(led, 'gpios')), '<&gpio0 0x6 0x1>');
  assert.equal(M.cellsOf(M.prop(led, 'gpios'))[0].target, gpio);
  assert.equal(M.valueText(M.prop(doc.root, 'interrupt-parent')), '<&gic>');
  assert.equal(M.valueText(M.prop(doc.root, 'compatible')), '"zovo,demo-board", "zovo,demo-soc"');
  assert.equal(M.valueText(M.prop(byPath(doc, '/soc'), 'ranges')), '<0x0 0x40000000 0x10000000>');
  assert.equal(M.valueText(M.prop(gpio, 'gpio-line-names')), '"", "", "", "", "BUTTON", "LED_STATUS", "LED_ERROR"');
  assert.deepEqual(M.decodeRaw('reg', Buffer.from('616263006162', 'hex')).map((c) => c.t), ['bytes']);
  assert.deepEqual(M.decodeRaw('reg', Buffer.from('61626300', 'hex')).map((c) => c.t), ['cells']);
  assert.deepEqual(M.decodeRaw('status', Buffer.from('6f6b617900', 'hex')), [{ t: 'str', v: 'okay' }]);
  assert.deepEqual(M.decodeRaw('x', Buffer.alloc(0)), []);
});
test('reg and interrupts: decoded with the parent cell sizes and the interrupt parent', () => {
  const doc = M.fromDtb(SAMPLE_DTB);
  const gic = byPath(doc, '/soc/interrupt-controller@1000');
  assert.deepEqual(M.regOf(gic).entries, [{ address: 0x1000n, size: 0x1000n }, { address: 0x2000n, size: 0x2000n }]);
  assert.deepEqual(M.regOf(byPath(doc, '/soc/i2c@21000/eeprom@50')), { ac: 1, sc: 0, entries: [{ address: 0x50n, size: null }] });
  const uart = M.interruptsOf(doc, byPath(doc, '/soc/serial@20000'));
  assert.equal(uart.length, 1);
  assert.equal(uart[0].parent, gic);
  assert.deepEqual(uart[0].cells, [0n, 32n, 4n]);
  const tmp = M.interruptsOf(doc, byPath(doc, '/soc/i2c@21000/temperature-sensor@48'));
  assert.equal(tmp[0].parent.path, '/soc/gpio@10000');
  assert.deepEqual(tmp[0].cells, [4n, 2n]);
  assert.equal(M.enabled(byPath(doc, '/soc/spi@22000')), false);
  assert.equal(M.statusOf(byPath(doc, '/soc/serial@20000')), 'okay');
});
test('DTS text of a DTB compiles back to the same tree (round trip), with labels and &references', () => {
  const doc = M.fromDtb(SAMPLE_DTB);
  const { text, lineOf } = M.toDts(doc);
  assert.match(text, /^\/dts-v1\/;\n\n\/memreserve\/ 0x80000000 0x10000;\n/);
  assert.match(text, /\t\tgpio0: gpio@10000 \{\n/);
  assert.match(text, /gpios = <&gpio0 0x5 0x0>;/);
  assert.equal(text.split('\n')[lineOf.get(byPath(doc, '/soc/gpio@10000')) - 1].trim(), 'gpio0: gpio@10000 {');
  const back = F.read(M.compile(M.fromDts(text)));
  assert.deepEqual(flat(back), flat(F.read(SAMPLE_DTB)));
});
test('JSON and YAML exports hold the tree with typed values', () => {
  const doc = M.fromDtb(SAMPLE_DTB);
  const j = JSON.parse(M.toJson(doc));
  assert.equal(j.format, 'dtb');
  assert.equal(j.root.properties.model, 'Zovo Demo Board');
  assert.deepEqual(j.root.properties.compatible, ['zovo,demo-board', 'zovo,demo-soc']);
  const soc = j.root.children.find((c) => c.name === 'soc');
  const gpio = soc.children.find((c) => c.name === 'gpio@10000');
  assert.deepEqual(gpio.labels, ['gpio0']);
  assert.deepEqual(gpio.properties.reg, [0x10000, 0x100]);
  assert.equal(gpio.properties['gpio-controller'], true);
  const led = j.root.children.find((c) => c.name === 'leds').children[0];
  assert.deepEqual(led.properties.gpios, ['&gpio0', 5, 0]);
  assert.deepEqual(j.memreserve, [{ address: '0x80000000', size: '0x10000' }]);
  const y = M.toYaml(doc);
  assert.match(y, /^format: dtb\nroot:\n {2}name: \/\n/);
  assert.match(y, /\n {4}model: "Zovo Demo Board"\n/);
  assert.match(y, /compatible: \["zovo,demo-board", "zovo,demo-soc"\]/);
  assert.match(y, /gpios: \["&gpio0", 5, 0\]/);
  assert.match(y, /- name: gpio@10000\n\s+path: \/soc\/gpio@10000\n\s+labels: \[gpio0\]/);
});

// ---------- diff ----------
test('diff: a changed property, a removed node and an added node; phandle renumbering is not a change', () => {
  const a = M.fromDts(SAMPLE_DTS);
  const bSrc = SAMPLE_DTS.replace('timeout-sec = <30>;', 'timeout-sec = <60>;').replace(/\n\t\t\teeprom@50 \{[\s\S]*?\n\t\t\t\};\n/, '\n').replace('\tleds {', '\tbuzzer {\n\t\tcompatible = "pwm-beeper";\n\t};\n\n\tleds {');
  const b = M.fromDtb(M.compile(M.fromDts(bSrc)));
  const r = D.diff(a, b);
  assert.deepEqual(r.onlyA, ['/soc/i2c@21000/eeprom@50']);
  assert.deepEqual(r.onlyB, ['/buzzer']);
  assert.deepEqual(r.changed.map((c) => [c.path, c.props.map((p) => `${p.name}:${p.kind}:${p.a}->${p.b}`)]), [['/soc/watchdog@23000', ['timeout-sec:changed:<0x1e>-><0x3c>']]]);
  // the DTS (with macros) against its own compiled DTB: GPIO flags written as macros differ as text, nothing else
  const self = D.diff(M.fromDts(SAMPLE_DTS), M.fromDtb(SAMPLE_DTB));
  assert.deepEqual(self.onlyA, []);
  assert.deepEqual(self.onlyB, []);
  const md = D.toMarkdown(r, 'a.dts', 'b.dtb');
  assert.match(md, /^# Device tree comparison\n\n- A: a\.dts\n- B: b\.dtb\n\n1 node only in A, 1 only in B, 1 node with 1 property change/);
  assert.match(md, /\| timeout-sec \| changed \| `<0x1e>` \| `<0x3c>` \|/);
  const html = D.toHtml(r, 'a<b', 'c');
  assert.match(html, /A: a&lt;b/);
  assert.match(html, /<tr class="changed"><td>\/soc\/watchdog@23000<\/td><td>timeout-sec<\/td>/);
});

// ---------- address and pin map ----------
test('address map: CPU addresses through ranges, bus addresses, interrupts, GPIOs, pinctrl; the GPIO used twice is flagged', () => {
  const m = A.build(M.fromDtb(SAMPLE_DTB));
  const row = (kind, node) => m.rows.filter((r) => r.kind === kind && r.node === node);
  assert.deepEqual(row('reg', '/soc/serial@20000').map((r) => [r.start, r.end, r.size]), [['0x40020000', '0x400200ff', '0x100']]);
  assert.match(row('reg', '/soc/serial@20000')[0].detail, /bus address 0x20000 on \/soc/);
  assert.equal(row('reg', '/memory@80000000')[0].start, '0x80000000');
  assert.equal(row('reserved', '/reserved-memory/dsp@9f000000')[0].start, '0x9f000000');
  assert.equal(row('bus', '/soc/i2c@21000/eeprom@50')[0].start, '0x50');
  assert.equal(m.rows.filter((r) => r.node.startsWith('/cpus')).length, 0);
  assert.equal(row('interrupt', '/soc/serial@20000')[0].controller, '&gic');
  assert.equal(row('interrupt', '/soc/serial@20000')[0].detail, '<0x0 0x20 0x4>');
  assert.deepEqual(m.rows.filter((r) => r.kind === 'gpio').map((r) => [r.node, r.start, r.flags ? 'flag' : '']), [['/leds/led-status', '5', 'flag'], ['/leds/led-error', '6', ''], ['/regulator-fan', '5', 'flag']]);
  assert.equal(m.gpioDup, 1);
  assert.equal(m.overlaps, 0);
  assert.match(row('pinctrl', '/soc/serial@20000')[0].detail, /^default: pins = "PA0", "PA1"/);
  const csv = A.toCsv(m).split('\n');
  assert.equal(csv[0], 'kind,node,label,compatible,status,start,end,size,controller,detail,flags');
  assert.ok(csv.includes('gpio,/regulator-fan,fan_reg,regulator-fixed,okay,5,,,&gpio0,gpio <&gpio0 0x5 0x0>,pin also used by /leds/led-status (gpios)'));
});
test('address map: overlapping ranges and a doubled I2C address are flagged; disabled nodes and parent/child pairs are not', () => {
  const src = SAMPLE_DTS.replace('reg = <0x23000 0x40>;', 'reg = <0x22300 0x200>;').replace('reg = <0x50>;', 'reg = <0x48>;');
  const m = A.build(M.fromDts(src));
  const wd = m.rows.find((r) => r.node === '/soc/watchdog@23000' && r.kind === 'reg');
  assert.equal(wd.flags, ''); // spi@22000 is disabled
  const src2 = src.replace('status = "disabled";', 'status = "okay";');
  const m2 = A.build(M.fromDts(src2));
  assert.equal(m2.rows.find((r) => r.node === '/soc/watchdog@23000' && r.kind === 'reg').flags, 'overlaps /soc/spi@22000');
  assert.equal(m2.overlaps, 1);
  assert.equal(m2.busDup, 1);
  assert.match(m2.rows.find((r) => r.node === '/soc/i2c@21000/eeprom@50').flags, /same address as \/soc\/i2c@21000\/temperature-sensor@48/);
});

// ---------- view model ----------
test('view model: one row per node in tree order, values with clickable references, facts of the file', () => {
  const doc = M.fromDtb(SAMPLE_DTB);
  const t = M.toDts(doc);
  const vm = V.build(doc, { lineOf: t.lineOf });
  assert.equal(vm.nodes.length, doc.all.length);
  assert.equal(vm.nodes[0].name, '/');
  const led = vm.nodes.find((n) => n.path === '/leds/led-status');
  const gp = led.props.find((p) => p.name === 'gpios');
  const ref = gp.parts.find((x) => x[1] >= 0);
  assert.equal(ref[0], '&gpio0');
  assert.equal(vm.nodes[ref[1]].path, '/soc/gpio@10000');
  const uart = vm.nodes.find((n) => n.path === '/soc/serial@20000');
  assert.deepEqual(uart.reg, [{ address: '0x20000', size: '0x100', end: '0x200ff' }]);
  assert.equal(uart.irqs[0].ctl, '&gic');
  assert.equal(uart.status, 'okay');
  const f = Object.fromEntries(vm.facts.map((x) => [x.k, x.v]));
  assert.equal(f.Model, 'Zovo Demo Board');
  assert.match(f.Format, /^DTB, version 17, last compatible version 16$/);
  assert.equal(f['Memory reservations'], '0x80000000 size 0x10000');
  assert.equal(f['Boot CPU'], '0x0');
  assert.equal(f.Nodes, String(doc.all.length));
  const dv = V.build(M.fromDts(fs.readFileSync(path.join(FIX, 'zephyr-led-strip-esp32c3.overlay'), 'utf8')));
  const df = Object.fromEntries(dv.facts.map((x) => [x.k, x.v]));
  assert.equal(df.Includes, '<zephyr/dt-bindings/led/led.h> (line 7)');
  assert.match(df['Changes to nodes defined elsewhere'], /^2 /);
});

// ---------- real files (when present) ----------
test('real Raspberry Pi DTBs and DTBOs: read, labels, round trip through DTS, overlay fragments resolved by __fixups__', { skip: !hasReal && 'DT_REAL_DIR not present' }, () => {
  for (const f of ['rpi-fw-4b/bcm2711-rpi-4-b.dtb', 'rpi-fw-cm4/bcm2711-rpi-cm4.dtb', 'rpi-fw-3b/bcm2710-rpi-3-b.dtb', 'rpi-fw-ov-i2crtc/i2c-rtc.dtbo', 'rpi-fw-ov-disablebt/disable-bt.dtbo']) {
    const b = fs.readFileSync(real(f));
    const doc = M.fromDtb(b);
    const back = F.read(M.compile(M.fromDts(M.toDts(doc).text)));
    assert.deepEqual(flat(back), flat(F.read(b)), f);
  }
  const rpi = M.fromDtb(fs.readFileSync(real('rpi-fw-4b/bcm2711-rpi-4-b.dtb')));
  assert.equal(M.strProp(rpi.root, 'model')[0], 'Raspberry Pi 4 Model B');
  assert.equal(rpi.labels.get('gpio').path, '/soc/gpio@7e200000');
  const m = A.build(rpi);
  assert.equal(m.rows.find((r) => r.kind === 'reg' && r.node === '/soc/gpio@7e200000').start, '0xfe200000');
  const ov = M.fromDtb(fs.readFileSync(real('rpi-fw-ov-disablebt/disable-bt.dtbo')));
  assert.equal(ov.overlay, true);
  const tgt = M.cellsOf(M.prop(ov.root.children.find((c) => c.name === 'fragment@0'), 'target'))[0];
  assert.ok(tgt.ref && tgt.unresolved, JSON.stringify(tgt.ref));
  const diff = D.diff(rpi, M.fromDtb(fs.readFileSync(real('rpi-fw-cm4/bcm2711-rpi-cm4.dtb'))));
  assert.ok(diff.onlyA.length > 0 && diff.onlyB.length > 0 && diff.propChanges > 0);
});
test('real kernel and Zephyr DTS files parse with no error (includes listed, &label blocks kept)', { skip: !hasReal && 'DT_REAL_DIR not present' }, () => {
  for (const f of ['linux-rpi4-dts/bcm2711-rpi-4-b.dts', 'linux-boneblack-dts/am335x-boneblack.dts', 'linux-bone-common-dtsi/am335x-bone-common.dtsi', 'zephyr-nrf52840dk-dts/nrf52840dk_nrf52840.dts']) {
    const doc = M.fromDts(fs.readFileSync(real(f), 'utf8'));
    assert.deepEqual(doc.errors, [], f);
    assert.ok(doc.includes.length >= 1, f);
    assert.ok(doc.orphans.length >= 1, f);
  }
});
