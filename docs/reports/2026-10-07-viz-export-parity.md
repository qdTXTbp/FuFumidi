# 方案：让**导出的视频画面**与**实时瀑布流**看起来是同一套视觉语言

> 状态：**方案 + 待应用补丁**（本次不改渲染管线）。原因：验证「质感是否一致」必须逐帧比对，
> 而定位期间用户正在用该实例，不能重启；宁可不半改，也不要把没验过的渲染改动合进去。
> 相关代码：`frontend/src/core/viz.js`、`frontend/src/views/ViewViz.vue`、`frontend/src/views/ViewConvert.vue`。

## 现状差异（已核对到行）

| 维度 | 实时（ViewViz） | 导出（ViewConvert） |
|---|---|---|
| 画布尺寸 | CSS × `devicePixelRatio`（实测后备缓冲 2335×1335） | `cv.width = W; cv.height = H`（1280×720 等），**`const dpr = 1`**（`:426-427`） |
| ctx 变换 | `ctx.setTransform(dpr,0,0,dpr,0,0)`（`:74-77`），传进去的是 **CSS 像素** | **无 setTransform** |
| 能量来源 | `readEnergy(syn)` = AnalyserNode 波形 RMS（合成器输出） | `rmsAt(audioBuf, nowSec)` = 解码音频 RMS（`readVideoFrame` 里的 `drawVideoFrame`，`:302`） |
| 发声音符 | `syn.activeNow()`（受静音/音量/效果影响） | 遍历谱面 `n.start <= tick && n.end >= tick`（`:294-297`，忽略静音轨） |
| 视图参数 | 用户选的 `wfZoom` / `colorScheme` / 背景 | 写死 `zoom: 1, colorScheme: 0`（`:305-306`） |
| 背景 | 卡片玻璃/圆角/边框 + 页面壁纸 | 整帧 `paintVizBg` 铺满，瀑布 `bg:{mode:'keep'}`（`:292,309`） |

`viz.js` 内部所有线宽 / 粒子半径 / 发光半径 / 网格间距 / 滚动步长都是**按调用方像素尺度**写死的，
其中滚动步长还带着一条注释：「滚动速度是 0.933 CSS 像素/帧，而 dpr=2.5 时设备像素粒度」（`:198`）。
⇒ 同一份绘制代码在两个尺度下必然长得不一样。

## 六项改动（按性价比排序）

### ① 统一坐标系（主因，必做）

导出也走「CSS 尺寸 + 缩放变换」：

```js
// ViewConvert.vue —— 原来：const dpr = 1; cv.width = W; cv.height = H;
const EXPORT_SCALE = 2;                       // 或取实时那台的 devicePixelRatio
cv.width = W * EXPORT_SCALE; cv.height = H * EXPORT_SCALE;
const ctx = cv.getContext('2d');
ctx.setTransform(EXPORT_SCALE, 0, 0, EXPORT_SCALE, 0, 0);
// 之后所有绘制一律用 CSS 尺寸 W/H（与实时完全一致）：
drawVideoFrame(ctx, W, H, tick, s, audioBuf, vf, nowSec);   // 不再传物理像素
```

要点：`paintVizBg` 与 `drawVizWaterfall` 收到的 `w/h` 必须是 **CSS 像素**（`viz.js:218-219` 的注释就是在警告这件事，
reset 成 identity 只会铺满左上角 1/dpr）。

### ② 滚动改为「按时间」而不是「按帧」

现状：每帧位移固定 ⇒ 实时 60/120/144 Hz 与导出固定 fps 之间密度必然不同。

```js
// viz.js：把常量改成速度（CSS 像素/秒），并由调用方传 dt
export function drawVizWaterfall(ctx, w, h, song, tick, opts = {}) {
  const dt = Number.isFinite(opts.dt) ? opts.dt : 1 / 60;   // 默认按 60fps 折算
  const SCROLL_PX_PER_SEC = 56;                              // ≈ 0.933 px/帧 × 60fps
  // …内部所有「每帧 +N」换成「+ N * dt * 60」或直接 SCROLL_PX_PER_SEC * dt
}
```

调用方：实时 `opts.dt = (now - lastPaint)/1000`，导出 `opts.dt = 1/fps`。

### ③ 能量包络统一（按秒平滑，而不是按帧）

现状：`smoothEnergy(prev, target, attack, release)` 是逐帧系数，两条链路的帧率不同 ⇒ 时间常数不同。

```js
// viz.js：新增按时间的平滑（保持 f(∞)=target 的指数形式）
export function smoothEnergyDt(prev, target, dt, attack = 0.5, release = 0.06) {
  const k = target > prev ? attack : release;
  return prev + (target - prev) * (1 - Math.exp(-dt / Math.max(1e-3, k)));
}
```

更彻底的做法（推荐，但改动更大）：导出用 `OfflineAudioContext + AnalyserNode` 复现**同一条**
「合成器输出 → 波形 RMS」链路，而不是读解码音频的 RMS（后者含伴奏整体，幅度/时间常数都与实时不同）。

### ④ 发声音符统一

导出不要直接遍历谱面，改为复用播放器判定（含轨道静音/独奏/音量、量化后时刻）：

```js
// 建议把 ViewViz/ViewConvert 两边共用的判定抽到 core/viz.js
export function activeNotesAt(song, tick, { mute = [], solo = -1, minVel = 1 } = {}) {
  const out = [];
  for (const tr of song.tracks) {
    if (solo >= 0 ? tr.index !== solo : mute.includes(tr.index)) continue;
    for (const n of tr.notes) if (n.start <= tick && n.end >= tick && (n.vel || 127) >= minVel) out.push(n);
  }
  return out;
}
```

### ⑤ 参数统一

导出读同一份偏好，而不是写死：

```js
const prefs = JSON.parse(localStorage.getItem('fufumidi_viz') || '{}');
const opts = { state: st, zoom: prefs.zoom ?? 1, colorScheme: prefs.colorScheme ?? 0, /* … */ };
```

### ⑥ 背景与遮罩统一

实时画面上层有卡片圆角/边框/玻璃与页面壁纸；导出是整帧背景。
做法：把实时的卡片外框在导出模板里显式画一遍（圆角 `roundRect` + `--hairline` 描边 + 内层 `--canvas` 填充），
或反过来——把实时那层卡片样式改成纯 CSS 装饰、不参与画面（推荐后者，长期只需维护一份）。

## 验收（把「质感」变成可测数字）

1. 在同一时刻 `t` 分别取：实时 `canvas.toDataURL()`、导出视频抽帧（`ffmpeg -ss <t> -i out.mp4 -frames:v 1`）。
2. 把两帧缩放到同尺寸，比较三项：
   - **等效线宽**（对水平扫描线做连通域统计，取中位宽度）
   - **ink 像素密度**（`alpha>8 && r+g+b>60` 的占比）
   - **平均亮度与直方图**（`--canvas` 背景占比）
3. 判据：三项差 **≤5%** 视为「同一套视觉语言」；>15% 就是现在这种「质感差距很大」。
4. 回归：`npm run typecheck`、`npm run test:ui`；导出 3 个模板（横屏/竖屏/字幕）各抽 3 帧。

## 风险与顺序建议

- ① + ② 是主因，先做这两条并**只比对同一 t 的两帧**，不要同时动颜色。
- ③ 若采用 OfflineAudioContext 方案，注意导出耗时会上升（整首离线渲染一次音频）。
- ⑥ 的两条路线选一条，别两边都改（否则又是一处两写、必然漂移）。
