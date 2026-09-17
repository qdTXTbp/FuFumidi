// 断言：纵向线性渐变着色与定义时的 x 无关 —— 琴键共用同一个渐变对象的前提。
// 左边用「每个键各建一个、x 取键位」的老写法，右边用「x 固定为 0 的共用渐变」，逐像素比对。
(() => {
  const c = document.createElement('canvas');
  c.width = 40; c.height = 20;
  const g = c.getContext('2d');
  const gA = g.createLinearGradient(5, 0, 5, 20);
  gA.addColorStop(0, '#ff8800'); gA.addColorStop(1, '#0033aa');
  g.fillStyle = gA; g.fillRect(0, 0, 20, 20);
  const gB = g.createLinearGradient(0, 0, 0, 20);
  gB.addColorStop(0, '#ff8800'); gB.addColorStop(1, '#0033aa');
  g.fillStyle = gB; g.fillRect(20, 0, 20, 20);
  const d = g.getImageData(0, 0, 40, 20).data;
  let diffPx = 0, maxDelta = 0;
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) {
    const i = (y * 40 + x) * 4, j = (y * 40 + 20 + x) * 4;
    let bad = false;
    for (let k = 0; k < 3; k++) { const dd = Math.abs(d[i + k] - d[j + k]); if (dd) { bad = true; if (dd > maxDelta) maxDelta = dd; } }
    if (bad) diffPx++;
  }
  const total = 20 * 20;
  return {
    pixelsCompared: total,
    differingPixels: diffPx,
    differingRatio: +(diffPx / total).toFixed(4),
    maxChannelDelta: maxDelta,
    verdict: diffPx === 0 ? '逐像素一致' : (maxDelta <= 1 ? '仅 8bit 舍入差（≤1 级，肉眼不可辨）' : '存在可见差异，不能共用'),
  };
})()
