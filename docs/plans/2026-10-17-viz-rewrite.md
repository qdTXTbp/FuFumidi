# 可视化底层重构方案（2026-10-17）

> 用户判词：「**效果很一般**」「**而且没有让琴键透明的选项**」「**算了，对可视化的代码全部革新，
> 参考 GitHub 上的项目底层重构**」。
> 这份文档是**重构方案**（不再打补丁）。历史：v1/v2/v3 见 `2026-10-16-viz-waterfall-fx.md`。

## 1. 先承认：为什么现在"一般"

对着用户的两张截图逐条复盘，根因有五条 —— 都不是"参数没调好"，是结构问题：

| # | 现象 | 根因 | 证据 |
|---|---|---|---|
| 1 | **画面发灰、音符没分量** | **没有"舞台"这一层**。背景档只负责"铺一张底"，没有默认暗场，也没有暗角；用户的实时画面里背景是**模糊壁纸**（亮且杂），而音符是淡色块 → 明暗关系是**倒的**。参考实现（SeeMusic / MIDIVisualizer）一律是**暗场 + 亮音符** | 用户截图：背景大块亮蓝白，音符只是稍亮的椭圆 |
| 2 | 新效果越加越难 | **一个大函数**：`drawVizWaterfall` 约 520 行，背景→音符→击键→琴键→粒子→后处理的顺序**写死**在里面；每加一个效果只能往 if 链里塞分支（已经 6 开关 + 7 参数） | `core/viz.js` 结构；改一次就要重跑一遍全部不变量 |
| 3 | **没有"层"这个概念** | 想单独控制"哪一层"的开关/透明度做不到。用户要的**琴键透明**正是层语义缺失的直接后果：只能给整段设 alpha，还要把内部每个显式设置 `globalAlpha` 的高亮/闪光层**逐个乘回去** —— 一漏就是 bug（今天刚漏出 TDZ 与漏乘两处） | 刚才实现 `keysAlpha` 时连踩两坑 |
| 4 | 换主题"看不出区别" | `FX_THEMES` 只是**参数覆盖 diff**（把泛光调大/透视调大），没有**调色板与材质**这一层。所以"霓虹/极光"换来换去还是同一套颜色 | v2 极光主题只是 bloom 更大、手色换掉 |
| 5 | 性能说不清 | `MAX_PARTS`、`shadowBlur`、逐元素发光混在一条链里，没有 per-layer 成本模型，也没有分层统计。离线台（CPU 光栅）实测 28 ms vs 真机 3.3 ms，差 8 倍 —— 说明我们连"这段代码贵不贵"都只能靠猜 | 离线台 vs 安装版 rAF 实测 |

## 2. 目标架构：分层 + 数据驱动

```
frontend/src/core/viz/
  index.js            门面：createVizRenderer()；旧导出 drawVizWaterfall / drawVizWaterfallPost 兼容保留
  timeline.js         音符 → 可绘制块（原 buildVizBlocks / visibleRange；二分裁剪依赖的不变量照旧）
  layout.js           几何：音域/缩放/白键宽度/透视/消失点 —— 纯函数，可单测
  palette.js          颜色工具：hex|rgb|hsl → rgba、混色、按背景亮度取可读色
  themes.js           主题 = 调色板 + 材质 + 参数（**数据**，不是 if）
  layers/
    background.js     背景：主题/纯色/图片/透明 + **暗场压角（vignette）**
    notes.js          音符：胶囊/白热内芯/力度/手色/落点光晕
    impact.js         击键：波纹、闪光、光柱、冲击环
    keyboard.js       琴键：不透明度★、隐藏★、键高、只显按键、透视、余辉、键名
    particles.js      粒子：火花/环/光柱（对象池 + 贴图图集）
  post/
    bloom.js          阈值提亮 + 两级模糊 + 加法合成（可关、可调阈值/强度）
    vignette.js       暗角/压暗（让暗场真的黑 —— 参考工程里这是"高级感"的来源）
```

**层接口**（每层只读共享 scene，不再互相偷改全局状态）：

```js
{ id: 'notes', enabled(fx), alpha(fx), draw(scene) }
// scene = { ctx, w, h, fx, theme, geom, tick, blocks, visible, hits, sounding, parts, dpr }
```

**管线**：`background → notes → impact → keyboard → particles → post`，每层可单独开关/调透明度；
`renderer.stats()` 返回每层耗时（面板里可以显示"哪一层贵"）。

**门面 API**（实时与导出**只**走这个，保证同源）：

```js
const r = createVizRenderer();
r.configure(fxPanelState);              // 主题 + 层选项（增量合并）
r.render(ctx, cssW, cssH, song, tick);  // 内部处理 dpr/离屏/后处理
r.stats();                              // { background: 0.4, notes: 1.2, ... }
```

## 3. 借什么（逐项目 → 具体机制 → 落到哪个模块）

