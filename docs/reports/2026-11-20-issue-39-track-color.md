# Issue #39：同一轨道的标识色在卷帘与混音台不一致

- **Issue**：https://github.com/qdTXTbp/FuFumidi/issues/39
- **报告人**：Jerry114514（2026-11-16）
- **状态**：已修（2026-11-20），待发版验证

## 现象

用户给了两个例子，指向同一件事：

| 轨道 | 轨道图 / 卷帘 | 混音台（均衡器） |
|---|---|---|
| drum 轨 | 红色 | 蓝色 |
| 人声 Voice | 土黄色 | 紫色 |

用户描述「偶发、无法稳定复现」，并补充「乐器声部更少的分组里更明显」。

## 根因

**两套调色板并存，且顺序完全不同**：

| 索引 | `--track-N`（主题色板，8 色） | `TRACK_COLORS` = `VIEW_TRACK_RAMP`（10 色） |
|---:|---|---|
| 0 | `#3b82f6` 蓝 | `#ff5530` 红橙 |
| 1 | `#14b8a6` 青 | `#ea5ec1` 粉 |
| 2 | `#22c55e` 绿 | `#1456f0` 蓝 |
| 3 | `#f59e0b` **土黄** | `#a855f7` **紫** |
| 4 | `#ef4444` **红** | `#3daeff` **天蓝** |
| 5 | `#a855f7` 紫 | `#1ba673` 绿 |
| 6 | `#06b6d4` 青蓝 | `#3b82f6` 蓝 |
| 7 | `#ec4899` 粉 | `#f59e0b` 橙 |
| 8 | （回绕到 0） | `#d45656` 红 |
| 9 | （回绕到 0） | `#17437d` 深蓝 |

调用点分成两派：

- **读主题色板**：`EditorCanvas.vue`（钢琴卷帘主画布）读 `--track-1..8`；
- **读 10 色序列**：`stores/app.ts` 产出的 `state.tracks[].color`、`core/viz.js`（瀑布流）、
  `ViewAnalyze.vue`（音轨概览）、`ViewScore.vue`（乐谱轨道点）都用 `TRACK_COLORS[i % 10]`。

`PlayerBar.vue` / `ViewPlay.vue` 直接渲染 `tr.color`，因此跟着后一派 → 与卷帘不一致。

用户的两个例子逐位吻合：index 3 是「土黄 vs 紫」，index 4 是「红 vs 天蓝」。
「偶发」是因为只有部分索引在两套色板上差异明显；「声部少更明显」是因为声部少时用户更容易逐个对照。

## 修复

新增**单一入口** `frontend/src/core/palette.js` 的 `trackColor(i)`：

```js
export function trackColor(i) {
  const n = ((Math.trunc(Number(i) || 0) % 8) + 8) % 8;
  return themeColor('--track-' + (n + 1), TRACK_FALLBACK[n]);
}
```

- 读 `--track-1..8`，**跟随深浅主题**（`themeColor` 带主题纪元缓存，逐帧调用只有一次 Map 查询）；
- 越界与负数都按 8 回绕，超过 8 轨不会取到 `undefined`；
- 所有「轨色」入口统一改走它：

| 文件 | 改动 |
|---|---|
| `core/palette.js` | 新增 `trackColor`，注释写明为何不能直接用 10 色序列 |
| `stores/app.ts` | `state.tracks[].color` 改用 `trackColor(i)` |
| `store.js` | 同上（旧 store 路径，保持一致） |
| `core/viz.js` | 瀑布流 block 色改用 `trackColor(tr.index)` |
| `views/ViewAnalyze.vue` | 音轨概览 hBar 色改用 `trackColor(i)` |
| `views/ViewScore.vue` | 乐谱「轨道」色点改用 `trackColor(trackSel)` |
| `views/ViewEdit.vue` | 迷你卷帘 `MINI_C[tr.index % 10]` 改为 `trackColor(tr.index)` |
| `views/ViewConvert.vue` | 删掉未被使用的 `const TRACK_COLORS = VIEW_TRACK_RAMP` 死代码 |
| `core/util.js` | 保留 `TRACK_COLORS` 导出，但注释标记「仅画布固定序列，不要用于轨色」 |

## 验证

新增 `frontend/tests/track-color.test.js`（3 条）：

1. `trackColor` 按 8 色顺序取值，index 3 = 土黄、index 4 = 红（正是用户截图里的颜色）；
2. 同索引在两套色板上必须不同色（钉住 bug 本身）；`TRACK_FALLBACK` 8 色 / `VIEW_TRACK_RAMP` 10 色；
3. **源码契约**：`app.ts` / `store.js` / `viz.js` / `ViewAnalyze` / `ViewScore` / `ViewEdit`
   里不得再出现 `TRACK_COLORS[`，防止有人顺手改回去。

门禁：`test:ui` **656/656**、`typecheck`、`check:i18n`、`audit:ui-tokens`（颜色字面值仍 0）、
`audit:params`、`check:empty-catch`、`build:ui` 全绿。

> 注：测试在 node 下没有 `document`，`trackColor` 走 `TRACK_FALLBACK`（等于浅色主题档）；
> 浏览器里读的是实际 `--track-*`，深色档会提亮，但**顺序一致**——这正是修复的目标。

## 影响与边界

- **可见变化**：轨道标识色从「10 色固定序列」变为「8 色主题色板」。用户会看到部分轨道换了颜色，
  但**所有界面现在一致**，且切换深浅主题时轨色会同步变化（此前不会）。
- 超过 8 轨按 8 回绕，会出现重复色（与编辑器一直以来的行为一致）。
- `VIEW_TRACK_RAMP` 仍保留给波形/视频导出等**固定画布**场景，不再用于轨道身份。
- 应用内真机走查未做（本机未启动安装版）；建议发版前在混音台、卷帘、分析页、乐谱页四处对照同一轨颜色。

## 复现

```bash
node --test frontend/tests/track-color.test.js   # 3/3
npm run test:ui                                  # 656/656
```

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-20 | 首版。定位为两套调色板顺序不一致；统一到 `trackColor()`，加 3 条护栏。 |
