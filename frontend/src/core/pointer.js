// ============================================================
// 手写笔 / 触控支持（M9 收尾）
// ============================================================
// 画布上的交互早就走 pointer 事件了（pointerdown/move/up），所以笔和手指**本来就能画**。
// 真正缺的是指针事件的「周边语义」，这三件事鼠标上不存在、笔和手指上必须处理：
//
// 1) 掌侧误触：写字时手掌会先落在屏幕上。浏览器把笔和手都发成 pointer 事件，
//    只有 pointerType 能区分 —— 笔在工作时到来的 touch 一律忽略。
// 2) 第二根手指：手指按住画布时再来一根手指，会**再触发一次 pointerdown**，
//    于是拖拽状态被重新初始化 —— 现象是「两指一碰，音符跳走」。只认第一个按下的指针。
// 3) 长按 = 右键：touch-action:none 之后浏览器不再自己发 contextmenu，
//    触控屏上就再也打不开右键菜单了。自己记时（默认 520ms、位移超过 8px 取消）。
//
// 另外：笔有真实压力（pointer 事件的 pressure 是 0..1 的实测值，鼠标恒为 0.5），
// 画音符时用它当力度是笔最自然的用法 —— 见 penPressure()。
'use strict';

/** 指针类型：'mouse' | 'pen' | 'touch'（老浏览器没有 pointerType 时按鼠标算） */
export function pointerTypeOf(e) {
  const t = e && e.pointerType;
  return t === 'pen' || t === 'touch' ? t : 'mouse';
}

/* ---- 只认第一个按下的指针 ---- */
let primaryId = null;      // 正在被用来拖拽的 pointerId
let primaryType = 'mouse';
let lastPenAt = 0;         // 最近一次笔活动（用于掌侧误触判定）

/**
 * 一次 pointerdown 是否应该被处理。
 * 返回 false 的两种情况：① 笔在近处而这一下是手指（掌侧误触）；② 已经有主指针在拖拽。
 * ★ 无论返回什么都会记下 pointerId —— pointerup/cancel 还要用它配对释放。
 */
export function claimPointer(e, palmMs = 1500) {
  const t = pointerTypeOf(e);
  if (t === 'pen') lastPenAt = Date.now();
  if (t === 'touch' && Date.now() - lastPenAt < palmMs) return false;
  if (primaryId === null) { primaryId = e.pointerId; primaryType = t; return true; }
  return primaryId === e.pointerId;
}
/** 只判掌侧误触：给「点一下就完事」的处理器用（它们没有 pointerup，不该占用主指针槽位） */
export function palmRejected(e, palmMs = 1500) {
  const t = pointerTypeOf(e);
  if (t === 'pen') { lastPenAt = Date.now(); return false; }
  return t === 'touch' && Date.now() - lastPenAt < palmMs;
}

/** 这一次 pointermove 属不属于主指针（第二根手指的移动必须丢掉） */
export function isPrimaryPointer(e) {
  return primaryId === null || e.pointerId === primaryId;
}
/**
 * 收尾：主指针抬起才释放；**无参调用**（pointerleave 等收尾路径）= 无条件释放。
 * 返回 true 表示"这次抬起属于主指针"。★ 调用方必须据此决定要不要收尾拖拽 ——
 * 被挡掉的第二根手指 / 掌侧抬起时**不能**收尾，否则笔还在拖、拖拽状态已经被清掉了
 * （实测：oto 标记用笔拖到一半停住，就是因为掌侧那一下的 pointerup 把 dragKey 清了）。
 */
export function releasePointer(e) {
  if (!e || e.pointerId === primaryId) { primaryId = null; primaryType = 'mouse'; return true; }
  return false;
}
/** 当前主指针是不是笔（给「笔才启用」的行为用，例如压力当力度） */
export function primaryIsPen() { return primaryType === 'pen'; }
/** 调试/验收用：把状态归零（脚本模拟笔触之后免得影响下一段） */
export function resetPointerState() { primaryId = null; primaryType = 'mouse'; lastPenAt = 0; }

/* ---- 笔的压力 ---- */
/** 笔的实测压力（0..1）；鼠标/手指一律返回 0（鼠标恒为 0.5，那是「按下」不是压力） */
export function penPressure(e) {
  if (pointerTypeOf(e) !== 'pen') return 0;
  const p = Number(e && e.pressure);
  return p > 0 && p <= 1 ? p : 0;
}

/* ---- 长按 = 右键 ---- */
/**
 * 长按检测器。用法：
 *   const lp = makeLongPress((e) => openCtx(e));
 *   down(e): if (!lp.down(e)) return;   // 已有一个长按在计时
 *   move(e): lp.move(e);                // 位移超过 slop 自动取消
 *   up(e):   if (lp.up(e)) return;      // 刚刚是长按 → 跳过「点击提交」
 */
export function makeLongPress(fire, opts = {}) {
  const ms = opts.ms || 520;
  const slop = opts.slop || 8;
  let timer = null, sx = 0, sy = 0, fired = false, active = false;
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
  return {
    down(e) {
      if (active) return false;           // 已经在计时：这一下不接管
      active = true; fired = false;
      sx = e.clientX; sy = e.clientY;
      clear();
      timer = setTimeout(() => { timer = null; fired = true; try { fire(e); } catch (err) {} }, ms);
      return true;
    },
    move(e) {
      if (!timer) return;
      if (Math.abs(e.clientX - sx) > slop || Math.abs(e.clientY - sy) > slop) clear();
    },
    /** 返回 true = 这次交互刚刚以长按收场（调用方不要再当成点击/拖拽提交） */
    up() {
      clear();
      const was = fired;
      fired = false; active = false;
      return was;
    },
    cancel() { clear(); fired = false; active = false; },
    get pending() { return !!timer; },
    get fired() { return fired; },
  };
}