| 项目 | 它的机制 | 我们落到哪 |
|---|---|---|
| **MIDIVisualizer**（1291★, MIT） | 效果**参数化**：`--particles-count`/`--flashes-size`/`--out-alpha`；HDR 泛光后处理 | `layers/particles.js` 的预算参数、`layers/impact.js` 的闪光尺寸、`post/bloom.js`；`out-alpha` ↔ 我们的透明档 |
| **PianoWaterfall（Neothesia 分支）** | 左右手信息与图标；**fireworks 可开关**；GPU 渲染 | `themes.js` 的手色 + `layers/impact.js` 独立开关；GPU 路线放进 P3（见 §7） |
| **Keywaves** | **主题与配色风格**、命中高亮、命中处发光粒子 | `themes.js` 调色板/材质数据化（根治"换主题没区别"） |
| **Pianola**（GLSL） | 着色器级泛光/平滑 | `post/bloom.js` 的阈值 + 多级模糊；不够再上 WebGL 后处理 |
| **piano_video / 3d-piano-player / piano-opengl** | 真 3D 相机、钢琴机械 | 本轮不做；但 `layout.js` 预留 **camera{persp,tilt,vpx,vpy}** 参数 |
| **PianoRoll / ReactPianoPlayer** | 钢琴卷帘组件 | P3 的横向卷帘复用 `timeline.js` + 新 `layers/roll.js`（**不动现有瀑布流**） |

## 4. 层与选项清单（用户点名项已标★）

| 层 | 选项 |
|---|---|
| background | 档位（主题/纯色/图片/透明）、模糊、暗化、**暗场压角**、暗角强度 |
| notes | 开关、配色（轨道/音高/手）、白热内芯、圆角、落点光晕、键名（键上文字） |
| impact | 波纹、闪光（尺寸）、光柱（高度/强度）、冲击环、粒子数量/大小 |
| keyboard | ★**不透明度 0..1**、★**隐藏**、★**只显按键**、键高、透视强度、余辉、顶边高光、键名标注 |
| particles | 开关、预算、形状（点/星/烟花）、残留时间 |
| post | 泛光（强度/阈值/层数）、暗角、颗粒（可选） |

## 5. 迁移策略（**每一阶段都不破坏现有功能**）

| 阶段 | 内容 | 完成判据 |
|---|---|---|
| **1（半天）** | 抽出 `timeline.js` / `layout.js` / `palette.js`（**原样搬迁**，零行为变化）；`viz.js` 变门面 | 现有 `viz.test.js` 9/9 + 离线台出图与重构前**逐像素一致** |
| **2（半天）** | `layers/keyboard.js`：★不透明度/隐藏/只显按键/键高 | 面板里能拉 0..1、能隐藏；导出侧同效 |
| **3（1 天）** | 拆 `background/notes/impact/particles` + `post/{bloom,vignette}`；**默认主题带暗场** | 暗场对照图：音符与背景的明度差 ≥ 2 档；无回归 |
| **4（半天）** | `themes.js` 数据化（调色板 + 材质 + 参数），兼容读旧 `FX_THEMES` 与用户主题 | 换主题时**颜色真的变**（截图对照） |
| **5（半天）** | 清理门面；`viz.js` 只留兼容导出（供旧调用点） | `typecheck`/`test:ui`/`build:ui`/`deploy-installed` 全绿 |

每阶段一个提交 + 一次安装版验证（`deploy-installed.cjs` 冒烟 + 离线台三张对照图）。

## 6. 测试策略升级

现在的护栏是"**按填充类型猜**哪条 roundRect 是音符"（因为加了透视键盘后位置判别失效）——
这说明测试在**迁就实现**。重构后改成**分层调用序列断言**：

- 假 ctx 记录 `(layer, op, args)` 序列；断言：层顺序、每层是否被调用、音符块每块**恰好一次**。
- 新增 `frontend/tests/viz-layers.test.js`；旧的形状/填充判别退役。
- 仍然保留的两条硬底线：**可见块裁剪**（性能）与 **确定性**（同 tick 两遍 PNG 字节一致）。

## 7. 验收标准

1. **观感**：默认档在暗场下与参考缩略图并排对比，音符是画面里最亮的东西；提供 3 张对照图（亮背景/暗背景/两套主题）。
2. **功能**：琴键不透明度 0..1、隐藏、只显按键，**导出侧同效**（同一 store + 同一 renderer）。
3. **性能**：真机 1080p ≤ 8 ms/帧；`renderer.stats()` 能报每层耗时；4K 导出实测掉帧 ≤ 1%。
4. **可测**：分层调用序列测试通过；`typecheck`/`test:ui`/`build:ui`/冒烟全绿。
5. **同源**：实时与导出只有一个入口 `createVizRenderer()`。

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 重构期间"实时与导出不一致" | 门面**唯一入口**；每阶段都跑导出预览对照 |
| 观感反复（改了三版还在调） | 主题**数据化**：调观感 = 改数据，不改渲染代码 |
| 性能回退 | 每阶段真机测量（已有 rAF 采样与离线台两套工具） |
| 大改造成"半成品长期并存" | 阶段 1 就建立门面，旧函数逐步变薄壳，阶段 5 清干净 |
| 与既有导出链路冲突 | 导出的 opts 组装（zoom/colorScheme/fx）保持字段名不变，只换内部实现 |

## 9. 排期

```
阶段1 timeline/layout/palette 搬迁     0.5 天
阶段2 keyboard 层（★用户点名）        0.5 天
阶段3 层拆分 + post + 暗场            1.0 天
阶段4 themes 数据化                   0.5 天
阶段5 清理门面                        0.5 天
                            合计       3.0 天
```

## 10. 与本轮已完成内容的关系

- **保留**：击键波纹/光柱/闪光、粒子三类、白热内芯、透视键盘、泛光后处理、主题与参数面板、
  用户自定义主题存储 —— 它们是**行为**，重构后原样搬进对应层，不重写观感。
- **新增**：★琴键不透明度/隐藏（已在做）、只显按键、暗场压角、分层 stats、分层测试。
- **退役**：`drawVizWaterfall` 单体函数、`FX_THEMES` 的 diff 式主题、"按填充类型猜层"的测试。
