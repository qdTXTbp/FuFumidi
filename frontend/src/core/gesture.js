// ============================================================
// P1-13 B1 手势状态机（编辑 / 调教 / 编排共用一套语义）
// ============================================================
// 目标：指针事件只做一件事 —— 交给这里判定「这次手势到底在干什么」。
// 判定结果（intent）：
//   tap         点击（没超过阈值位移）→ 选中 / 定位，不产生撤销项
//   drag        拖动（音符 / 片段 / 曲线点）
//   resize-start / resize-end   拖左右边缘改长度（命中边缘 6px 内）
//   marquee     空白处拖框选
//   pan         空格 / 中键拖动平移（不改数据）
//   create      画笔工具从按下处创建
//   erase       橡皮工具擦除
// 约定：
//   · 3px 阈值内不算拖动 —— 手抖不会把点击变成"挪了 1 tick"，撤销粒度因此干净；
//   · 吸附由调用方注入 snapX/snapY（纯函数），引擎不假设任何坐标含义；
//   · 本模块不碰 DOM / 不弹撤销：只回答"在干什么、位移多少"。

export const INTENTS = {
  TAP: 'tap',
  DRAG: 'drag',
  RESIZE_START: 'resize-start',
  RESIZE_END: 'resize-end',
  MARQUEE: 'marquee',
  PAN: 'pan',
  CREATE: 'create',
  ERASE: 'erase',
};

/** 命中的元素到边缘的距离（像素）；hit.bounds = {left, right}，缺省返回 Infinity */
export function edgeDistance(hit, x, edgePx = 6) {
  const b = hit && hit.bounds;
  if (!b) return { edge: '', dist: Infinity };
  const dL = Math.abs(x - Number(b.left));
  const dR = Math.abs(x - Number(b.right));
  if (dL <= edgePx && dL <= dR) return { edge: 'start', dist: dL };
  if (dR <= edgePx) return { edge: 'end', dist: dR };
  return { edge: '', dist: Math.min(dL, dR) };
}

/**
 * 纯判定：这次按下对应哪个 intent（不依赖 Vue / DOM）
 * @param {{tool?:string, point:{x:number,y:number}, hit?:object|null, mods?:object,
 *          edgePx?:number, button?:number}} p
 */
export function resolveIntent(p) {
  const { tool = 'select', point, hit = null, mods = {}, edgePx = 6, button = 0 } = p || {};
  if (!point) return INTENTS.TAP;
  if (mods.pan || mods.space || button === 1) return INTENTS.PAN;
  if (tool === 'erase') return INTENTS.ERASE;
  if (tool === 'pencil') return INTENTS.CREATE;
  if (hit) {
    if (hit.edge === 'start') return INTENTS.RESIZE_START;
    if (hit.edge === 'end') return INTENTS.RESIZE_END;
    const e = edgeDistance(hit, point.x, edgePx);
    if (e.edge === 'start') return INTENTS.RESIZE_START;
    if (e.edge === 'end') return INTENTS.RESIZE_END;
    return INTENTS.DRAG;
  }
  return INTENTS.MARQUEE;
}

/** 新建一个空闲手势状态（可复用一个对象） */
export function createGestureState() {
  return {
    active: false,
    intent: '',
    start: null,
    last: null,
    point: null,
    moved: false,
    dx: 0,
    dy: 0,
    snapDx: 0,
    snapDy: 0,
    hit: null,
    thresholdPx: 3,
    snapX: null,
    snapY: null,
  };
}

/**
 * 开始手势。返回同一个 state（改写），调用方保留引用即可。
 * @param {object} state createGestureState() 的对象
 * @param {{point:{x,y}, hit?:object, tool?:string, mods?:object, button?:number,
 *          thresholdPx?:number, edgePx?:number, snapX?:Function, snapY?:Function}} p
 */
export function beginGesture(state, p) {
  const s = state || createGestureState();
  const { point, hit = null, tool = 'select', mods = {}, button = 0,
    thresholdPx = 3, edgePx = 6, snapX = null, snapY = null } = p || {};
  if (!point) return s;
  s.active = true;
  s.intent = resolveIntent({ tool, point, hit, mods, edgePx, button });
  s.start = { x: Number(point.x) || 0, y: Number(point.y) || 0 };
  s.last = { ...s.start };
  s.point = { ...s.start };
  s.moved = false;
  s.dx = 0; s.dy = 0; s.snapDx = 0; s.snapDy = 0;
  s.hit = hit || null;
  s.thresholdPx = Math.max(0, Number(thresholdPx) || 0);
  s.snapX = typeof snapX === 'function' ? snapX : null;
  s.snapY = typeof snapY === 'function' ? snapY : null;
  return s;
}

/**
 * 更新手势位置。返回 state。
 * moved 一旦为 true 就保持（拖回起点也算拖过，撤销粒度不变）。
 */
export function updateGesture(state, point) {
  const s = state;
  if (!s || !s.active || !point) return s;
  const x = Number(point.x) || 0;
  const y = Number(point.y) || 0;
  s.point = { x, y };
  s.last = { x, y };
  s.dx = x - s.start.x;
  s.dy = y - s.start.y;
  if (!s.moved && Math.hypot(s.dx, s.dy) > s.thresholdPx) s.moved = true;
  s.snapDx = s.snapX ? Number(s.snapX(x)) - Number(s.snapX(s.start.x)) : s.dx;
  s.snapDy = s.snapY ? Number(s.snapY(y)) - Number(s.snapY(s.start.y)) : s.dy;
  return s;
}

/**
 * 结束手势。返回描述：{ intent, moved, tap, dx, dy, snapDx, snapDy, start, end, hit }
 * tap = 没有超过阈值的位移（调用方据此走"点击"语义，不推撤销）。
 */
export function endGesture(state) {
  const s = state;
  if (!s || !s.active) return { intent: '', moved: false, tap: true, dx: 0, dy: 0, snapDx: 0, snapDy: 0, start: null, end: null, hit: null };
  const out = {
    intent: s.intent,
    moved: s.moved,
    tap: !s.moved,
    dx: s.dx, dy: s.dy, snapDx: s.snapDx, snapDy: s.snapDy,
    start: s.start ? { ...s.start } : null,
    end: s.point ? { ...s.point } : null,
    hit: s.hit || null,
  };
  resetGesture(state);
  return out;
}

/** 取消（Esc / 指针被系统回收 / 工具切换）：丢弃本次手势，不产生任何提交 */
export function cancelGesture(state) {
  if (state) resetGesture(state);
  return state;
}

function resetGesture(s) {
  s.active = false;
  s.intent = '';
  s.start = null;
  s.last = null;
  s.point = null;
  s.moved = false;
  s.dx = 0; s.dy = 0; s.snapDx = 0; s.snapDy = 0;
  s.hit = null;
  s.snapX = null;
  s.snapY = null;
}

/** 手势是否属于"会改数据"的一类（用于决定是否推撤销 / 是否标脏） */
export function isMutatingIntent(intent) {
  return [INTENTS.DRAG, INTENTS.RESIZE_START, INTENTS.RESIZE_END, INTENTS.CREATE, INTENTS.ERASE].includes(intent);
}
