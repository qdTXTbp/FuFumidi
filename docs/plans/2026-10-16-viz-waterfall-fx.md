# 瀑布流视效升级方案 · v2（2026-10-16）

> **v1 → v2 的变化**：v1 只调研了商业软件（SeeMusic/Synthesia/DoraPiano/Echo Moss）。
> 用户补充了**开源项目清单**，v2 把它们逐个解析成真实仓库并读了 README，
> 据此重排路线图 —— 并新增了三条**只有开源实现才说得清楚**的做法（见 §3 的"借什么"）。

## 0. 一句话

把瀑布流从"能看"升级到 SeeMusic 那一档：**发光胶囊（白热内芯）+ 落键光柱 + 击键波纹/冲击环 +
3D 键盘 + 键名标注**；全部**开关化**（可一键回旧观感）、**实时与导出同源**（预览=成片）、
**逐帧可复现**。配色并入「视效」面板。**v2 新增路线**：性能档位、击键闪光（flash）、
后处理泛光、主题化配色、按手分色。

## 1. 目标与非目标

| | |
|---|---|
| ✅ 目标 | 观感对齐参考；每一笔可关（关掉**逐像素回旧观感**）；实时/导出同源；确定性；成本可测可调 |
| ❌ 非目标（另立） | 真 3D 透视键盘 / 钢琴内部机械、钢琴卷帘（横向）模式、MIDI 输入实时演奏、移动端 |

## 2. 开源项目调研（按 GitHub API 逐个解析，不是照抄清单）

| 项目 | 真实仓库 | 栈 / 许可 | 它证明了什么值得做 |
|---|---|---|---|
| **MIDIVisualizer** | `kosua20/MIDIVisualizer` **1291★** | C++ / OpenGL / **MIT** | 命令行参数**直接暴露了它的效果集**：`--particles-count`（1–512）、`--flashes-size`（0.1–3.0，**击键闪光尺寸**）、`--color-bg`、`--transparency`/`--out-alpha`（**透明背景导出**） |
| **Neothesia（现为 PianoWaterfall 分支）** | `captainerd/PianoWaterfall` | Rust / GPL-3.0 | README 写明增强点：**左手/右手信息与图标**（每轨/每手专属标识）、**"Shader Effects & Fireworks"：原发光效果 + 小粒子烟花，且设置里可开关** |
| **Keywaves** | `Nikhil618187/Keywaves-piano-visualizer` | Unity / ShaderLab | 卖点就是三件：**note 命中时琴键高亮**、**命中处带发光的粒子**、**像 SeeMusic 那样的主题与配色风格** |
| **KeyLight** | `OmniaX-dev/KeyLight` | C++ / GPL-3.0 | 存在（2★），README 只有构建说明 —— **不构成视觉参考** |
| **3d-piano-player** | `reality3d/3d-piano-player` **270★** | JS / three.js / MIDI.js / MIT | 3D 钢琴播放器；**形态与本工具不符，本轮不借** |
| **OpenGL-Piano** | `adowsky/piano-opengl` | C++ / OpenGL | 含击弦机构；同为 3D 形态，不借 |
| **piano_video** | `phuang1024/piano_video` 23★ | Python | 免费钢琴可视化（生成视频）—— 与本工具"导出成片"同路 |
| **PyPiano** | `FelixGSE/pypiano` 20★ | Python / GPL-3.0 | 是**演奏库**不是可视化器（抽象 python-mingus）—— 名字有误导 |
| **MidiViz** | `kavau/MidiViz` 4★ | Java / Android | 面向**入门教学**的键盘输入可视化 |
| **PianoRoll** | `theobourgeois/PianoRoll` 16★ | TypeScript / React | 钢琴卷帘组件（与 §9 的横向模式同类） |
| Pianola / WaveRoll / @minagishl/react-piano-roll / Midi-Virtual-Piano | — | — | GitHub 搜索**未匹配到**用户描述的那个仓库（可能改名/私有）。**不假装调研过** |

**商业软件**（v1 实测）：SeeMusic ✅2.7 s = 发光胶囊/键上光柱/击键线被顶起/光雾；Synthesia ✅0.83 s = 下落块 + 键名标签；
DoraPiano ✅10 s（WebGPU）= 3D 钢琴 + 体积粒子雾；Echo Moss ✅1.1 s = 产品形态；Lumiric Stage ❌ 超时。

## 3. 借什么、不借什么（v2 的核心）

