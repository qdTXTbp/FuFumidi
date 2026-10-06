// 参数化 MIDI 工具（M2）：一张声明式注册表 —— 界面、行为、预设三样都从这里长出来。
//
// ★ 为什么要有它：编辑页原本 67 个动作，每个都是「一个按钮 + 一段写死的逻辑」。
//   于是「移调 +3，再力度 ×0.8」要点两次、撤销两次，也没法存成预设。
//   这里把「对一组音符做一次参数化变换」抽象成 apply(notes, params, ctx)，
//   界面（滑杆 / 下拉 / 开关）由 params 表自动生成，实时预览由预览层负责，
//   预设只是 params 的一份快照。
//
// 三条约定：
// 1) apply 直接改传进来的 note 对象。预览层每次都从**基线**重算，所以实现里可以放心写 +=。
// 2) 需要随机性的工具一律从 params.seed 派生 PRNG —— 否则拖动别的滑杆时结果会乱跳。
// 3) apply 返回改动条数（0 = 当前参数下是恒等变换，界面据此提示「无变化」）。

export const TOOL_GROUPS = ['音高', '力度', '时值', '节奏', '生成'];

function ci(v, a, b) { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(a, Math.min(b, n)) : a; }
function cf(v, a, b) { const n = Number(v); return Number.isFinite(n) ? Math.max(a, Math.min(b, n)) : a; }

