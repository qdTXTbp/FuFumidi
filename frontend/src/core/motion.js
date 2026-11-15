// ============================================================
// 全局动效：阻尼弹簧参数（stiffness / damping / mass）
// ============================================================
// 设计目标：所有 CSS 过渡与关键帧不再手写 duration + cubic-bezier，
// 而是由**一套阻尼谐振子参数**推导出时长与缓动曲线：
//
//     ω0 = sqrt(k / m)             自然角频率
//     ζ  = c / (2 * sqrt(k * m))   阻尼比（<1 有回弹，=1 临界阻尼，>1 过阻尼）
//
// 再对阶跃响应采样，写成 CSS `linear()` 缓动（Chromium 113+ 支持，
// 允许输出 >1 的过冲值），这样浏览器端一次过渡就是一条真实的阻尼曲线，
// 而不是靠贝塞尔近似"假装回弹"。
//
// 只调这里（或 localStorage 的 fufumidi_motion），全站动效一起变；
// 组件样式一律引用 --spring-ease-* / --spring-dur-*，不要再写死时长。

/** 默认参数：ζ≈0.72，轻微回弹但不晃。 */
export const DEFAULT_SPRING = Object.freeze({
  stiffness: 210,   // 刚度 k（越大越快）
  damping: 21,      // 阻尼 c（越大约束回弹）
  mass: 1,          // 质量 m（越大越慢）
});

/** 三档速度：同一套参数，按刚度缩放（快 1.5× / 标准 1× / 慢 0.62×）。 */
const TIER_SCALE = { fast: 1.5, base: 1, slow: 0.62 };

const SAMPLE_STEPS = 40;
const LS_KEY = 'fufumidi_motion';

function num(v, d) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : d;
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

/** 归一化参数：防止 0 / 负数 / 离谱值把时长推到不可用区间。 */
export function normalizeSpring(raw) {
  const src = raw || {};
  return {
    stiffness: clamp(num(src.stiffness, DEFAULT_SPRING.stiffness), 20, 2000),
    damping: clamp(num(src.damping, DEFAULT_SPRING.damping), 1, 200),
    mass: clamp(num(src.mass, DEFAULT_SPRING.mass), 0.2, 10),
  };
}

/** 阻尼比（ζ<1 欠阻尼有回弹；=1 临界；>1 过阻尼）。 */
export function dampingRatio(params) {
  const p = normalizeSpring(params);
  return p.damping / (2 * Math.sqrt(p.stiffness * p.mass));
}

/**
 * 阶跃响应 x(t)：从 0 到 1 的位移，t 单位为秒。
 * 欠阻尼用解析解；临界/过阻尼用解析解或数值积分，保证 x(∞)=1。
 */
export function springStep(params, t) {
  const p = normalizeSpring(params);
  const w0 = Math.sqrt(p.stiffness / p.mass);
  const zeta = dampingRatio(p);
  const time = Math.max(0, num(t, 0));
  if (zeta < 1 - 1e-6) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const e = Math.exp(-zeta * w0 * time);
    return 1 - e * (Math.cos(wd * time) + (zeta * w0 / wd) * Math.sin(wd * time));
  }
  if (Math.abs(zeta - 1) <= 1e-6) {
    return 1 - Math.exp(-w0 * time) * (1 + w0 * time);
  }
  const s = Math.sqrt(zeta * zeta - 1);
  const r1 = -w0 * (zeta - s);
  const r2 = -w0 * (zeta + s);
  return 1 - (r2 * Math.exp(r1 * time) - r1 * Math.exp(r2 * time)) / (r2 - r1);
}

/**
 * 稳定时间：|x-1| 与速度都足够小所需的时间（秒）。
 * 上限 0.9s、下限 0.08s，避免过阻尼参数产生"动画消失"或"卡半秒"。
 */