| 来源 | 做法 | 我们借什么 | 落点 |
|---|---|---|---|
| MIDIVisualizer | `--particles-count` 1–512 | **粒子预算是个可调参数**（不是硬编码） | **P1：性能档位**（120 / 260 / 420） |
| MIDIVisualizer | `--flashes-size` | **击键闪光**应有独立的尺寸/强度旋钮 | **P1：impact flash + 强度档** |
| MIDIVisualizer | `--out-alpha` | 透明底是**导出的一等公民**，不是附带档位 | 已具备（透明档）；**P1 复核特效在透明档下的行为** |
| PianoWaterfall(Neothesia) | 左右手信息与图标 | **按手/按轨分色 + 图例** | **P2**（需分轨信息） |
| PianoWaterfall | fireworks 可开关 | **特效必须能开关**（我们已做成 6 开关） | ✅ 已完成 |
| Keywaves | 主题与配色风格 | **配色应成"主题"**（霓虹/极光/复古/单色） | **P2：配色主题化**（现为 4 档算法） |
| Pianola（GLSL，未确认仓库）/ MIDIVisualizer | HDR **泛光**（bloom）是画质分水岭 | **后处理泛光**：离屏 1/2 分辨率提亮 + 模糊 + 叠加 | **P2：泛光后处理**（比逐元素 shadowBlur 更"高级"且成本可控） |
| 3d-piano-player / piano-opengl | 真 3D | **不借**：形态不符、每帧成本高 | 记入 P3"野心项" |

## 4. 五种主流样式 × 取舍（v1 结论沿用）

| 样式 | 取舍 | 现状 |
|---|---|---|
| 音符下落 | ✅ 升级 | 胶囊圆角 + **白热内芯** + 落点光晕 + 下落边高光 |
| 粒子与光效 | ✅ 升级 | 加色混合 + 贴图发光 + 火花/**冲击波环**/光柱 |
| 3D 键盘 | ✅ 做"厚度版"（真透视不做） | 键面+前脸+顶边高光+**按压下沉**+按键向上洒光 |
| 钢琴卷帘 | ⏳ 不做（是另一种可视化） | P3 |
| 琴键高亮反馈 | ✅ 增强 | 余辉 + 光柱 + **击键线半圆波纹** |

## 5. P0 已完成（本轮，可直接评审）

**代码**（`c832b600` 已推送）

- `core/viz.js`：`FX_DEFAULTS`（**单一来源**）= `keys3d/particles/beams/hitLine/gloss/keyNames`；
  粒子 2.0（加色混合 + 按颜色缓存的 64×64 发光贴图 + 三类粒子，上限 260→420）；
  3D 键盘（键区 72% 键面 + 28% 前脸 + 顶边高光 + 按压下沉）；击键线脉冲光带 + **半圆波纹**；
  音符白热内芯 + 胶囊圆角；光柱**三层嵌套渐变**（单层左右硬边，离线台实测像红纸条）。
- `stores/vizbg.ts`：fx 与背景**同一个 store / 同一个 localStorage 键** → 实时与导出同源。
- `views/ViewViz.vue`：新增「视效」面板；**配色（4 档）从工具栏并入该面板**（用户要求）；含**全开/全关**。
- `views/ViewConvert.vue`：导出走同一份 `fxOpts()`（否则又会"预览与成片两幅画"，背景那次已踩过）。

**证据**

- 单测 `frontend/tests/viz.test.js` **9/9**，守着两条硬不变量：
  ① 每个屏内块**恰好一次 `roundRect`** 且填充仍是**调色板纯色** → 新效果只能用 arc/fillRect/渐变叠加；
  ② **第一个 `y === wN` 的 `roundRect` = 琴键起点** → 3D 键面必须仍从 wN 起（按压下沉靠缩短键面实现）。
- 门禁：`typecheck` / `audit` / `test:ui`(**225**) / `build:ui` / `deploy-installed` 冒烟 全绿。
- **离线渲染台**（`E:\Midi\_attic\vizrender\render.mjs`，`@napi-rs/canvas` 跑真实 `drawVizWaterfall`）出 `fx-on.png`/`fx-off.png`。
  为什么需要它：安装版截图受**窗口遮挡不重绘**影响，`Page.captureScreenshot` 连着 5 次拿到旧帧；离线台还能逐帧复现。
- **成本**（离线台 @1920×1080，200 帧）：旧观感 **3.98 ms/帧** → 全开 **9.19 ms/帧**（**2.31×**）。

## 6. 路线图

### P1 · 收敛与可调（建议下一步，1–2 天）

| 项 | 内容 | 验收 |
|---|---|---|
| **性能档位** | 仿 MIDIVisualizer 的 `--particles-count`：粒子预算 120/260/420 + 特效强度 0.6/1.0/1.3；导出侧按档位自动降 | 4K 导出 24fps（**41 ms/帧**预算）下全开档 ≤ 41 ms；中档 ≤ 28 ms |
| **击键闪光** | 仿 `--flashes-size`：击键瞬间键面白闪 + 尺寸/强度可调 | 与参考缩略图并列对比可见"闪光"这一层 |
| **透明档复核** | 透明档下粒子/光柱/波纹都必须是**加色半透明**、不得出现实心块；导出 PNG 的 alpha 正确 | 透明档导出 PNG：背景 alpha=0，键盘与光效 alpha>0 |
| **安装版目视** | 切「可视化 → 瀑布流」三档各看一遍 | 无未捕获异常；`deploy-installed` 冒烟通过 |

