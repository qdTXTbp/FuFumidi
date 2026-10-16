# FuFumidi 界面设计语言（M5）

> 这份文档是界面层的**规范**，不是说明书。凡是要改界面的人（包括 agent）先读这里，
> 再动 `frontend/src/styles/tokens.css` 与 `frontend/src/core/theme.js`。
> 配套守门脚本：`npm run audit:ui-tokens`。

## 0. 一句话

界面只有 **6 档字号 / 4 档圆角 / 4-8 间距网格 / 一套语义色**；
颜色的唯一来源是 `core/theme.js`（深浅两档都在它手里），组件里**不许出现颜色字面值**。

## 1. Token 表（唯一允许写死取值的地方：`styles/tokens.css`）

| 类别 | token | 取值 |
|---|---|---|
| 字号 | `--fs-xs / sm / md / lg / xl / 2xl` | 11 / 12 / **13（正文）** / 15 / 20 / 28 |
| 行高 | `--lh-tight / --lh-base` | 1.25 / 1.55 |
| 字重 | `--fw-body / medium / strong` | 400 / 500 / 600（**700 只许标题与大字**） |
| 间距 | `--sp-1 … --sp-6` | 4 / 8 / 12 / 16 / 24 / 32 |
| 圆角 | `--r-sm / md / lg / pill` | 6 / 10 / 14 / 999（圆形仍写 `50%`） |
| 阴影 | `--sh-1 / 2 / 3` | 贴地 / 浮层 / 模态（**深浅两档取值不同**，见 `4） |
| 动效 | `--dur-1/2/3`、`--ease` | 只服务因果，不做装饰性循环 |
| 字体 | `--font-ui / num / display` | 内置子集化；正文 ui、数字 num、标题 display |
| 语义色 | `--t-ok / warn / err / info / stage / panel / raised / sunken / line / text* / on-accent` | 由 theme.js 按模式发布 |
| 数据色 | `--data-1 … --data-7` | 可视化、图表、分类共用同一套 |

### 1.1 上一版 → 这一版的映射（自动化 codemod 实测）

- **字号 32 档 → 6 档**：720 处声明。`9/9.5/10/10.5/11→xs`、`11.5/12→sm`、`12.5/13/13.5→md`、
  `14/15/16/17→lg`、`18/20→xl`、`24/30/32/34→2xl`。
- **圆角 31 档 → 4 档**：374 处声明 + 29 处旧变量。`2~7→sm`、`8~12→md`、`14~22→lg`、`99/999+→pill`。
- **间距 323 种字面量 → 网格**：777 处（gap 567 + 外壳层内外边距 210）。
  `≤3px 保留为微调档`（徽标内边距、列表发丝间距），`>32px 保留`（页面级大留白）。
- **颜色 288 处硬编码 → token**：CSS 侧 186 处、脚本侧 22 处、4 份重复轨色板合并为 1 份。

## 2. 颜色的唯一来源：core/theme.js

`applyTheme(name, accent, mode)` 把整套调色板写成 **documentElement 的内联样式**，
优先级高于任何样式表。因此：

- **不要用 CSS 去覆盖 `--canvas/--ink/--surface` 这批变量** —— 内联样式会赢，
  只能靠 `!important` 硬顶，那是掩盖问题。要改就改 `paletteFor()`。
- `styles/tokens.css` 里的同名字面值只是 **JS 起来之前**的首屏兜底。
- 深浅两档的语义色/阴影/数据色**全部在这里发布**（M2 新增 `t-* / on-accent / sh-* / data-*`）：

  | token | 深色 | 浅色 |
  |---|---|---|
  | `--t-err` | `#ff6b6b` | `#c0392b` |
  | `--t-ok` | `#3ecf8e` | `#0f7a4a` |
  | `--t-warn` | `#ffb340` | `#8a5a00` |
  | `--t-info` | `#5ac8fa` | `#0b6f9c` |
  | `--sh-2` | `0 12px 32px rgba(0,0,0,.42)` | `0 12px 32px rgba(16,24,40,.10)` |
  | `--data-3` | `#ffe066` | `#8a6100` |

  浅色档必须**压深**：白底上 `#ff6b6b` 只有 2.6:1，正文读不清（这是社区对"浅底浅字"的批评点）。

## 3. 画布/图表的颜色：core/palette.js

HTML 里的颜色走 CSS 变量；**画布（Canvas2D/WebGL）里读不到 CSS 变量**，所以：

- 优先 `cssVar('--track-1', 兜底)` / `themeColor('--t-err', 兜底)` ——
  `themeColor` 按"主题纪元"缓存（`theme.js` 的 `themeEpoch()`，每次 `applyTheme` +1），
  逐音符调用也不会反复查样式表，切主题自动失效。
