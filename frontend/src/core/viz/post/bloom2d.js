// ============================================================
// 泛光后处理（可视化重做 · post）
// 做法与旧实现一致（场景 → 1/4 降采样 → multiply 自乘≈阈值 → lighter 叠两遍），
// 但**搬出了渲染函数**：以后 WebGL2 版本换成着色器实现，图元层与调用点都不用动。
// node 环境没有 document → 直接跳过（单测只关心图元，不关心像素）。
// ============================================================
const CACHE = { scene: null, small: null };

function sized(key, pw, ph) {
  if (typeof document === 'undefined' || !document.createElement) return null;
  let cv = CACHE[key];
  if (!cv) cv = CACHE[key] = document.createElement('canvas');
  if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
  return cv;
}

export function ensureScene(pw, ph) { return sized('scene', pw, ph); }

/**
 * ctx 上已经画好场景时调用：从场景画布做提亮 + 模糊 + 叠回。
 * @param ctx 目标 2D 上下文（已恢复成设备像素坐标，即 setTransform(1,0,0,1,0,0)）
 * @param scene 场景离屏画布（设备分辨率）
 */
export function bloomPass(ctx, scene, pw, ph, amount, thr) {
  const small = sized('small', Math.max(1, Math.round(pw * 0.25)), Math.max(1, Math.round(ph * 0.25)));
  if (!small) return;
  const c2 = small.getContext('2d');
  c2.setTransform(1, 0, 0, 1, 0, 0);
  c2.globalCompositeOperation = 'source-over';
  c2.globalAlpha = 1;
  c2.clearRect(0, 0, small.width, small.height);
  c2.drawImage(scene, 0, 0, small.width, small.height);   // 降采样 = 低通
  if (thr > 0.02) {
    c2.globalCompositeOperation = 'multiply';
    c2.drawImage(small, 0, 0);
    if (thr > 0.45) c2.drawImage(small, 0, 0);
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = Math.min(1, amount * 0.42);
  ctx.drawImage(small, 0, 0, pw, ph);
  const ow = pw * 1.4, oh = ph * 1.4;
  ctx.globalAlpha = Math.min(1, amount * 0.22);
  ctx.drawImage(small, (pw - ow) / 2, (ph - oh) / 2, ow, oh);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
}
