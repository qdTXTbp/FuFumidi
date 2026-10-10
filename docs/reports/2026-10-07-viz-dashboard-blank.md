# 缺陷报告：可视化「仪表盘」三块面板不显示

> 状态：**只诊断，不含修复**（按用户要求提交 PR 给协助者处理）。
> 环境：安装版 `E:\Midi\FuFumidi`，v5.0.0-beta.6，Windows，浅色主题。
> 复现入口：导航「视图 → 可视化」，模式选「仪表盘」。

## 现象

仪表盘模式下的三块卡片 —— **频谱瀑布**（`#vizSpectrum`）、**波形示波器**（`#vizScope`）、
**实时和弦**（`#vizChord`）—— 全部看起来是空的；上面那块「音符瀑布」是正常的。

## 实测数据（CDP 读取运行中的界面，非推测）

在「仪表盘」模式下、正在播放《【原神生日会】提瓦特民谣 5 轨》(`0:32 / 4:46`，`window.__fufumidiActivePlayer = true`)：

| 画布 | CSS 尺寸 | 后备缓冲 | 非空像素 | 平均亮度 |
|---|---|---|---|---|
| `vizRoll`（音符瀑布） | 1194×422 | 2985×1055 | 3 147 435 | 144 |
| `vizSpectrum`（频谱瀑布） | 365×186 | 912×465 | 389 007 | 98 |
| `vizScope`（波形示波器） | 365×186 | 912×465 | 42 351 | 13 |
| `vizChord`（实时和弦） | 365×186 | 912×465 | 424 080 | **246** |

- 渲染循环**在跑**：`window.__fufumidiVizEnergy` 稳定在 0.95~0.99。
- **没有任何异常**：切到「音符瀑布」再切回「仪表盘」，`Runtime.exceptionThrown` 与 `console.error` 均为 0 条。
- 主题变量：`--canvas: #f4f7fb`（近白）、`--ink: #0f172a`、`--stone: #64748b`。

⇒ 三块画布**确实在画**，所以问题不是「canvas 不存在 / 尺寸为 0 / 循环没跑」，
而是**画出来的东西在当前主题下看不见**（或以错误的前景色绘制）。

## 代码层面的两个可疑点（file:line）

### ① 画布引用只在挂载时取一次，而三块画布在 `v-if` 里面

- `frontend/src/views/ViewViz.vue:284-289` —— `onMounted` 里一次性 `document.getElementById(...)` 取到 `cvs = { roll, spec, scope, chord }`，之后**从不重取**。
- `frontend/src/views/ViewViz.vue:370-383` —— 三块画布位于 `<div class="viz-grid" v-if="!isWaterfall">` 内。
- `frontend/src/views/ViewViz.vue:37` —— `isWaterfall = mode === 'waterfall' || immersive`。
- `frontend/src/views/ViewViz.vue:273` —— `loadPrefs()` 会把上次的 `mode` 恢复成 `waterfall`，而它在 `onMounted` 里的调用顺序（`:282`）**早于**取引用（`:284`）。

后果：**只要组件挂载时不是仪表盘模式**（上次用的音符瀑布 / 沉浸模式，或从沉浸返回），
`cvs.spec/scope/chord` 就是 `null` 且**永远为 null**；之后切回「仪表盘」会重新创建 canvas 节点，
但引用不会更新。

### ② 取值处没有判空，且异常会每帧重复

```js
// frontend/src/views/ViewViz.vue:197-199
if (cvs.spec.clientWidth)  drawSpectrum(cvs.spec, syn);
if (cvs.scope.clientWidth) drawScope(cvs.scope, syn);
if (cvs.chord.clientWidth) drawChord(cvs.chord, syn);
```

引用为 `null` 时，`null.clientWidth` 抛 `TypeError`；它在 `tick()` 里，而 `raf` 已在 `:186` 排好下一帧，
于是**每帧抛一次、后面三行（含音符瀑布）全部不执行**。这条路径我这次没能在现场复现
（我的 `localStorage` 里 `mode` 是 `dash`，挂载时画布在 DOM 里），但机制是确定的：
**任何一次「瀑布 ↔ 仪表盘」或「进出沉浸」的切换都会重建 canvas 节点**，引用随即失效。
请协助者用这个复现步骤确认：进入可视化 → 点「音符瀑布」→ 刷新页面 → 点「仪表盘」。

### ③ 前景色是否跟主题走（第二条线索）

- `frontend/src/views/ViewViz.vue:39` 有 `cssVar()` 帮助函数，`:128-131` 里和弦面板会先用 `--canvas` 铺底；
  文字用 `--stone` / `--slate`（浅色主题下是灰色，理论上可见）。
- 但实测和弦画布**平均亮度 246/255**（背景 `#f4f7fb` 的近白占绝对多数），
  波形示波器却是 **13/255**（几乎全黑）。两者相差近 20 倍，说明四块画布**没有统一地从主题取前景色**：
  其中至少有一块在浅色主题下画的是「深底浅字」或「白底白字」。
- 建议协助者逐块核对 `drawSpectrum`（`:64`）、`drawScope`（`:96`）、`drawChord`（`:111`）的
  **清屏色 / 前景色 / 网格色**是否都走 `cssVar()`，而不是硬编码 `rgba(20,86,240,…)`（`:101`）这类常量。

## 建议排查顺序（给协助者）

1. 用上面的复现步骤确认 ① + ②：切到瀑布再刷新再切回仪表盘，看控制台是否出现
   `Cannot read properties of null (reading 'clientWidth')` 刷屏。
2. 若确认：把 `cvs` 改成**每次绘制前惰性获取**（或 `watch(isWaterfall)` 时重取 / 用模板 ref），
   并给三处判空加保护，避免单块画布缺失拖垮整帧。
3. 再核对 ③：把四块画布的前景/网格/清屏色统一到 `cssVar(--ink|--stone|--hairline|--canvas)`，
   在**浅色与深色两套主题**下各看一遍像素（本次只测了浅色）。

## 附：本次采集用的只读探针

```js
// 在开发者工具控制台执行：统计每块画布的非空像素与平均亮度
Array.from(document.querySelectorAll('.viz-page canvas')).map(c => {
  const g = c.getContext('2d'), d = g.getImageData(0, 0, c.width, c.height).data;
  let ink = 0, sum = 0;
  for (let i = 0; i < d.length; i += 4) { sum += d[i] + d[i+1] + d[i+2]; if (d[i+3] > 8 && (d[i]+d[i+1]+d[i+2]) > 60) ink++; }
  return { id: c.id, cw: c.clientWidth, ch: c.clientHeight, ink, avg: Math.round(sum / (d.length/4) / 3) };
});
```
