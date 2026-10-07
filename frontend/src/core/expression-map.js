// 表达映射（M5b 顺延项，计划书 §3.7）：技法除了 Key Switch 键位，还能带 **PC / CC / 力度系数**。
//
// ## 现状与缺口
// 技法在 MIDI 里就是低音区（C-2 ~ C0）的一个 Key Switch 音符，名字由 ksMap 决定
// （core/articulations.js 的三套内置库）。但**只有名字**：真实的音源（Spitfire / EastWest / VSL）
// 除了键位还要收 PC 或 CC（Spitfire UACC 用 CC32 = 技法号；EastWest 用 CC1/CC11 等），
// 于是"选了技法却不出正确奏法"。这里给每个 KS 键位补上动作，并统一展开成 MIDI 事件。
//
// ## 动作模型（按 **KS 键位** 存，不按名字 —— 改名不该把动作弄丢）
//   { [midi 0..24]: { pc?: number, cc?: { n, v }, vel?: number(0.1~2), ch?: number } }
//   - pc  : 技法切换时发 Program Change
//   - cc  : 技法切换时发一条 CC（号 + 值）
//   - vel : 力度系数，作用于**这次切换到下一次切换之间**的音符（0.1 ~ 2）
//   - ch  : 动作走哪条通道（不填 = 跟音符自己的通道）
// 动作文件可导出 / 导入（JSON），随工程不带正合适 —— 它描述的是"音源怎么用"，不是音乐内容。
export const EXPR_LS = 'fufumidi.expression-map.v1';

/** 内置动作预设：覆盖三家最常见的做法（键位名由 articulations.js 那三套库给） */
export const EXPR_PRESETS = [
  {
    id: 'spitfire-uacc', name: 'Spitfire UACC',
    // UACC：CC32 = 技法号（0=Legato 1=Long 2=Short …），键位仍然可用
    actions: {
      0: { pc: null, cc: { n: 32, v: 0 } },
      1: { cc: { n: 32, v: 2 } },
      2: { cc: { n: 32, v: 32 } },
      3: { cc: { n: 32, v: 12 } },
      4: { cc: { n: 32, v: 4 } },
      5: { cc: { n: 32, v: 6 } },
      6: { cc: { n: 32, v: 1 } },
      7: { cc: { n: 32, v: 34 } },
      8: { cc: { n: 32, v: 20 } },
      9: { cc: { n: 32, v: 25 } },
      10: { cc: { n: 32, v: 40 } },
    },
  },
  {
    id: 'eastwest-cc1', name: 'EastWest（CC1 力度 + PC）',
    actions: {
      0: { pc: 0, cc: { n: 1, v: 64 } },
      1: { pc: 1, cc: { n: 1, v: 90 } },
      2: { pc: 2, cc: { n: 1, v: 100 } },
      5: { pc: 5, cc: { n: 1, v: 110 }, vel: 1.1 },
    },
  },
  {
    id: 'vsl-ks', name: 'VSL（仅键位，力度稍柔）',
    actions: { 0: { vel: 0.95 }, 1: { vel: 1.0 }, 2: { vel: 1.05 } },
  },
];

const numOrNull = (v, lo, hi) => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(lo, Math.min(hi, Math.round(n)));
};

/** 读动作表（容错：脏数据直接忽略，不让一个坏键位毁掉整张表） */
export function loadExprMap() {
  try {
    const raw = localStorage.getItem(EXPR_LS);
    return sanitizeExprMap(raw ? JSON.parse(raw) : {});
  } catch (e) { return {}; }
}
export function saveExprMap(map) {
  try { localStorage.setItem(EXPR_LS, JSON.stringify(sanitizeExprMap(map))); } catch (e) {}
}
/** 规范化：键位 0..24、pc 0..127、cc.n 0..127、cc.v 0..127、vel 0.1..2、ch 0..15 */
export function sanitizeExprMap(map) {
  const out = {};
  for (const k of Object.keys(map || {})) {
    const midi = Number(k);
    if (!Number.isInteger(midi) || midi < 0 || midi > 24) continue;
    const a = map[k] || {};
    const act = {};
    if (a.pc != null) { const pc = numOrNull(a.pc, 0, 127); if (pc != null) act.pc = pc; }
    if (a.cc && a.cc.n != null) {
      const n = numOrNull(a.cc.n, 0, 127); const v = numOrNull(a.cc.v, 0, 127);
      if (n != null && v != null) act.cc = { n, v };
    }
    if (a.vel != null) { const vel = Number(a.vel); if (Number.isFinite(vel)) act.vel = Math.max(0.1, Math.min(2, vel)); }
    if (a.ch != null) { const ch = numOrNull(a.ch, 0, 15); if (ch != null) act.ch = ch; }
    if (Object.keys(act).length) out[midi] = act;
  }
  return out;
}

