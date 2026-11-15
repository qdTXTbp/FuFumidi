// -*- coding: utf-8 -*-
/**
 * 参数注册表（FLAD-04 数据层）。
 *
 * automation clip 需要一个**稳定参数键**：曲线的 `abbr`、混音字段名都只是
 * 现有结构的内部名字，直接拿来当 clip 的键，一旦改名或换显示语言就会漂移。
 * 这里给每个可自动化参数分配唯一 `parameterId`，并声明取值范围、单位与
 * 生效时机（render / playback）；clip 只存 id，不存显示名。
 *
 * ★ 本期只做数据层：不接 UI，也不改现有曲线/混音的读写路径。
 *   曲线参数由 `CURVE_TARGETS` 派生（单一来源），这里不是第二份定义。
 */

import { CURVE_TARGETS, CURVE_ORDER } from './track_automation.js';

/** 曲线参数 id 前缀：`curve.PIT` / `curve.VOL` … */
export const CURVE_PARAM_PREFIX = 'curve.';

/**
 * 「最后调整的参数」保留时长（毫秒）。
 *
 * 它只服务于「为刚才调的东西建一条自动化」这类即时入口；
 * 过一会儿就该失效 —— 三天前调过的参数还挂在菜单上只会造成误操作。
 */
export const LAST_TWEAK_TTL_MS = 2 * 60 * 1000;

/** 混音类参数：不挂在曲线子轨上，直接落在轨道字段（gainDb）里。 */
const MIX_PARAMS = [
  {
    id: 'track.gain',
    kind: 'mix',
    label: '增益',
    unit: 'dB',
    // 范围与轨增益输入框一致（ViewSing 的 -60..6）
    min: -60,
    max: 6,
    step: 0.5,
    def: 0,
    // 作用在已渲染音频上：与 VOL 曲线同属播放侧，改完立刻听得见
    mode: 'playback',
    engines: ['utau', 'diffsinger', 'audio'],
  },
];

function freezeParam(p) {
  return Object.freeze({ ...p, engines: Object.freeze((p.engines || []).slice()) });
}

/** id → 参数定义。键是稳定 id，**不要**用显示名做键。 */
export const PARAMS = (() => {
  const out = {};
  for (const p of MIX_PARAMS) out[p.id] = freezeParam(p);
  for (const abbr of CURVE_ORDER) {
    const t = CURVE_TARGETS[abbr];
    if (!t) continue;
    out[CURVE_PARAM_PREFIX + abbr] = freezeParam({
      id: CURVE_PARAM_PREFIX + abbr,
      kind: 'curve',
      abbr,
      label: t.label,
      unit: t.unit,
      min: t.min,
      max: t.max,
      step: t.step,
      def: t.def,
      mode: t.mode,
      engines: t.engines,
      note: t.note || '',
    });
  }
  return Object.freeze(out);
})();

/** 曲线 abbr → 参数 id；未知 abbr 返回 null（脏数据不得进入 clip 模型）。 */
export function curveParamId(abbr) {
  const a = String(abbr || '').toUpperCase();
  return CURVE_TARGETS[a] ? CURVE_PARAM_PREFIX + a : null;
}

/** 参数 id → 曲线 abbr；不是曲线参数则 null。 */
export function curveAbbrOf(paramId) {
  const s = String(paramId || '');
  if (!s.startsWith(CURVE_PARAM_PREFIX)) return null;
  const a = s.slice(CURVE_PARAM_PREFIX.length).toUpperCase();
  return CURVE_TARGETS[a] ? a : null;
}

export function paramById(paramId) {
  return (typeof paramId === 'string' && Object.prototype.hasOwnProperty.call(PARAMS, paramId))
    ? PARAMS[paramId]
    : null;
}

export function isParamId(paramId) {
  return !!paramById(paramId);
}

/**
 * 某条轨可自动化的参数 id（混音参数在前，曲线按 `CURVE_ORDER`）。
 *
 * 与 `targetsFor` 同口径：引擎用不了的参数不给出来，
 * 避免「界面上能选、引擎不认」。
 */
export function paramsForTrack(engine, kind) {
  const key = kind === 'audio' ? 'audio' : String(engine || '');
  return Object.keys(PARAMS).filter((id) => PARAMS[id].engines.indexOf(key) >= 0);
}

/** 把值钳制到参数自身范围；非法值回落到默认值。未知 id 返回 null。 */
export function normalizeParamValue(paramId, value) {
  const p = paramById(paramId);
  if (!p) return null;
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(n)) return p.def;
  return n < p.min ? p.min : (n > p.max ? p.max : n);
}