/** 确定性 PRNG：同一个 seed 每次预览结果一致（拖动参数时不会乱跳） */
export function mulberry32(seed) {
  let a = (Math.round(Number(seed)) || 0) >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 调内音级（pitch class 0..11）；ctx 没给音阶时返回 null = 不约束 */
function pcsOf(ctx) {
  const pcs = ctx && ctx.scalePcs;
  return (Array.isArray(pcs) && pcs.length) ? pcs : null;
}
function inScale(midi, pcs) { return pcs.includes(((midi % 12) + 12) % 12); }
/** 就近吸附到调内音（先找同音、再上下各扩半音） */
function snapPc(midi, pcs) {
  if (!pcs || inScale(midi, pcs)) return midi;
  for (let d = 1; d <= 6; d++) {
    const up = midi + d, dn = midi - d;
    if (up <= 127 && inScale(up, pcs)) return up;
    if (dn >= 0 && inScale(dn, pcs)) return dn;
  }
  return midi;
}
function order(notes) { return [...notes].sort((a, b) => a.start - b.start || a.midi - b.midi); }

const GRIDS = [['1/4', 1], ['1/8', 0.5], ['1/8T', 1 / 3], ['1/16', 0.25], ['1/16T', 1 / 6], ['1/32', 0.125]];
const GRID_OPTS = GRIDS.map(([k]) => [k, k]);
function gridTicks(key, tpb) { const hit = GRIDS.find(([k]) => k === key); return Math.max(1, Math.round((hit ? hit[1] : 0.25) * tpb)); }

export const MIDI_TOOLS = [
  /* ---------------- 音高 ---------------- */
  {
    id: 'transpose', name: '移调', group: '音高', hint: '按半音整体移动（越界会被夹在 0..127）',
    params: [{ k: 'semitones', label: '半音', type: 'int', min: -24, max: 24, step: 1, def: 0 }],
    apply(notes, p) {
      const d = ci(p.semitones, -24, 24);
      if (!d) return 0;
      let n = 0;
      for (const x of notes) { const m = Math.max(0, Math.min(127, x.midi + d)); if (m !== x.midi) { x.midi = m; n++; } }
      return n;
    },
  },
  {
    id: 'scaleSnap', name: '吸附到调内音', group: '音高', hint: '把调外音拉到最近的音阶音（需先在「音阶」里设定调）',
    params: [{ k: 'dir', label: '方向', type: 'enum', def: 'nearest', options: [['nearest', '就近'], ['up', '向上'], ['down', '向下']] }],
    apply(notes, p, ctx) {
      const pcs = pcsOf(ctx); if (!pcs) return 0;
      let n = 0;
      for (const x of notes) {
        if (inScale(x.midi, pcs)) continue;
        let m = snapPc(x.midi, pcs);
        if (p.dir === 'up') { m = x.midi; while (m <= 127 && !inScale(m, pcs)) m++; if (m > 127) m = snapPc(x.midi, pcs); }
        else if (p.dir === 'down') { m = x.midi; while (m >= 0 && !inScale(m, pcs)) m--; if (m < 0) m = snapPc(x.midi, pcs); }
        if (m !== x.midi) { x.midi = m; n++; }
      }
      return n;
    },
  },
  {
    id: 'mirror', name: '镜像', group: '音高', hint: '围绕轴音上下翻转',
    params: [{ k: 'axis', label: '轴音', type: 'int', min: 0, max: 127, step: 1, def: 60 }],
    apply(notes, p) {
      const ax = ci(p.axis, 0, 127); let n = 0;
      for (const x of notes) { const m = Math.max(0, Math.min(127, ax * 2 - x.midi)); if (m !== x.midi) { x.midi = m; n++; } }
      return n;
    },
  },
  {
    id: 'randomWalk', name: '随机游走', group: '音高', hint: '每个音在 ±范围 内随机移动（固定种子，可复现）',
    params: [
      { k: 'range', label: '范围', type: 'int', min: 1, max: 12, step: 1, def: 2 },
      { k: 'seed', label: '种子', type: 'int', min: 0, max: 9999, step: 1, def: 7, dice: true },
      { k: 'scaleOnly', label: '只用调内音', type: 'bool', def: true },
    ],
    apply(notes, p, ctx) {
      const rnd = mulberry32(p.seed); const r = ci(p.range, 1, 12); const pcs = p.scaleOnly ? pcsOf(ctx) : null;
      let n = 0;
      for (const x of notes) {
        const d = Math.round((rnd() * 2 - 1) * r);
        let m = Math.max(0, Math.min(127, x.midi + d));
        if (pcs) m = snapPc(m, pcs);
        if (m !== x.midi) { x.midi = m; n++; }
      }
      return n;
    },
  },
  /* ---------------- 力度 ---------------- */
  {
    id: 'velOffset', name: '力度偏移', group: '力度', hint: '整体加减力度',
    params: [{ k: 'amount', label: '增减', type: 'int', min: -63, max: 63, step: 1, def: 0 }],
    apply(notes, p) {
      const d = ci(p.amount, -63, 63); if (!d) return 0;
      let n = 0;
      for (const x of notes) { const v = Math.max(1, Math.min(127, x.vel + d)); if (v !== x.vel) { x.vel = v; n++; } }
      return n;
    },
  },
  {
    id: 'velScale', name: '力度缩放', group: '力度', hint: '按比例放大/缩小动态',
    params: [{ k: 'factor', label: '倍数', type: 'float', min: 0.1, max: 3, step: 0.05, def: 1 }],
    apply(notes, p) {
      const f = cf(p.factor, 0.1, 3); if (Math.abs(f - 1) < 1e-6) return 0;
      let n = 0;
      for (const x of notes) { const v = Math.max(1, Math.min(127, Math.round(x.vel * f))); if (v !== x.vel) { x.vel = v; n++; } }
      return n;
    },
  },
  {
    id: 'velFixed', name: '固定力度', group: '力度', hint: '全部改成同一个力度',
    params: [{ k: 'value', label: '力度', type: 'int', min: 1, max: 127, step: 1, def: 80 }],
    apply(notes, p) {
      const v = ci(p.value, 1, 127); let n = 0;
      for (const x of notes) if (x.vel !== v) { x.vel = v; n++; }
      return n;
    },
  },
  {
    id: 'velCompress', name: '力度压缩', group: '力度', hint: '把动态往中心值收（强度 100% = 全部等于中心值）',
    params: [
      { k: 'center', label: '中心', type: 'int', min: 1, max: 127, step: 1, def: 80 },
      { k: 'strength', label: '强度', type: 'int', min: 0, max: 100, step: 1, def: 60, unit: '%' },
    ],
    apply(notes, p) {
      const c = ci(p.center, 1, 127), s = ci(p.strength, 0, 100) / 100; if (!s) return 0;
      let n = 0;
      for (const x of notes) { const v = Math.max(1, Math.min(127, Math.round(x.vel + (c - x.vel) * s))); if (v !== x.vel) { x.vel = v; n++; } }
      return n;
    },
  },
  {
    id: 'velHumanize', name: '力度人性化', group: '力度', hint: '在 ±量 内随机微扰力度（固定种子）',
    params: [
      { k: 'amount', label: '幅度', type: 'int', min: 1, max: 40, step: 1, def: 8 },
      { k: 'seed', label: '种子', type: 'int', min: 0, max: 9999, step: 1, def: 11, dice: true },
    ],
    apply(notes, p) {
      const rnd = mulberry32(p.seed), a = ci(p.amount, 1, 40); let n = 0;
      for (const x of notes) { const v = Math.max(1, Math.min(127, Math.round(x.vel + (rnd() * 2 - 1) * a))); if (v !== x.vel) { x.vel = v; n++; } }
      return n;
    },
  },
  /* ---------------- 时值 ---------------- */
  {
    id: 'lenScale', name: '时值缩放', group: '时值', hint: '起点不动，长度按比例缩放',
    params: [{ k: 'factor', label: '倍数', type: 'float', min: 0.1, max: 4, step: 0.05, def: 1 }],
    apply(notes, p) {
      const f = cf(p.factor, 0.1, 4); if (Math.abs(f - 1) < 1e-6) return 0;
      let n = 0;
      for (const x of notes) { const len = Math.max(1, Math.round((x.end - x.start) * f)); if (x.end !== x.start + len) { x.end = x.start + len; n++; } }
      return n;
    },
  },
  {
    id: 'lenOffset', name: '时值增减', group: '时值', hint: '按拍加减长度（可为负，最短 1 tick）',
    params: [{ k: 'beats', label: '拍', type: 'float', min: -4, max: 4, step: 0.125, def: 0 }],
    apply(notes, p, ctx) {
      const tpb = (ctx && ctx.tpb) || 480; const d = Math.round(cf(p.beats, -4, 4) * tpb); if (!d) return 0;
      let n = 0;
      for (const x of notes) { const e = Math.max(x.start + 1, x.end + d); if (e !== x.end) { x.end = e; n++; } }
      return n;
    },
  },
  {
    id: 'legato', name: '连奏化', group: '时值', hint: '把长度拉到下一个音的起点（同轨内）',
    params: [{ k: 'amount', label: '程度', type: 'int', min: 0, max: 100, step: 1, def: 100, unit: '%' }],
    apply(notes, p, ctx) {
      const tr = ctx && ctx.track; if (!tr) return 0;
      const amt = ci(p.amount, 0, 100) / 100; if (!amt) return 0;
      const all = [...tr.notes].sort((a, b) => a.start - b.start);
      let n = 0;
      for (const x of notes) {
        let next = Infinity;
        for (const o of all) if (o !== x && o.start > x.start) { next = o.start; break; }
        if (!Number.isFinite(next)) continue;
        const target = Math.max(x.start + 1, Math.round(x.end + (next - x.end) * amt));
        if (target !== x.end) { x.end = target; n++; }
      }
      return n;
    },
  },
  {
    id: 'staccato', name: '断奏', group: '时值', hint: '把长度缩到原长的百分比',
    params: [{ k: 'ratio', label: '保留', type: 'int', min: 10, max: 100, step: 5, def: 50, unit: '%' }],
    apply(notes, p) {
      const r = ci(p.ratio, 10, 100) / 100; let n = 0;
      for (const x of notes) { const len = Math.max(1, Math.round((x.end - x.start) * r)); if (x.end !== x.start + len) { x.end = x.start + len; n++; } }
      return n;
    },
  },
  /* ---------------- 节奏 ---------------- */
  {
    id: 'quantize', name: '量化', group: '节奏', hint: '起点吸附到网格，强度决定吸附多少',
    params: [
      { k: 'grid', label: '网格', type: 'enum', def: '1/16', options: GRID_OPTS },
      { k: 'strength', label: '强度', type: 'int', min: 0, max: 100, step: 1, def: 100, unit: '%' },
    ],
    apply(notes, p, ctx) {
      const tpb = (ctx && ctx.tpb) || 480; const g = gridTicks(p.grid, tpb); const s = ci(p.strength, 0, 100) / 100;
      if (!s) return 0;
      let n = 0;
      for (const x of notes) {
        const q = Math.round(x.start / g) * g;
        const ns = Math.max(0, Math.round(x.start + (q - x.start) * s));
        if (ns !== x.start) { const len = x.end - x.start; x.start = ns; x.end = ns + len; n++; }
      }
      return n;
    },
  },
  {
    id: 'swing', name: '摇摆', group: '节奏', hint: '把网格上的后半拍往后推（三连感）',
    params: [
      { k: 'grid', label: '网格', type: 'enum', def: '1/8', options: [['1/8', '1/8'], ['1/16', '1/16']] },
      { k: 'amount', label: '幅度', type: 'int', min: 0, max: 100, step: 1, def: 33, unit: '%' },
    ],
    apply(notes, p, ctx) {
      const tpb = (ctx && ctx.tpb) || 480; const g = gridTicks(p.grid, tpb); const a = ci(p.amount, 0, 100) / 100;
      if (!a) return 0;
      let n = 0;
      for (const x of notes) {
        const half = Math.round(x.start / (g / 2));
        if (half % 2 === 0) continue;                       // 只动后半拍
        const ns = Math.max(0, Math.round(x.start + a * (g / 2) * 0.5));
        if (ns !== x.start) { const len = x.end - x.start; x.start = ns; x.end = ns + len; n++; }
      }
      return n;
    },
  },
  {
    id: 'strum', name: '扫弦', group: '节奏', hint: '按起点顺序把音依次错开（做吉他扫弦感）',
    params: [
      { k: 'step', label: '间隔', type: 'int', min: -120, max: 120, step: 5, def: 20, unit: 'tick' },
      { k: 'fromTop', label: '从高音开始', type: 'bool', def: false },
    ],
    apply(notes, p) {
      const step = ci(p.step, -120, 120); if (!step) return 0;
      const arr = p.fromTop ? [...notes].sort((a, b) => a.start - b.start || b.midi - a.midi) : order(notes);
      let n = 0;
      arr.forEach((x, i) => {
        const ns = Math.max(0, x.start + i * step);
        if (ns !== x.start) { const len = x.end - x.start; x.start = ns; x.end = ns + len; n++; }
      });
      return n;
    },
  },
  {
    id: 'arp', name: '琶音', group: '生成', hint: '把同时发声的音符摊成一条琶音线',
    params: [
      { k: 'rate', label: '速率', type: 'enum', def: '1/8', options: GRID_OPTS },
      { k: 'dir', label: '方向', type: 'enum', def: 'up', options: [['up', '上行'], ['down', '下行'], ['updown', '上下行']] },
    ],
    apply(notes, p, ctx) {
      const tpb = (ctx && ctx.tpb) || 480; const g = gridTicks(p.rate, tpb);
      const arr = order(notes); if (arr.length < 2) return 0;
      let n = 0, i = 0;
      while (i < arr.length) {
        let j = i; while (j + 1 < arr.length && Math.abs(arr[j + 1].start - arr[i].start) <= 1) j++;
        const grp = arr.slice(i, j + 1);
        const byPitch = [...grp].sort((a, b) => p.dir === 'down' ? b.midi - a.midi : a.midi - b.midi);
        const seq = p.dir === 'updown' && byPitch.length > 2 ? byPitch.concat([...byPitch].reverse().slice(1, -1)) : byPitch;
        const base = arr[i].start;
        seq.forEach((x, k) => {
          const ns = Math.max(0, Math.round(base + k * g));
          if (ns !== x.start) { x.start = ns; n++; }
          x.end = Math.max(x.start + 1, Math.round(ns + g));
        });
        i = j + 1;
      }
      return n;
    },
  },
  /* ---------------- 生成 / 清理 ---------------- */
  {
    id: 'thin', name: '稀疏化', group: '生成', hint: '随机静音一部分音符（不改力度、不删除，可撤销）',
    params: [
      { k: 'keep', label: '保留', type: 'int', min: 0, max: 100, step: 5, def: 70, unit: '%' },
      { k: 'seed', label: '种子', type: 'int', min: 0, max: 9999, step: 1, def: 3, dice: true },
    ],
    apply(notes, p) {
      const rnd = mulberry32(p.seed); const keep = ci(p.keep, 0, 100) / 100; let n = 0;
      for (const x of notes) { if (rnd() > keep) { if (!x.muted) { x.muted = true; n++; } } }
      return n;
    },
  },
];

export function toolById(id) { return MIDI_TOOLS.find((x) => x.id === id) || null; }
export function toolsOfGroup(g) { return MIDI_TOOLS.filter((x) => x.group === g); }
export function defaultParams(tool) {
  const out = {};
  if (!tool) return out;
  for (const p of tool.params) out[p.k] = p.def;
  return out;
}
/** 参数显示值（滑杆右侧那个数字） */
export function formatParam(p, v) {
  if (p.type === 'bool') return v ? '开' : '关';
  if (p.type === 'enum') { const hit = (p.options || []).find((o) => o[0] === v); return hit ? hit[1] : String(v); }
  const n = p.type === 'float' ? Math.round(Number(v) * 100) / 100 : Math.round(Number(v));
  return (p.min != null && p.min < 0 && n > 0 ? '+' : '') + n + (p.unit ? ' ' + p.unit : '');
}
/** 预设：localStorage 里按工具 id 存一份参数快照 */
const PRESET_KEY = 'fufumidi.miditools.presets.v1';
export function loadPresets() {
  try { const j = JSON.parse(localStorage.getItem(PRESET_KEY) || '{}'); return (j && typeof j === 'object') ? j : {}; } catch (e) { return {}; }
}
export function savePreset(toolId, name, params) {
  const all = loadPresets();
  const arr = all[toolId] = Array.isArray(all[toolId]) ? all[toolId] : [];
  const i = arr.findIndex((x) => x.name === name);
  const rec = { name, params: { ...params } };
  if (i >= 0) arr[i] = rec; else arr.push(rec);
  try { localStorage.setItem(PRESET_KEY, JSON.stringify(all)); } catch (e) {}
  return arr;
}
export function deletePreset(toolId, name) {
  const all = loadPresets();
  const arr = Array.isArray(all[toolId]) ? all[toolId] : [];
  all[toolId] = arr.filter((x) => x.name !== name);
  try { localStorage.setItem(PRESET_KEY, JSON.stringify(all)); } catch (e) {}
  return all[toolId];
}