export function springSettle(params) {
  const p = normalizeSpring(params);
  const w0 = Math.sqrt(p.stiffness / p.mass);
  let t = 0;
  const dt = 1 / 240;
  while (t < 0.9) {
    const x = springStep(p, t);
    const v = (springStep(p, t + dt) - x) / dt;
    if (t > 0.05 && Math.abs(1 - x) < 0.0015 && Math.abs(v) < 0.02) return t;
    t += dt;
  }
  return clamp(0.9, 0.08, Math.max(0.08, 4 / (w0 || 1)));
}

/**
 * 生成 CSS `linear()` 缓动字符串；采样点包含过冲（>1），
 * 浏览器会按真实阻尼曲线插值。
 */
export function springEasing(params, steps = SAMPLE_STEPS) {
  const p = normalizeSpring(params);
  const dur = springSettle(p);
  const n = Math.max(8, Math.round(steps));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = (dur * i) / n;
    const x = springStep(p, t);
    out.push(i === 0 ? 0 : (i === n ? 1 : Math.round(x * 10000) / 10000));
  }
  return 'linear(' + out.join(', ') + ')';
}

/** 某一档的完整派生值：缓动 + 时长（毫秒）。 */
export function tierMotion(params, tier = 'base') {
  const p = normalizeSpring(params);
  const scale = TIER_SCALE[tier] || 1;
  const scaled = { stiffness: p.stiffness * scale, damping: p.damping * Math.sqrt(scale), mass: p.mass };
  return {
    easing: springEasing(scaled),
    durationMs: Math.max(80, Math.round(springSettle(scaled) * 1000)),
    zeta: dampingRatio(scaled),
  };
}

/** 计算全站 CSS 变量（不写 DOM，便于单测）。 */
export function motionCssVars(params) {
  const p = normalizeSpring(params);
  const vars = {
    '--spring-stiffness': String(p.stiffness),
    '--spring-damping': String(p.damping),
    '--spring-mass': String(p.mass),
    '--spring-zeta': String(Math.round(dampingRatio(p) * 1000) / 1000),
  };
  for (const tier of ['fast', 'base', 'slow']) {
    const m = tierMotion(p, tier);
    vars['--spring-ease-' + tier] = m.easing;
    vars['--spring-dur-' + tier] = m.durationMs + 'ms';
    vars['--spring-zeta-' + tier] = String(Math.round(m.zeta * 1000) / 1000);
  }
  // 旧 token 全部指向弹簧派生值：现有 200+ 处 var(--ease-*) 无需改写即生效。
  vars['--ease-out'] = vars['--spring-ease-base'];
  vars['--ease-in-out'] = vars['--spring-ease-base'];
  vars['--ease-spring'] = vars['--spring-ease-fast'];
  vars['--ease'] = vars['--spring-ease-base'];
  vars['--motion-fast'] = vars['--spring-dur-fast'];
  vars['--motion-base'] = vars['--spring-dur-base'];
  vars['--motion-slow'] = vars['--spring-dur-slow'];
  return vars;
}

/** 读取持久化参数（损坏时回退默认）。 */
export function getMotionParams() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return normalizeSpring(JSON.parse(raw));
  } catch (e) { /* 隐私模式/损坏 JSON：用默认 */ }
  return Object.assign({}, DEFAULT_SPRING);
}

/** 写入持久化参数并返回生效值（给以后接设置面板/调试用）。 */
export function setMotionParams(patch) {
  const next = normalizeSpring(Object.assign({}, getMotionParams(), patch || {}));
  try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch (e) { /* 存不了就只在本进程生效 */ }
  applyMotionVars(document.documentElement, next);
  return next;
}

/** 把参数写成 documentElement 的内联变量；theme.js 的调色板不会覆盖这些键。 */
export function applyMotionVars(root, params) {
  const el = root || (typeof document !== 'undefined' ? document.documentElement : null);
  if (!el || !el.style) return null;
  const vars = motionCssVars(params || getMotionParams());
  for (const k of Object.keys(vars)) el.style.setProperty(k, vars[k]);
  return vars;
}