- 兜底字面值只能写在 `core/palette.js`。那里也是**唯一**允许出现画布色值字面值的文件。
- 轨道色板、元素数据色、歌手轨色、色觉障碍备选配色（Okabe-Ito）都在那里；
  `core/util.js` 与 `stores/singer.ts` 现在是**再导出**，不再各存一份。

## 4. 深色为主，浅色可选

- 默认深色（首次启动、未设置时写入 `fufumidi_mode='dark'`）；用户已选的设置**不动**。
- 模式键是 `fufumidi_mode`（`light|dark|auto`），`fufumidi_theme` 存的是**主题 ID**，别混。
- 实测（安装版，2026-10-19）：深浅两档下 `--canvas` `hsl(213,52%,8%)` / `#f4f7fb`，
  `--ink` `hsl(213,30%,96%)` / `#0f172a`；375 个文本节点**对比度全部达标**（正文 ≥4.5:1，大字 ≥3:1）。

## 5. 字体

三款全部内置并子集化（合计 812 KB，离线可用）：

| 用途 | 字体 | 体积 | 子集 |
|---|---|---|---|
| 界面正文（含中文） | FuFumidi Sans（Noto Sans SC 可变字体子集） | 759 KB | 2912 字 / 2705 CJK |
| 数字与遥测 | FuFumidi Mono（JetBrains Mono） | 34 KB | — |
| 标题与品牌（衬线） | FuFumidi Display（Cinzel） | 19 KB | 只用于标题 |

- 取字来源见 `scripts/fetch-fonts.mjs`（缓存目录在**仓库外** `E:\Midi\_attic\fonts-src`，
  上游字体下载 + `fontTools.subset` 子集化；工具链用 `_attic\envs\gsv\python.exe`，它带 brotli）。
- 正文**不许**用衬线字体或艺术字体；正文**不许**超过 `--fw-strong`(600)。
- `typography.css` 必须**在 styles.css 之后**导入（同优先级下后加载的赢）。

## 6. 无障碍与手感

- 命中区 ≥28×28px（工具按钮）；图标按钮的实际可点区域由 `padding`+`min-width` 保证。
- 正文对比度 ≥4.5:1、大字 ≥3:1；状态不许只靠颜色区分（配图标或文字）。
- `prefers-reduced-motion` 下动效降到 0.01ms（`tokens.css` 末尾已处理）。
- 每个浮层都要有出口（Esc / 点外部 / 关闭按钮），这是上一轮评审的硬要求。

## 7. 守门：`npm run audit:ui-tokens`

脚本 `scripts/check-ui-tokens.mjs` 守四条线，并带**棘轮基线**（只许变小）：

| 检查 | 基线（2026-10-19） | 起点 |
|---|---|---|
| 颜色字面值 | **21** | 288 |
| font-size 字面值 | **0** | 720 |
| border-radius 字面值 | **0** | 374 |
| gap 游离值 | **0** | 610 |

合法的字面值只有四类：① token 定义行（`--x: #hex`）；② `core/theme.js`/`core/palette.js`/
`core/viz/state/themes.js`/`styles/tokens.css` 这四个文件；③ 兜底写法
`cssVar('--x','#hex')` / `themeColor('--x','#hex')` / `pal.getPropertyValue('--x') || '#hex'` /
`var(--x, #hex)`；④ 注释里的色号。

剩下 21 处集中在画布绘制（`ArrangeView`/`VoicebankPanel`/`ViewConvert`/`ViewViz` 的白/黑墨色与播放头色），
逐个要看绘制意图再定，**不要机械替换**。改善后跑 `node scripts/check-ui-tokens.mjs --update` 下调基线。

## 8. 与可视化子系统（core/viz）的关系

`core/viz/**` 有自己的一套主题（`state/themes.js` 的 7 套可视化主题 + `state/colors.js` 的取色系统），
它面向"舞台"而不是"应用界面"，因此**不套用** `--t-*` 语义色，也不受本守门脚本约束
（脚本显式跳过 `core/viz/**`）。可视化面板的默认起手色放在 `palette.js` 的 `FX_DEFAULT_COLORS`。

## 9. 还没做的（按优先级）

1. **M3 组件契约**：15 个重复控件 → 9 个契约类（按钮 / 输入 / 选择 / 卡片 / 面板 / chip / tab / 表格行 / 空状态）。
   目前 `styles.css` 已统一了字号圆角间距，但同类控件仍各写各的 padding/height。
2. **M4 三个大视图**（`ViewSing` 208 KB / `ViewEdit` 190 KB / `ViewTranscribe` 155 KB）：
   把本地样式换成契约类；这一步必须**逐视图**做并各自截图对比，不能脚本化。
3. 剩下 21 处画布色值逐个定性（见 `7）。
