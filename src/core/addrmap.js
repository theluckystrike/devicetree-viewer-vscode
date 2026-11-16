'use strict';
// Address and pin map (Zovo Pro tool): every reg range (translated to a CPU address through the parents' ranges),
// bus address, interrupt, GPIO and pinctrl entry of a device tree in one table. Flags overlapping address ranges and
// duplicate bus addresses between enabled nodes, and GPIO pins used by more than one enabled node or property.
const M = require('./model');

const join = (cells) => cells.reduce((a, c) => (a << 32n) | c, 0n);

/** CPU address of a bus address of node (through the ranges of every parent bus), or null when not mapped. */
function translate(node, addr) {
  let bus = node.parent;
  let a = addr;
  while (bus && bus.parent) {
    const r = M.prop(bus, 'ranges');
    if (!r) return null;
    if (r.val.length) {
      const c = M.numCells(r);
      if (!c) return null;
      const ca = M.addrCells(bus), pa = M.addrCells(bus.parent), cs = M.sizeCells(bus);
      const step = ca + pa + cs;
      if (!step || c.length % step) return null;
      let hit = false;
      for (let i = 0; i < c.length; i += step) {
        const child = join(c.slice(i, i + ca)), parent = join(c.slice(i + ca, i + ca + pa)), size = join(c.slice(i + ca + pa, i + step));
        if (a >= child && a < child + size) { a = parent + (a - child); hit = true; break; }
      }
      if (!hit) return null;
    }
    bus = bus.parent;
  }
  return a;
}

const nameOf = (n) => (n ? (n.labels && n.labels[0] ? `&${n.labels[0]}` : n.path) : '');
const isUnder = (n, name) => { for (let p = n.parent; p; p = p.parent) if (p.parent && !p.parent.parent && p.name.split('@')[0] === name) return true; return false; };