/** 设/清一个键位的动作（传 null 清掉） */
export function setExprAction(map, midi, patch) {
  const next = { ...sanitizeExprMap(map) };
  const key = String(midi);
  const merged = { ...(next[key] || {}), ...(patch || {}) };
  for (const k of Object.keys(merged)) if (merged[k] === null || merged[k] === undefined) delete merged[k];
  if (merged.cc && (merged.cc.n == null || merged.cc.v == null)) delete merged.cc;
  if (Object.keys(merged).length) next[key] = merged; else delete next[key];
  return sanitizeExprMap(next);
}

/** 套用内置动作预设（只覆盖预设里给出的键位，其余保留） */
export function applyExprPreset(map, presetId) {
  const p = EXPR_PRESETS.find((x) => x.id === presetId);
  if (!p) return sanitizeExprMap(map);
  const next = { ...sanitizeExprMap(map) };
  for (const k of Object.keys(p.actions)) next[k] = { ...(next[k] || {}), ...p.actions[k] };
  return sanitizeExprMap(next);
}

export function exportExprMapJson(map) {
  return JSON.stringify({ format: 'fufumidi-expression-map', version: 1, actions: sanitizeExprMap(map) }, null, 2);
}
export function importExprMapJson(text) {
  try {
    const o = JSON.parse(text);
    return sanitizeExprMap(o && o.actions ? o.actions : o);
  } catch (e) { return null; }
}

/**
 * 把一条轨上的技法切换展开成 MIDI 事件与"后续生效值"。
 *
 * @param track   { notes: [{ start, end, midi, vel, ch }] }
 * @param ksMap   { [midi 0..24]: 技法名 } —— 只有**表里有的键**才算切换（与技法条同一口径）
 * @param exprMap 动作表
 * @returns {{ switches, pcs, ccs, progAt, velAt, count }}
 *   - pcs: [{ tick, program, ch }] 供导出（encodeMidi 的 tr.pcs）
 *   - ccs: [{ tick, cc, cv, ch }]  供导出与播放（播放侧会跳过 CC0/32 的库选择）
 *   - progAt(tick) / velAt(tick): 该时刻生效的音色与力度系数（给"给音符盖章"用）
 */
export function articulationPlan(track, ksMap, exprMap) {
  const notes = (track && track.notes) || [];
  const map = ksMap || {};
  const acts = sanitizeExprMap(exprMap);
  const switches = [];
  for (const n of notes) {
    if (!n || n.midi == null || n.midi > 24) continue;
    const name = map[n.midi];
    if (!name) continue;                       // 没命名的键位不算技法（与技法条一致）
    switches.push({ tick: n.start || 0, midi: n.midi, name, act: acts[n.midi] || null, ch: n.ch });
  }
  switches.sort((a, b) => a.tick - b.tick);
  const pcs = [], ccs = [];
  for (const s of switches) {
    if (!s.act) continue;
    if (s.act.pc != null) pcs.push({ tick: s.tick, program: s.act.pc, ch: s.act.ch != null ? s.act.ch : s.ch });
    if (s.act.cc) ccs.push({ tick: s.tick, cc: s.act.cc.n, cv: s.act.cc.v, ch: s.act.ch != null ? s.act.ch : s.ch });
  }
  const progAt = (tick) => {
    let out = null;
    for (const s of switches) { if (s.tick > tick) break; if (s.act && s.act.pc != null) out = s.act.pc; }
    return out;
  };
  const velAt = (tick) => {
    let out = 1;
    for (const s of switches) { if (s.tick > tick) break; if (s.act && s.act.vel != null) out = s.act.vel; }
    return out;
  };
  return { switches, pcs, ccs, progAt, velAt, count: switches.length };
}

/**
 * 把技法动作并进"给导出/播放用的轨道数据"（**不改原对象**）。
 * 返回新的 tracks 数组：ccs 合并、pcs 新增、每个音符按所处区间盖上 prog/vel。
 */
export function augmentTracks(tracks, ksMap, exprMap) {
  return (tracks || []).map((tr) => {
    const plan = articulationPlan(tr, ksMap, exprMap);
    if (!plan.switches.length) return tr;
    const progByTick = new Map(plan.pcs.map((p) => [p.tick, p.program]));
    const notes = (tr.notes || []).map((n) => {
      const prog = plan.progAt(n.start || 0);
      const vel = plan.velAt(n.start || 0);
      const out = { ...n };
      if (prog != null) out.prog = prog;
      if (vel !== 1 && n.vel != null) out.vel = Math.max(1, Math.min(127, Math.round(n.vel * vel)));
      return out;
    });
    const ccs = [...(tr.ccs || []), ...plan.ccs];
    return { ...tr, notes, ccs, pcs: [...(tr.pcs || []), ...plan.pcs], artSwitches: plan.count };
  });
}