### P2 · 观感再上一层（值得做，2–4 天）

| 项 | 内容 | 借自 |
|---|---|---|
| **后处理泛光** | 离屏 1/2 分辨率 → 阈值提亮 → 两次模糊 → 加法叠回。替代逐元素 `shadowBlur`（后者在 4K 下是主要成本） | Pianola / MIDIVisualizer 的 bloom |
| **配色主题化** | 把现有 4 档算法扩成命名主题（霓虹 / 极光 / 复古 / 单色），每套含背景+键面+粒子色 | Keywaves「themes & color styles like SeeMusic」 |
| **按手/按轨分色** | 左右手不同色 + 键上图例（需分轨/分手信息；无信息时退回按轨） | PianoWaterfall「Left/Right Hand Info」 |
| **音频反应粒子** | 用现成 `rmsAt` 驱动粒子爆发强度与光柱高度（现在只驱动背景光晕） | 参考片里"随音乐炸开"的观感 |

### P3 · 野心项（单独立项，不在本轮）

钢琴卷帘（横向时间轴 + 左侧竖键盘，参考 `theobourgeois/PianoRoll`、ReactPianoPlayer）、
伪 3D 相机（整幅轻微透视）、WebGL/GLSL 渲染器（把 GLSL 泛光做到实时）、真 3D 钢琴（`reality3d/3d-piano-player`、`adowsky/piano-opengl` 那条路）。

## 7. 待你定的决策

| # | 决策 | 建议 |
|---|---|---|
| **D1** | 新视效默认全开？ | **是**（有「全关」兜底） |
| **D2** | 做性能档位？ | **是**（P1 第一项；4K 预算很紧） |
| **D3** | 键名标注默认？ | **关**（教学时再开） |
| **D4** | 立刻做钢琴卷帘？ | **否**，P3 单独立项 |
| **D5** | 按手/按轨分色？ | **P2**，等确认曲库有分手信息再动手 |
| **D6** | 真 3D 透视键盘？ | **否**（P3） |
| **D7（新）** | 后处理泛光是否值得为它改渲染管线？ | **是**（P2 首项，画质提升最大的一笔） |
| **D8（新）** | 配色做成命名主题？ | **是**（P2，把 4 档算法包装成主题，不破坏现有开关） |

## 8. 验收标准（每次回归照这个跑）

1. `node --test frontend/tests/viz.test.js` **9/9**（两条不变量不能破）。
2. `npm run typecheck / audit / test:ui` 全绿；`npm run build:ui` 通过；`deploy-installed.cjs` 冒烟通过。
3. **像素对照**：`node E:\Midi\_attic\vizrender\render.mjs` → `fx-on` 与 `fx-off` 肉眼可辨；**全关 == 升级前**（逐像素）。
4. **确定性**：同一 tick 跑两遍 PNG **字节一致**（禁 `Math.random`，随机量全走 `noise(seed)`）。
5. **同源**：任一开关在「可视化」页改动，导出预览立刻同效。
6. **成本**：1080p 全开 ≤ 12 ms/帧；4K 全开档 ≤ 41 ms/帧、中档 ≤ 28 ms/帧（P1 补测）。
7. **透明档**：导出 PNG 背景 alpha=0，且光效不被截断。

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 逐帧成本（渐变/粒子） | 贴图缓存；粒子上限；三层光柱只在短命粒子期；**P1 性能档位**；**P2 泛光后处理替换 shadowBlur** |
| 视觉过载 | 默认强度保守；「全关」一键回退；键名标注默认关 |
| 参考站/仓库不可达或改名 | 关键画面已落 `_attic\vizref`（22 张）+ 各仓库 README；**未匹配到的项目明确标注"未调研"**，不编造 |
| 预览与成片不一致 | 所有开关与背景同走 `stores/vizbg` |
| 破坏既有不变量 | 单测注释与 §8 第 1 条写死：新效果只能用 arc/fillRect/渐变，块本身一次 roundRect + 纯色 |

## 10. 附：本方案用到的可复现资产

| 路径 | 内容 |
|---|---|
| `E:\Midi\_attic\vizref\` | 22 张参考截图 + 各仓库 README 原文 + `summary.txt`（本方案的调研原始记录） |
| `E:\Midi\_attic\vizrender\` | 离线渲染台 `render.mjs`（出 PNG）与性能台 `bench.mjs`（ms/帧） |
| `frontend\tests\viz.test.js` | 两条硬不变量的护栏 |
