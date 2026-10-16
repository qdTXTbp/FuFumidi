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

## 3.5 控件契约层：`styles/controls.css`（M3/M4）

字号/圆角/间距统一之后，**同类控件的形状**仍各写各的：实测三个大视图里有 46 / 43 / 23 条"控件类"规则，
光胶囊控件就有 `5px 14px`、`4px 12px`、`6px 13px` 三种内边距 —— 同一个"选中胶囊"在不同页面长得不一样。
契约层把 9 类控件的**形状与状态**固定下来，各视图只保留语义偏差（颜色、宽度、布局）：

| 契约 | 用途 | 关键取值 |
|---|---|---|
| `.fu-ctl` | 按钮 / 胶囊 / 分段控件 | `padding: var(--sp-1) var(--sp-3)`、`min-height: 28px`、`border-radius: var(--r-pill)`、`font-size: var(--fs-sm)` |
| `.fu-ctl--sm` | 密集工具条的紧凑档 | `2px var(--sp-2)`、`min-height: 24px`、`--fs-xs` |
| `.fu-ctl.active` / `.is-on` | 选中态（两个名字都认：仓库里普遍用 `active` 做 `:class` 绑定） | `--accent` 底 + `--on-accent` 字 |
| `.fu-field` | 输入框 / 下拉 / 包裹式搜索框 | `min-height: 30px`、`--r-md`、`:focus-within` 换 `--accent` 描边 |
| `.fu-chip` / `.fu-badge` | 小标记与状态徽标 | 胶囊形 + `--fs-xs`；徽标另有 `.is-ok/.is-err/.is-warn` |
| `.fu-tab` | 标签页 | 底边 2px 当前色 |
| `.fu-card` / `.fu-panel` | 卡片 / 浮层面板 | `--r-lg` + `--sh-1` / `--sh-3` |
| `.fu-row` | 列表行 | `var(--sp-2) var(--sp-3)` + 发丝分隔线 |
| `.fu-empty` | 空状态 | 居中 + `--sp-6` 留白 |

用法：模板上**两者都写**，例如 `class="fu-ctl tr-pill"` —— `.fu-ctl` 给形状，`.tr-pill` 只留语义偏差。
**不要再就地改 padding 造新档**；需要更紧就用 `.fu-ctl--sm`，需要方角就用 `.fu-ctl--sq`。

已迁移：`ViewTranscribe`（42 处类注入 + 删掉本地重复的形状规则）。
按测量结论**不强制迁移**的：
- `ViewEdit`：它的控件高度是刻意做的三档密度系统（`.ed-density-compact/standard/roomy` 调 22/23/24/26/30px），
  套统一的 28px 契约会破坏那个功能；其选中态本来就已是 `--accent` + `--on-accent`。
- `ViewSing`：本地控件很少，主体（`.chip-btn` 等）本来就在用共享类；
  这一轮只把它的紧凑控件抬到命中区下限（见 §6）。

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

- 命中区 ≥28×28px。实测方法：CDP 遍历所有可点元素量 `getBoundingClientRect`，小于 28 的按「类名+尺寸」聚合。
  **实测主犯**：`.icon-btn` 被调用处的内联 `style="width:26px;height:26px"` 压到 26×26（每页约 200 个）、
  `.chip-btn` 高 26、`.lib-sort` 高 25、`.ib`/`.pr-mini` 24。修法是在共享类上加 `min-width/min-height`
  （`min-*` 在层叠里优先于 `width/height`，内联也压得住），而不是去改几百处调用点。
- 紧凑档（`.fu-ctl--sm`）只缩内边距与字号，**不缩命中区**。
- **验收数字（2026-10-19，安装版 CDP，五页：首页/音乐/视图/转译/调教）**：
  修前不达标 7 / 8 / 11 / 12 / 17 个 → 修后 **0 / 0 / 0 / 0 / 0**。
  量法：取 `offsetWidth/offsetHeight`（布局尺寸，不受 `transform: scale()` 干扰），
  缩放子树内（钢琴卷帘预览）单独归类 —— 那里的元素视觉尺寸是刻意缩出来的。
- 子组件内的控件（如 `PianoRoll.vue` 的 `.pr-tool/.pr-track`）**必须写在该组件自己的样式块里**：
  父组件的 `<style scoped>` 够不到子组件内部元素（作用域 id 不同），实测踩过。
- 正文对比度 ≥4.5:1、大字 ≥3:1；状态不许只靠颜色区分（配图标或文字）。
- `prefers-reduced-motion` 下动效降到 0.01ms（`tokens.css` 末尾已处理）。
- 每个浮层都要有出口（Esc / 点外部 / 关闭按钮），这是上一轮评审的硬要求。

## 7. 守门：`npm run audit:ui-tokens`

脚本 `scripts/check-ui-tokens.mjs` 守四条线，并带**棘轮基线**（只许变小）：

| 检查 | 基线（2026-10-19） | 起点 |
|---|---|---|
| 颜色字面值 | **0**（另有 8 处行尾标注 `ui-tokens-allow` 的刻意字面值） | 288 |
| font-size 字面值 | **0** | 720 |
| border-radius 字面值 | **0** | 374 |
| gap 游离值 | **0** | 610 |

合法的字面值只有四类：① token 定义行（`--x: #hex`）；② `core/theme.js`/`core/palette.js`/
`core/viz/state/themes.js`/`styles/tokens.css` 这四个文件；③ 兜底写法
`cssVar('--x','#hex')` / `themeColor('--x','#hex')` / `pal.getPropertyValue('--x') || '#hex'` /
`var(--x, #hex)`；④ 注释里的色号。

**刻意写死**的四处（PDF/图片栅格化的纸面白、白+黑双层描边、可视化子系统内部绘制、持久化的用户默认值）
不走 token，而是在**行尾**标注 `// ui-tokens-allow: 理由` —— 守门脚本认这个标记，"例外"必须写清理由才存在。
（改前的 21 处已全部定性：14 处改读 token，其中揪出两个真 bug；另 8 处按标记保留。）
逐个要看绘制意图再定，**不要机械替换**。改善后跑 `node scripts/check-ui-tokens.mjs --update` 下调基线。

## 8. 与可视化子系统（core/viz）的关系

`core/viz/**` 有自己的一套主题（`state/themes.js` 的 7 套可视化主题 + `state/colors.js` 的取色系统），
它面向"舞台"而不是"应用界面"，因此**不套用** `--t-*` 语义色，也不受本守门脚本约束
（脚本显式跳过 `core/viz/**`）。可视化面板的默认起手色放在 `palette.js` 的 `FX_DEFAULT_COLORS`。

## 9. 还没做的（按优先级）

1. ~~**M3 组件契约**~~ 已完成并落地为 `styles/controls.css`（9 类，见 §3.5）。
   目前 `styles.css` 已统一了字号圆角间距，但同类控件仍各写各的 padding/height。
2. **M4 三个大视图**（`ViewSing` 208 KB / `ViewEdit` 190 KB / `ViewTranscribe` 155 KB）：
   把本地样式换成契约类；这一步必须**逐视图**做并各自截图对比，不能脚本化。
3. ~~剩下 21 处画布色值逐个定性~~ 已完成：14 处改读 token（含两个真 bug：编排器浅色档下的白音符、
   沉浸模式激活 chip 在深色档下近黑压深底），另 8 处带 `ui-tokens-allow` 理由保留。