function build(doc) {
  const rows = [];
  const nodes = doc.all.filter((n) => !/^(__symbols__|__fixups__|__local_fixups__)$/.test(n.name) && !(n.parent && /^__/.test(n.parent.name)));
  const base = (n) => ({ node: n.path, label: n.labels.join(' '), compatible: (M.strProp(n, 'compatible') || [])[0] || '', status: M.enabled(n) ? 'okay' : (M.statusOf(n) || 'disabled'), enabled: M.enabled(n), _n: n, flags: [] });
  for (const n of nodes) {
    if (!n.parent) continue;
    const reg = M.regOf(n);
    const p = M.prop(n, 'reg');
    if (p && !reg) { rows.push({ ...base(n), kind: 'reg', start: '', end: '', size: '', controller: '', detail: `reg = ${M.valueText(p)} (not decoded: needs the parent's cell sizes or numbers for macros)` }); continue; }
    if (reg && !isUnder(n, 'cpus')) {
      for (const e of reg.entries) {
        if (reg.sc === 0) { rows.push({ ...base(n), kind: 'bus', start: M.hex(e.address), end: '', size: '', controller: n.parent.path, detail: `address ${M.hex(e.address)} on ${nameOf(n.parent)}`, _bus: n.parent, _addr: e.address }); continue; }
        const cpu = translate(n, e.address);
        const reserved = isUnder(n, 'reserved-memory');
        rows.push({ ...base(n), kind: reserved ? 'reserved' : 'reg', start: M.hex(cpu === null ? e.address : cpu), end: e.size ? M.hex((cpu === null ? e.address : cpu) + e.size - 1n) : '', size: M.hex(e.size), controller: '',
          detail: cpu === null ? `bus address ${M.hex(e.address)} on ${n.parent.path} (no ranges to a CPU address)` : cpu !== e.address ? `bus address ${M.hex(e.address)} on ${n.parent.path}` : '', _start: cpu, _size: e.size });
      }
    }
    for (const it of M.interruptsOf(doc, n) || []) rows.push({ ...base(n), kind: 'interrupt', start: '', end: '', size: '', controller: nameOf(it.parent), detail: `<${it.cells.map((c) => (typeof c === 'bigint' ? M.hex(c) : c)).join(' ')}>` });
    for (const pr of n.props) {
      const spec = M.specOf(pr.name);
      const c = M.cellsOf(pr);
      if (!c) continue;
      if (spec && !spec.plain && spec.cells === '#gpio-cells' && !M.prop(n, 'gpio-hog')) {
        for (let i = 0; i < c.length;) {
          const t = c[i].target;
          if (!t) break;
          const cnt = M.u32Prop(t, '#gpio-cells', 2);
          const args = c.slice(i + 1, i + 1 + cnt);
          const pin = args[0] && args[0].n !== undefined ? Number(args[0].n) : args[0] ? args[0].expr : '';
          rows.push({ ...base(n), kind: 'gpio', start: String(pin), end: '', size: '', controller: nameOf(t), detail: `${pr.name} <${[`&${c[i].ref}`.replace('&{', '&{'), ...args.map((x) => (x.n !== undefined ? M.hex(x.n) : x.expr))].join(' ')}>`, _ctl: t, _pin: pin, _prop: pr.name });
          i += 1 + cnt;
        }
      }
      const m = /^pinctrl-(\d+)$/.exec(pr.name);
      if (m) {
        const names = M.strProp(n, 'pinctrl-names') || [];
        for (const x of c) {
          const t = x.target;
          const pins = t ? ['brcm,pins', 'pins', 'pinmux', 'pinctrl-single,pins', 'groups', 'psels', 'fsl,pins', 'rockchip,pins'].map((k) => M.prop(t, k)).filter(Boolean).map((q) => `${q.name} = ${M.valueText(q)}`).join('; ') : '';
          const sub = t && !pins ? t.children.map((ch) => ['pins', 'pinmux', 'psels', 'groups'].map((k) => M.prop(ch, k)).filter(Boolean).map((q) => `${ch.name}: ${q.name} = ${M.valueText(q)}`).join('; ')).filter(Boolean).join('; ') : '';
          rows.push({ ...base(n), kind: 'pinctrl', start: '', end: '', size: '', controller: t ? nameOf(t) : (x.ref ? `&${x.ref}` : M.hex(x.n || 0n)), detail: `${names[Number(m[1])] || pr.name}${pins || sub ? `: ${(pins || sub).slice(0, 300)}` : ''}` });
        }
      }
    }
  }
  // overlapping CPU address ranges between enabled nodes that are not parent and child
  const regs = rows.filter((r) => r.kind === 'reg' && r.enabled && r._start !== null && r._start !== undefined && r._size > 0n).sort((a, b) => (a._start < b._start ? -1 : a._start > b._start ? 1 : 0));
  const related = (a, b) => a._n === b._n || a.node.startsWith(b.node + '/') || b.node.startsWith(a.node + '/');
  let overlaps = 0;
  for (let i = 0; i < regs.length; i++) {
    for (let j = i + 1; j < regs.length && regs[j]._start < regs[i]._start + regs[i]._size; j++) {
      if (related(regs[i], regs[j])) continue;
      regs[i].flags.push(`overlaps ${regs[j].node}`); regs[j].flags.push(`overlaps ${regs[i].node}`); overlaps++;
    }
  }
  // the same address twice on one bus (I2C, SPI chip select, MDIO)
  let busDup = 0;
  const bus = new Map();
  for (const r of rows.filter((x) => x.kind === 'bus' && x.enabled)) { const k = `${r._bus.path}|${r._addr}`; if (!bus.has(k)) bus.set(k, []); bus.get(k).push(r); }
  for (const list of bus.values()) if (list.length > 1 && new Set(list.map((r) => r._n)).size > 1) { busDup++; for (const r of list) r.flags.push(`same address as ${list.filter((x) => x._n !== r._n).map((x) => x.node).join(', ')}`); }
  // the same GPIO pin used twice
  let gpioDup = 0;
  const gp = new Map();
  for (const r of rows.filter((x) => x.kind === 'gpio' && x.enabled && typeof x._pin === 'number')) { const k = `${r._ctl.path}|${r._pin}`; if (!gp.has(k)) gp.set(k, []); gp.get(k).push(r); }
  for (const list of gp.values()) if (list.length > 1) { gpioDup++; for (const r of list) r.flags.push(`pin also used by ${list.filter((x) => x !== r).map((x) => `${x.node} (${x._prop})`).join(', ')}`); }
  const clean = rows.map((r) => ({ kind: r.kind, node: r.node, label: r.label, compatible: r.compatible, status: r.status, start: r.start, end: r.end, size: r.size, controller: r.controller, detail: r.detail, flags: r.flags.join('; ') }));
  const count = (k) => clean.filter((r) => r.kind === k).length;
  return { rows: clean, overlaps, busDup, gpioDup, counts: { reg: count('reg'), reserved: count('reserved'), bus: count('bus'), interrupt: count('interrupt'), gpio: count('gpio'), pinctrl: count('pinctrl') } };
}

const COLS = ['kind', 'node', 'label', 'compatible', 'status', 'start', 'end', 'size', 'controller', 'detail', 'flags'];
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function toCsv(map) { return [COLS.join(','), ...map.rows.map((r) => COLS.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n'; }

module.exports = { build, toCsv, translate, COLS };
