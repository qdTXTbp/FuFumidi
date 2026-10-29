# FuFumidi 前端 / UX / 布局 / 可访问性审计

- 审计对象：E:\Midi\FuFumidi-Source（Electron + Vue3 + Python 引擎），前端范围 frontend/src（24 个 views、40 个 components、4 个样式层、路由、store、i18n）
- 审计时间：2026-10-29
- 审计方式：**只读静态审计**（全量通读 + 脚本度量 + 交叉引用）。未启动应用、未做截图比对、未跑屏幕阅读器 —— 涉及“运行时才能看到”的结论均已标注**待实测**，并在第 8 节给出可执行验收步骤。
- 代码规模：frontend/src 共 180 个文件；views/ 23 个视图 33,740 行（含 App.vue 1,045 / styles.css 1,889 / SideBar.vue 1,391 / SettingsPanel.vue 1,997）
- 分级：**P0** 默认配置下明显坏掉或阻断；**P1** 显著摩擦 / 目标用户可直接感知；**P2** 一致性与打磨。工作量以 1 名熟悉本仓库的前端计（人日）。

---

## 0. 执行摘要

这不是一个“从未做过 UX 工作”的代码库：已有 token 层（styles/tokens.css）、控件契约层（styles/controls.css）、焦点陷阱指令（directives/focusTrap.js）、prefers-reduced-motion 双保险（tokens.css:113、styles.css:1581）、scrollbar-gutter: stable（styles.css:274）、4,336 条英文 + 4,443 条日文词条；视图层颜色基本已走 token（整个 views 只有约 120 处字面色值，且多在 canvas 绘制代码里）。

问题集中在三处**系统性**的地方，而不是零散像素瑕疵：

1. **同一件事有两个入口、两套状态**：界面缩放两套（CSS zoom + Electron webFrame）、外观两套（设置里的「外观」段 + 独立「外观抽屉」）、主题 4 个入口、壁纸 6 个入口。已产生 P0 级缺陷（§2.1）。
2. **核心工作区在默认窗口尺寸下就被裁切**：编辑器主工具条按代码自带注释在 1585px 窗口时已看不到最右按钮，而默认窗口是 1280（§2.2）。
3. **可访问性基本缺位**：24 个视图合计只有 9 个 aria-label、2 个 role=；曲目列表、歌单、轨道、混音 M/S、设置单选段全是 div/span @click（§5）。

### 评分卡（10 分制，横向比较用）

| 维度 | 分数 | 一句话理由 |
|---|---:|---|
| 信息架构 / 导航 | 5.0 | 三组页签模型清楚，但入口在不同位置各说一套（rail / 首页 / 顶栏旧菜单 / 引导文案互不一致） |
| 布局与溢出 | 4.5 | 编辑器工具条默认窗口即溢出；其余页面靠 flex-wrap 与 min-width:0 兜住 |
| 响应式 | 4.0 | 43 条媒体查询 / 33.7k 行；窗口下限 980×640，但缩放叠加后等效宽度会掉到 600 级 |
| 设计令牌一致性 | 6.5 | token 层存在且大量采用，但契约（28px 命中区、6 档字号）被多处就地覆盖 |
| 重复控件 / 死控件 | 4.5 | 外观面板两套；v-if="false" 整条控制条；首页 6 个快捷入口与“保存工程”从未渲染 |
| 空状态 | 6.0 | 大部分列表有「暂无…」，但可视化页无曲目时是空白画布 |
| 错误反馈 | 5.5 | 转录/分离链路做得好（日志 + toast + 重试），但 361 处 catch {}，设置保存成功提示是死分支 |
| 键盘 / 焦点 / ARIA | 3.0 | 56 个浮层里 41 个无 role=dialog、53 个无焦点陷阱、95 处不可聚焦的 @click |
| 动画 / 性能 | 6.0 | rAF 有尺寸守卫（EditorCanvas / PianoRoll 都写了），但双层 KeepAlive 让 12 个重视图常驻 |
| 暗色 / 浅色 | 6.5 | 主题系统真在跑（core/theme.js 运行时写内联变量），但 --t-* 语义色几乎没人用、文档与实现不一致 |
| 文案 / i18n | 5.0 | 159/3,489 条中文键无英/日翻译（4.6%），且句子拼接导致一部分永远翻不了 |
| 可用性风险 | 5.5 | 混音台 per-track 外观 → per-channel 实际效果；「取消」不撤销；专家模式开关几乎无效 |

---

## 1. 度量口径（可复现脚本见 §9）

| 指标 | 数值 | 口径 |
|---|---:|---|
| .vue/.css/.js/.ts 文件 | 180 | frontend/src 全量 |
| 字面色值 #hex / rgba() | 503 / 354 | 132+46 在 core/theme.js（合法：调色板源头）、53+73 在 styles.css（合法：旧令牌兜底） |
| 写死像素字号 font-size: NNpx | **1** | 字号阶迁移是成功的 |
| div/span/li/tr 上的 @click | **95** | 不可键盘触发 |
| 媒体查询 | **43** | 覆盖 33.7k 行视图代码 |
| 浮层/遮罩容器 | 56 | 无 role=dialog：**41**；无 v-focus-trap：**53**；无 Esc：**45** |
| 仅用 placeholder 当标签的 input | **68** | 无 aria-label / id / 关联 label |
| 无名称的图标按钮 | 12 | 无 aria-label 且无 title |
| 静默 catch {} | **361** | catch (e) {} 形态 |
| 中文 i18n 键 | 3,489 | 英文缺 **159**、日文缺 **159**（同一批） |
| views/ 内 aria-label / role= | **9 / 2** | 24 个文件合计 |

---

## 2. P0（默认配置下即坏）

### P0-1 「界面缩放」有两套实现，且会相乘

证据链（三处独立代码同时成立）：

1. stores/workspace.ts:36,38 定义 layout.scale 与 SCALES = [0.9, 1, 1.15, 1.3]；编辑器「视图」菜单经 ViewEdit.vue:477-481（ws.layout.scale = v）写入，菜单文案就在 ViewEdit.vue:533（「界面缩放：115%」）。
2. App.vue:24-29 监听它并**无条件**写 document.documentElement.style.zoom：

       const ws = useWorkspace();
       watch(() => ws.layout.scale, (v) => {
         const s = Math.max(0.9, Math.min(1.3, Number(v) || 1));
         document.documentElement.style.zoom = String(s);
       }, { immediate: true });

3. 另一套：core/display.js:36-57 的 applyUiScale() 优先调 bridge.setZoomFactor(s)（Electron 真缩放，会缩小布局视口 → 媒体查询按缩小后的宽度求值），浏览器回退才用 CSS zoom。它由 SettingsPanel.vue:1339（界面缩放 NumSlider）与 AppearancePanel.vue:199（setUiScale）驱动。

**后果**：两个控件同名「界面缩放」，写两个不同 store，互不显示对方的值，而效果叠加。编辑器选 115% + 设置选 130% → 等效 1.495 倍：980px 最小窗口的布局视口掉到约 655px，@media (max-width: 1120/1000/900) 全部触发，编辑器检查器被压到 176px（ViewEdit.vue:3281-3282）、工具条溢出更严重、brand.css:302 把整个曲目标签栏隐藏。用户在任何一个入口都看不到“总共放大了多少”，也没有单一位置能一键回 100%（设置里的「还原 100%」在 SettingsPanel.vue:1341，它不清 ws.layout.scale）。

**修法**：单一来源。以 core/display.js 的 ui_scale 为唯一真源（真缩放、有 devicePixelRatio 联动），把 ws.layout.scale 迁移成它的别名（读时归一化、写时转发），删除 App.vue:24-29 的 CSS zoom 写入与 data-ui-scale 双写；SCALES 的 1.15 与 display 的 0.05 步进统一。迁移旧 workspace JSON 时把 scale 读到 ui_scale 后清零。

**工作量**：0.5–1 人日（含迁移 + 回归用例）。**验收**：改任意一处，另一处同步显示；document.documentElement.style.zoom 恒为空；130% 下 980×640 无横向裁切。

### P0-2 编辑器主工具条在**默认窗口**就溢出，且没有溢出提示

- ViewEdit.vue:3270：.ed-toolbar { display:flex; flex-wrap: nowrap; overflow-x: auto; … } —— 单行不换行、只能横向滚动；同样的规则也用于上下文任务条 ViewEdit.vue:3466。
- 工具条按钮在 2336-2404 行，约 19 组（选择/画笔/橡皮/静音/录音/步进/钢琴/鼓组/乐谱/撤销/重做/删除/量化/参数工具/检查器/全屏/谱面底图/更多）。
- **代码自己在 ViewEdit.vue:2414-2415 承认**：「视图开关在『更多』里也放一份：主工具条在窄窗口会横向溢出，最右边的这几个开关会滑出可视区（实测 1585px 宽时『全屏』已看不见）。」
- 窗口默认 1280、最小 980（main/window.js:11-14）。1280 下 .app-main 宽 = 1280 − 64（rail）− 240（侧栏）= 976；.edit-view 左右各 22px padding（ViewEdit.vue:3268）→ **可用 932px**。按上述实测反推工具条自然宽度 > 1237px → 默认窗口下约 **300px 被裁在滚动区外**。
- 补救手段是「在『更多』里再放一份」（2418-2427），即检查器 / 全屏 / 谱面底图 各有两个按钮（2393-2400 与 2418-2427）—— 这本身就是 §4 的重复控件问题。
- overflow-x:auto 在这条 26px 高的条上会带一条滚动条（Windows Chromium 经典滚动条约 10px），把工具条压成“半截高度”，且**没有任何渐隐/箭头提示**可横向滚动。

**影响**：主编辑工作区（/views?tab=edit）默认打开即可见裁切；用户不知道右边还有按钮，只能靠“更多”猜。

**修法**：(a) 立刻改两行布局 —— 按语义拆「工具 | 视图 | 编辑 | 更多」两行（或 flex-wrap: wrap + 第二行右对齐），去掉 overflow-x；(b) 删除「更多」里的三个重复开关（检查器/全屏/谱面底图），保留主条一份，更多只放低频动作。**工作量**：1.5 人日（含 980/1280/1585 三档截图比对）。

---

## 3. P1

### P1-1 设置里的「外观」页签不存在，但代码、搜索索引、校验器都当它存在

- SettingsPanel.vue:55-63：TABS = sound / gpu / feature / keys / cloud / update / feedback —— **没有 appearance**。
- SettingsPanel.vue:1260-1358：整套「外观」设置段（界面模式、主题、壁纸、强调色、字号、密度、缩放、语言 8 个 field-row，约 100 行）仍以 v-if="tab === 'appearance'" 挂着。
- core/settings_index.js:13-19：**7 条搜索索引指向 tab: 'appearance'**（界面模式 / 强调色 / 字号 / 密度 / 界面缩放 / 动态壁纸 / 语言）。
- 全仓库**没有任何地方**设 state.ui.settingsTab = 'appearance'（已 grep；只有 gpu / sound / feedback / update 被显式设置）。唯一到达路径是“设置搜索 → 点结果”（SettingsPanel.vue:71-85）。
- 到达后的状态：TABS 无该项 → .ov-tab 没有任何 .active → moveInd()（SettingsPanel.vue:123-131）查不到 .ov-tab.active 直接 return，指示条停在上一个页签位置，视觉上“当前页签 = 声音”，内容却是外观。
- core/settings_index.js:87 的校验器 allowed 默认集**仍包含 'appearance'**，所以这个错配被测试掩盖。
- 另有 **14 条索引项在面板里没有 data-setting 锚点**（实测锚点只有 8 个：theme / ui_scale / engine_mode / perf_mode / expert_mode / ai_mode / watch_dir / download_source）。点这些结果会切页签后**静默不滚动**（gotoSetting 在 !el 时 return，无反馈）。

**影响**：22 条可搜索设置里 7 条把人送进“不存在的页签”，14 条点了没反应；核心设置（主题/字号/语言）在设置面板里成了隐藏区域。

**修法**（建议 B）：A. 把 appearance 加回 TABS（SettingsPanel.vue:55-63）并删掉头部「外观」按钮（1216）；B. 删除设置里的外观段（1260-1358）与 7 条索引，全部指向 AppearancePanel，并把索引 tab 改成 open: 'appearance' 这种“动作型”目标。两者都要顺手：给 validateSettingsIndex 传真实 TABS，并对缺锚点条目补 data-setting 或在 gotoSetting 里 toast 提示。

**工作量**：0.5 人日（B 案 + 索引修正）；1 人日（含补齐 14 个锚点）。

### P1-2 外观相关入口重复 6 处、面板重复 2 套

| 目标 | 入口 |
|---|---|
| 外观抽屉 | PrimaryRail.vue:22,43（palette）· TopBar.vue:60（菜单已删，函数还在）· SettingsPanel.vue:70,1216 · ViewHome.vue:227 · GuideOverlay.vue:76,77 |
| 主题库 | AppearancePanel.vue:74,122 · SettingsPanel.vue:1284 · TopBar.vue:58（死）· CommandPalette.vue:55 |
| 壁纸库 | App.vue:394 · SettingsPanel.vue:1293 · ThemeLibrary.vue:145 · TopBar.vue:59（死）· ViewConvert.vue:453 · ViewViz.vue:158 |

更有害的是**两套实现并存**：AppearancePanel.vue:121-203（抽屉，主题卡 + 分段 + 滑块）与 SettingsPanel.vue:1260-1358（field-row 表格式）覆盖同一批设置，但**行为不同**：

- 抽屉的字号/密度/缩放只写 localStorage（AppearancePanel.vue:51-53 → core/display.js:68-70），**不写 settings**；设置面板的 applyDisplay 会 saveFontSize / saveDensity / saveUiScale 并 settingsStore.save(payload)（SettingsPanel.vue:251-258、1174）。换机器 / 云同步时两边结果不一致（core/display.js:60-63 的注释也承认这个“localStorage 优先 + settings 兜底”的复杂性）。
- 抽屉里「减少动态效果」（AppearancePanel.vue:93-97）同样只写 localStorage，无 settings 兜底。

**修法**：保留抽屉为唯一外观入口（它已是 rail 常驻入口），删除 SettingsPanel 外观段（与 P1-1 B 案合并），抽屉写入统一走 settingsStore.save（与语言分支 AppearancePanel.vue:54 一致），删掉 TopBar 死函数与死 CSS（§4.1）。**工作量**：0.5 人日。

### P1-3 键盘可用性断层：95 处不可聚焦的 @click

代表性位置（全部是 div/span + @click，无 tabindex、无 role、无键盘处理）：

- 曲库主列表 SideBar.vue:865-899：.song-item 是 div，@click 选中 / @dblclick 播放 —— **键盘用户无法选歌、无法播放**，这是应用最核心的列表。
- 歌单与智能视图 SideBar.vue:807-818（全部曲目/收藏/最近/最常）。
- 唱声轨列表 ViewSing.vue:2290-2301（.trk-item 为 div + @click）。
- 唱声轨 M/S/量化/加组等 ViewSing.vue:2925-2957（span.rs-ib 十个按钮）。
- **设置面板单选段全部是 span**：SettingsPanel.vue:1268-1271（深浅模式）、1313-1315（字号）、1326-1329（密度）、1351-1354（语言）、1779-1780（更新通道）、1792-1794（下载源）。
- 资源页下载渠道 ViewResources.vue:649-650。
- 拖放区 ViewTranscribe.vue:2048,2057（.tr-drop 为 div，点击选文件）、ViewScoreConvert.vue:642（.sc-dropzone）。

**修法**：统一改 button type="button"；列表项用 role="option" + tabindex="0" + @keydown.enter/.space（容器 role="listbox"，SideBar.vue:864 现有 role="list" 可改 listbox）。建议做 v-clickable 指令统一补 tabindex/role/键盘 → 比逐处改快。**工作量**：2–3 人日（95 处形态高度同构，指令化后 0.5 天铺完，剩下是逐视图回归）。

### P1-4 浮层语义：56 个里 41 个无 role=dialog、53 个无焦点陷阱、45 个无 Esc

directives/focusTrap.js 本身是好的（Tab 循环 + 打开时聚焦首元素），但**只用在 3 处**：CommandPalette.vue:127、SettingsPanel.vue:1211、WallpaperGallery.vue:160。

- App.vue:921,941 全局 confirm/prompt 与导入歌单选择：有 role=dialog 但无 v-focus-trap；Esc 绑在遮罩 div 上（@keydown.esc），只有遮罩**内部**有焦点时才生效 —— 弹窗刚打开时焦点还在被点按钮上，**Esc 实际不生效**。
- AppearancePanel.vue:108-109：外框无 role（内部 aside 有）；**无 Esc**，且 App.vue:494-503 的全局 Esc 白名单没有 appearanceOpen / wallpaperOpen → 外观抽屉**按 Esc 不关**。
- ThemeLibrary.vue:98-99、GuideOverlay.vue:143、ChangeLogOverlay.vue:14：均无陷阱。
- ViewEdit.vue 的 12 个弹窗（2859 / 2881 / 2899 / 2922 / 2952 / 2979 / 3011 / 3058 / 3117 / 3137 / 3154 / 3168 / 3190）：**全部**无 role、无 aria-modal、无陷阱；关闭按钮还用 Icon name="minus" 冒充（2863 / 2885 / 2903）。
- PlayerBar.vue:329,363,397（混音台/音色/音效）、ViewModels.vue:310、PluginCenter.vue:292、ViewScore.vue:928,957、ViewTranscribe.vue:2205,2612、ViewLyrics.vue:452、SideBar.vue:1033,1044（右键菜单应加 role=menu）。
- TaskCenter.vue:175 面板有 role=dialog 但无 aria-modal、无陷阱、无 Esc（App.vue:494 白名单也没它）。

**修法**：把「Esc 关闭」收进一个全局 ui.closables 栈（谁在最上层谁响应），而不是散在 45 个遮罩上；浮层统一 v-focus-trap；补齐全局白名单。**工作量**：1.5 人日。

### P1-5 输入框只有 placeholder 当标签（68 处），含密码框

- CloudUserDialog.vue:140-141：邮箱与**密码**输入都只有 placeholder（type="password"），无 aria-label、无关联 label、无 autocomplete。
- SettingsPanel.vue:1220（设置搜索无名称）、1439 / 1460（反馈表单）、1583 / 1593 / 1616 / 1851（路径类）。
- App.vue:961（新建歌单名）、SideBar.vue:801、CommandPalette.vue:129、PlayerBar.vue:371（音色搜索）、TaskCenter.vue:187（任务搜索）。
- 全量 68 处；已带 aria-label 比例很低（SideBar.vue:753,944 是好模板）。

**修法**：placeholder 保留为示例，另加 aria-label 或 label for。可加 lint（§7）。**工作量**：0.5 人日。

### P1-6 i18n 缺口 4.6%，且有一部分结构上不可翻译

- 度量：界面用到 3,489 个中文键；**159 个在 core/i18n.js（英）与 core/i18n_ja.js（日）里同时缺失**（4.6%），回退即中文。
- 集中度：ViewSing.vue 45 条、ViewScoreConvert.vue 33、ViewEdit.vue 17、ViewResources.vue 17、ViewTranscribe.vue 14、core/cloudSync.ts 12、sing/VoicebankPanel.vue 11、SettingsPanel.vue 8、SideBar.vue 8。样例：'已渲染'、' 条原音设定'、'确定从本歌单移除选中的'、'改'。
- 更根本：**句子被拆成片段拼接**，天然翻不了：
  - SettingsPanel.vue:1919-1922：t('上传 ') + n + t(' 曲 / ') + m + t(' 单，下载 ')…
  - ViewTranscribe.vue:1058-1062：t('共 ') + n + t(' 首 · 完成 ')
  - ViewScore.vue:896, 911：t('（') + n + t('），') + t('简谱仅显示前')
  - App.vue:373-374、TaskCenter.vue:207、ViewSing.vue:2355 同类
- 硬编码文案：ViewScore.vue:943 alt="score page"；ViewResources.vue 的 'homr（AI 识谱）'；SettingsPanel.vue:1758「许可与溯源」按钮塞进 .fr-hint（继承灰色小字）。
- 项目规则（core/i18n.js:1-17、AGENTS.md）是「中文必须 EN + JA 同时补」—— 目前 **159 条不合规**。

**修法**：(a) 拼接句改整句模板（t('上传 {n} 曲 / {m} 单') + 参数插值），至少把整句作为一个键；(b) 补 159 条翻译；(c) CI 跑“中文键 ⊆ EN ⊆ JA”（脚本见 §9）。**工作量**：拼接重构 1 + 翻译 1.5 + 门禁 0.5 = 3 人日。

### P1-7 混音台：per-track 外观，per-channel 实际效果

PlayerBar.vue:335 的说明写得很清楚：「音量/静音/独奏/声像作用于 MIDI 通道：同一通道上的多条轨会一起变化」。但 UI（337-359）是**每轨一行**、每行独立滑块/M/S（348-357），没有“这两行同属 Ch 3”的可视分组或联动提示。用户以为只降了轨 2，实际同通道的轨 5 一起降 —— 混音结果与预期不符，且界面无法纠正。

**修法**：短解 —— 行标题加通道徽标（Ch 3）、同通道行同色带 + 联动提示，共享控件显示“联动”；根治 —— 给播放器加每轨增益节点（core/track_fx.js 已有基础）。**工作量**：短解 0.5；根治 3–5（需引擎配合）。

### P1-8 「专家模式」开关基本无效

- 承诺：SettingsPanel.vue:1560-1561「打开后显示 OMR / 翻唱 / GPU 等高级入口；关闭时界面保持精简」。
- 实际生效只有三处：CommandPalette.vue:33、ViewResources.vue:733,815、TopBar.vue:18-19（而 TopBar 的导航标记已不存在，见 §4.1）。
- 反例：ViewTranscode.vue:14-22 页签把「翻唱」「调教」硬写在数组里，不走 visibleViews；ViewTranscribe.vue:2041「GPU 加速」按钮无条件显示；PrimaryRail.vue:13-19 与 SideBar.vue 完全不看 advanced_mode。

**修法**：让导航真正消费 expert.js（ViewTranscode 的 tabs 用 visibleViews 过滤，GPU 按钮加 v-if），或把文案改成它真实的作用。**工作量**：0.3 人日。

### P1-9 空状态：可视化页无曲目时是空白画布

- ViewViz.vue:705-741：.vc-body 只有一个 canvas；无曲目时无任何提示（全文件 暂无/还没有/没有可/空态 命中 **0** 次）。
- setImmersive() 在无曲目时**静默 return**（ViewViz.vue:419-421），点「沉浸模式」毫无反应；按钮 disabled（582）但没有说明原因。
- ViewVoicebank.vue 亦无空态文案（segments 为空时表格空白）。
- 好样板：ViewEdit.vue:2317-2321（无曲目卡 + 说明 + 导入指引）、ViewSing.vue:2232-2256（空态只留一个主操作，注释 2242-2243 明确写了“同文案同功能到处都有”的教训）、ViewTranscribe.vue:2246（三种“没有模型”文案分别指向不同动作）。

**修法**：ViewViz 画布区加覆盖层空态（“载入一首曲目后这里会显示音符瀑布” + 「去曲库」）；ViewVoicebank 加空表提示。**工作量**：0.3 人日。

### P1-10 错误反馈：设置保存**成功**提示永远是死分支

SettingsPanel.vue:1173-1184：

       let saved = false;
       settingsStore.save(payload).then(() => { if (!saved) toast(t('设置已保存')); })
                                   .catch(() => toast(t('设置保存失败'), 'error'));
       saved = true;                     // 同步置 true，then 回调里恒为真
       if (!saved) toast(t('设置已保存（仅本次会话）'));   // 永不执行

结果：保存成功**没有任何反馈**（只有面板关闭），失败才有 toast，用户无法区分“存上了”和“面板关了”。同类：AppearancePanel.vue:64-66 的 saveWp 用 catch {} 吞失败；全仓 **361 处 catch (e) {}**（部分是可选路径合理静默，但 App.vue:49-59 这类把整段初始化包进 try 的也不少）。

**修法**：修 saved 标志（或用 await）；saveWp 加失败 toast；静默限定在确实无关紧要的路径并加注释。**工作量**：0.2 人日。

---

## 4. P2

### 4.1 死代码 / 死控件（可直接删）

| 位置 | 内容 | 说明 |
|---|---|---|
| ViewHome.vue:33-44 | QUICK 六个快捷入口数组 | 模板只用 216-232 的 3 个硬编码卡片；调教 / 插件中心入口从未渲染 |
| ViewHome.vue:71-100 | saveProject() 完整实现（encodeMidi + .fufu 工程） | 模板无引用 → **首页无法保存工程**，只有 openProject 能开 |
| TopBar.vue:18,44,49-76,93-135 | PRIMARY_NAV、ICONS、menuOpen、7 个 open 函数、.menu-pop 全套 CSS | 模板（79-91）只剩后退/前进 + 曲目标签；一级导航标记已删，只剩 hidden-nav-marker（89） |
| styles/brand.css:158-167,290-300 | .topbar-crumbs、.topbar-search（含 2 条媒体查询）、.topbar-tabs-slot .group-tabs | 三个选择器在 .vue 里零引用 |
| AppearancePanel.vue:225 vs 274 | .ap-drawer 两次声明宽度，后者 !important | 前者是死声明 |
| ViewScore.vue | .score-view 971 与 1069、.score-toolbar 972 与 1080、.score-scroll 1001 与 1100、.score-legend 1017 与 1102、.zoom-fab 986 与 1098 全部重复 | “6.2.0 重排”块叠在旧块上；两处 flex-wrap 互相矛盾（976 nowrap vs 1080 wrap） |
| ViewViz.vue:569-571, 589-615 | v-if="false" 的「背景」按钮与整条背景控制条（13 个控件） | 功能已搬到 AppearancePanel.vue:139-193，代码未删 |
| ViewConvert.vue:1016-1018 | select v-model="range" disabled 只有一个选项「整首歌曲」 | 死控件 |
| ViewPlaceholder.vue | 整文件 | 无路由指向 |
| core/expert.js:24-27 | visibleViews | 生效点只剩 CommandPalette（TopBar nav 已删） |

**工作量**：0.5 人日（删除 + 跑现有测试）。

### 4.2 状态显示与真实状态脱节

- ViewHome.vue:203：`<span class="tag ok">{{ t('可用') }}</span>` 与「系统就绪」是**写死的**，不看 state.integrity.ok（App.vue:286-290 已算出，SettingsPanel.vue:1240-1255 会展示问题）。完整性检查失败时首页仍报“可用”。
- ViewHome.vue:206「运行模式 离线」也是常量。
- TaskCenter.vue:94-96 的 STATUS_LABEL / KIND_LABEL 是中文常量再过 t()，能工作但绕；新增状态会静默显示原始英文 id（209 行）。

**修法**：首页状态卡接 state.integrity + gpuInfo，把三个常量行换成真实信号（引擎版本 / 加速状态 / 曲库数）。**工作量**：0.2 人日。

### 4.3 响应式：43 条媒体查询覆盖 33.7k 行

- 窗口下限 980×640（main/window.js:13-14），styles.css:1727 注释也把 980 当设计下限。但外壳网格（styles.css:216-228）在 980 下永久占掉 64 + 240 = 304px，主区 676px，减 .page 左右 22px 后 **632px**；ViewEdit 还要放 176px 检查器（3282）→ 卷帘只剩约 440px。
- brand.css:302：@media (max-width:1000px) { .topbar-tabs-slot { display:none } } —— **最小窗口（980）下曲目标签栏整条消失**，而 SongTabs.vue:124 精心做的「更多 N」折叠在 1000px 以下根本看不到。
- PlayerBar 的收缩策略（styles.css:1732-1748）依次隐藏标题 / BPM / 前两个右侧按钮 —— 方向正确，但被隐藏的 MIDI 硬件输出在窄窗口下再无入口（注释说“仍可在设置与工具栏中访问”，实际只在这个按钮上）。
- 侧栏可拖宽 200 起（stores/app:64-65, 1314-1318），拖到最大没有与主区联动的上限；SideBar.vue:50 的 window.innerWidth - 360 只是拖拽时的临时上限。

**修法**：把外壳纳入响应式：≤1100px 侧栏自动折叠（side-collapsed 已有类）；≤1000px 曲目标签栏改成“当前曲目胶囊 + 溢出菜单”，而不是整条隐藏；隐藏播放栏按钮时给等价入口。**工作量**：1.5 人日。

### 4.4 设计令牌：契约被就地覆盖

- 命中区契约：controls.css:22 定 28px（min-height: 28px），styles.css:426-430 还给 .icon-btn 加了 min-width/min-height: 28px 兜底。但实际：.et-btn 26px（ViewEdit.vue:3309）、.ed-view-switch .et-btn 22px（3273）、.ed-taskbar .et-btn 24px（3467）、.st-close 16×16（SongTabs.vue:150）、.si-tools 内联 26×26（SideBar.vue:886-897）、.ap-seg button 3px/8px 内边距（AppearancePanel.vue:257）、.sp-use 2px 8px（SettingsPanel.vue:1978）。
- 字号契约：tokens.css:33 写 --fs-md: 13px /* 界面正文（默认） */，但 styles.css:202 是 body { font-size: var(--fs-lg) }（15px）——“默认正文”是 15 还是 13，两处说法不一致；typography.css:21-23 又给表单控件 font-size: inherit 把两者绑定。
- 语义色 token 形同虚设：tokens.css:68-93 定义了 --t-stage/--t-panel/--t-raised/--t-sunken/--t-line/--t-text/--t-text-soft/--t-text-dim/--t-brand，实测使用次数 **0–2**（--t-stage 2 次，都在 ViewScore.vue）；真正在跑的是 core/theme.js:136-200 运行时写入的旧变量（--canvas/--surface/--ink/--stone…）。而 tokens.css:11-14 的文件头声称“本文件分两段：② 深色映射层”，96-107 又说“这里不映射”—— 文档自相矛盾，新人会照着不存在的映射层改。
- 层级 token 未覆盖：--z-overlay:900 / --z-modal:1000 已定义，但 ViewScore.vue:1044 的 .pv-overlay 用 z-index: 90、ChangeLogOverlay.vue:45 用 calc(var(--z-overlay) - 1)、TaskCenter.vue:234 用 60、App.vue:976 用 1000、ViewEdit.vue:3332 用 var(--z-modal)—— 5 种写法。

**工作量**：0.5 人日（改 token 注释 + 统一 6 个控件到 28px + 5 处 z-index 归位）。

### 4.5 交互反馈与文案细节

- **关闭按钮借用「加号旋转 45°」**：ViewScore.vue:935,961、SongTabs.vue:120,133、PlayerBar.vue:333,367,401、ViewModels.vue 同款。视觉可接受，但语义上应统一到 Icon 里已有的 close。
- **「取消」不撤销**：SettingsPanel.vue:1187 只关面板；而主题/深浅/字号在点选时已 live 应用（1268-1269 调 onModeChange → setMode 写 localStorage；1313-1315 调 onFontSize）。用户点「取消」以为回滚，实际保留。**修法**：底部改成「关闭」，或 cancel() 恢复进入时快照。**工作量**：0.3 人日。
- **任务中心贴边球的绝对坐标**：TaskCenter.vue:24,30-33,72-73 用 window.innerWidth/innerHeight 夹取并 left/top 定位；窗口缩放（含 P0-1 的缩放）变化时只在 resize 里重夹一次（110-112）。**待实测**：130% 缩放下小球是否出界。
- 书签 / 睡眠弹层**居中于视口**而非锚在按钮上：PlayerBar.vue:453-459（position: fixed; left: 50%; transform: translateX(-50%)）。点左下方的时钟按钮，弹层出现在屏幕正下方中间 —— 归因困难。

### 4.6 动画 / 性能

- **双层 KeepAlive**：App.vue:803-809 缓存路由视图，三个分组页又各自 `<KeepAlive><component :is="cur"/></KeepAlive>`（ViewMusic.vue:38-40、ViewViews.vue:40-42、ViewTranscode.vue:43-45）。从首页依次点过「音乐 / 工作台 / 创作」后，ViewPlay/ViewViz/ViewScore + ViewEdit/ViewLyrics/ViewAnalyze/ViewArrange + ViewTranscribe/ViewConvert/ViewScoreConvert/ViewCover/ViewSing 共 **12 个重视图实例同时存活**（含 Verovio SVG、多个 canvas、WebGL 上下文）。
- 缓解：EditorCanvas.vue:1914-1992、PianoRoll.vue:161-212 都用“尺寸归零 → 停 rAF”的守卫（注释写得很清楚），ViewAnalyze.vue:230-231 用 onActivated 补绘。所以**不是 CPU 空转**，是内存与切回时的重绘成本。
- 建议：分组页 KeepAlive 加 :max="2" 或 :include 只保活当前 + 上一个；ViewViz 在 onDeactivated 里释放 WebGL/canvas 后备缓冲。**工作量**：0.5 人日 + 内存实测。

### 4.7 暗色 / 浅色

- 机制是好的：core/theme.js:99-107（浅色盘）、144（明暗判定）、122-128（auto）；默认深色由 main.ts:23-25 在首次启动写入。
- 风险点：ViewScore.vue:1026-1037 用 !important 把 Verovio SVG 的 fill/stroke 全刷成 currentColor，再用 --t-stage（仅深色值）给高亮音符做反相描边 —— 浅色档下 --t-stage 不会被主题改写（core/theme.js 不写这个变量），高亮音符拿到固定的 #0a0d16 描边。视觉上大概率仍可读，但属于“深浅色只有一个来源”（tokens.css:103-106 原话）被破坏的一处。
- --data-3 被当底色用（ViewScore.vue:1037），注释自己承认“浅色档 data-3 是深琥珀”—— 说明这套 7 色数据色没做明暗适配。

**工作量**：0.3 人日（把 --t-stage 之类交给 theme.js 发布，或改用 --ink/--canvas 反相组合）。

### 4.8 命名、注释与结构债

- styles.css 一个文件 1,889 行，包含变量兜底、外壳网格、按钮、卡片、页面、目录卡（.cat-* 约 80 行）、参数滑块、进度条合成化规则…… 与 styles/controls.css、styles/brand.css 职责重叠（同一个 .btn 在三处被改写；controls.css 的 .fu-ctl 与 styles.css 的 .btn 是两套按钮体系并存）。
- brand.css 用 !important 覆盖 .topbar/.sidebar/.playerbar 背景（126/134/145），属于“皮肤层反向侵入布局层”。
- ViewEdit.vue:3297 的 .ed-status 连写两次 overflow: hidden。
- 注释质量整体很高（ViewEdit.vue:3261-3267、PianoRoll.vue:161-165、styles.css:36-45 都记录了实测数据与踩坑），这是本仓库最大的资产，建议保持。

**工作量**：1 人日（styles.css 拆 shell / components / utilities 三段，brand.css 的 !important 收敛到变量）。

---

## 5. 可访问性专项汇总（P1 集中区）

| 检查项 | 现状 | 目标 |
|---|---|---|
| 视图内 aria-label | 24 个视图共 **9** 个 | 每个可交互控件有可访问名 |
| 视图内 role= | 共 **2**（ViewScore.vue:835 tablist、ViewResources 1 处） | 列表 / 页签 / 对话框 / 菜单有角色 |
| 不可聚焦 @click | **95** | 0 |
| 浮层 role=dialog | 15/56 | 56/56（右键菜单用 role=menu） |
| 浮层焦点陷阱 | **3/56** | 所有模态 |
| 浮层 Esc | 11/56（且依赖焦点在内部） | 全局 Esc 栈 |
| 仅 placeholder 的输入 | **68** | 0 |
| 无名称图标按钮 | 12 | 0 |
| 命中区 < 28px | 6 类控件 | 统一 28px |
| 焦点可见性 | 全局 :focus-visible { outline: 2px solid var(--accent) }（styles.css:196）✅，但 outline: none 仍有 24 处（SettingsPanel.vue:1986、ViewEdit.vue:3329-3330 等） | 保留 outline 或用 :focus-visible 替代 |
| 减少动效 | tokens.css:113-115 + styles.css:1581 + brand.css:175-181 + 抽屉开关（AppearancePanel.vue:201）✅ | 保持 |
| 对比度 | token 层浅色 --stone #64748b 对 #f4f7fb 约 4.9:1 ✅；深色 text3 = hsl(h,28,76%) 对 #0a0d16 ✅；风险在 .pv-paper 强制 #fff（ViewScore.vue:1122，有 ui-tokens-allow 注释，属刻意）与 --t-stage 固定值（§4.7） | 抽查 10 个高频组合达 4.5:1 |

顺序建议：先做全局 Esc 栈 + 浮层 trap（1.5 天，收益最大），再用 v-clickable 铺 95 处（2 天），最后补 68 个输入名（0.5 天）。

---

## 6. 升级方案（按里程碑）

### M1「止血」—— 约 1 周（4.5 人日）

1. **P0-1** 统一界面缩放为单源（core/display.js），删 App.vue:24-29 的 CSS zoom；迁移 ws.layout.scale 旧值。
2. **P0-2** 编辑器工具条改两行，删除「更多」里的 3 个重复开关。
3. **P1-1** 删设置里的外观段与 7 条索引（或加回页签），修 validateSettingsIndex 的默认集。
4. **P1-10** 修设置保存反馈。
5. **P2 4.1** 删死代码（QUICK / saveProject 若需要则接回首页、TopBar 菜单、brand.css 死选择器、ViewViz 的 v-if="false"、ViewConvert 的 disabled select）。

**验收**：980 / 1280 / 1585 三档窗口 × 深/浅两档 × 100% / 130% 两档缩放的截图矩阵 —— 编辑页无横向裁切、无隐藏控件；设置搜索 22 条结果全部能落点。

### M2「可用」—— 约 2 周（8 人日）

1. **P1-3/P1-4/P1-5** 可访问性三件套：v-clickable、Esc 栈 + 焦点陷阱全覆盖、输入名补齐。
2. **P1-6** i18n：拼接句重构 + 159 条翻译 + CI 门禁。
3. **P1-7** 混音台通道语义（短解）。
4. **P1-8/P1-9** 专家模式落地 + 空状态。
5. **P2 4.3** 响应式：侧栏自动折叠、曲目标签栏不整条消失。

**验收**：纯键盘走通「导入 MIDI → 选曲 → 编辑 → 导出」；讲述人能报出每个控件名；tabindex 顺序与视觉顺序一致。

### M3「打磨」—— 约 1.5 周（6 人日）

1. **P2 4.4** 令牌收口：styles.css 拆三层、brand.css 去 !important、6 类控件回 28px、z-index 归位、tokens.css 注释更正。
2. **P2 4.6** KeepAlive 收敛 + 内存实测。
3. **P2 4.5 / 4.7** 文案与深浅色细节。
4. **P2 4.2** 首页状态接真实信号。

### 工作量汇总

| 项 | 人日 |
|---|---:|
| P0-1 缩放单源 | 0.5–1 |
| P0-2 工具条 | 1.5 |
| P1-1 设置外观页签 / 索引 | 0.5–1 |
| P1-2 外观双实现合并 | 0.5 |
| P1-3 95 处可点击 | 2–3 |
| P1-4 浮层语义 | 1.5 |
| P1-5 68 输入名 | 0.5 |
| P1-6 i18n | 3 |
| P1-7 混音台短解 | 0.5（根治 3–5） |
| P1-8 / P1-9 | 0.6 |
| P1-10 保存反馈 | 0.2 |
| P2 4.1 死代码 | 0.5 |
| P2 4.2 状态 | 0.2 |
| P2 4.3 响应式 | 1.5 |
| P2 4.4 令牌 | 0.5–1 |
| P2 4.5 细节 | 0.5 |
| P2 4.6 性能 | 0.5 |
| P2 4.7 深浅色 | 0.3 |
| P2 4.8 结构债 | 1 |
| **合计** | **约 16–19 人日**（不含混音台根治） |

---

## 7. 建议新增的门禁（防回退）

1. **i18n 门禁**：中文键必须同时存在于 I18N_MAP 与 I18N_JA（脚本见 §9）。
2. **可点击元素 lint**：`<div|span|li ?[^>]*@click` 命中数不得增长（当前 95）。
3. **浮层 lint**：class 含 mask/overlay/scrim 的 div 必须同标签含 role=（当前 41 违反）。
4. **输入名 lint**：`<input` 行必须含 aria-label 或 id=（当前 68 违反）。
5. **命中区 lint**：新增 .et-btn / .st-* / .icon-btn 变体不得低于 28px。
6. **色值与字号 lint**：.vue 内不得出现 #hex 与 font-size: 数字px（视图层已基本达标，容易守住）。

---

## 8. 未覆盖 / 待实测

| 项 | 原因 | 验证方法 |
|---|---|---|
| 界面缩放叠加的真实表现 | 需运行 | 设 115%（编辑器菜单）+ 130%（设置），980×640 截图；看编辑器是否横向裁切、任务球是否出界 |
| position:fixed 弹层在 zoom 下的偏移（任务球、Viz 特效面板、SongTabs 右键菜单） | 需运行 | 130% 下逐个打开，量按钮与弹层的像素距离 |
| 色彩对比度的实际渲染值 | 主题运行时写内联变量，静态算不准 | DevTools 取 --stone / --text3 实际值后算对比度 |
| WebGL / Verovio 大曲目内存 | 需运行 | 依次打开音乐/工作台/创作后取 performance.memory，对比单视图 |
| 屏幕阅读器朗读顺序 | 需运行 | 讲述人走 设置 / 侧栏 / 编辑器 三处 |
| 触摸 / 高 DPI | 本审计不含 | 可选 |

---

## 9. 附录：可复现度量

仓库根目录执行（Windows Git Bash / PowerShell + node）：

    # 1) 不可聚焦的 @click
    grep -rnE '<(div|span|li|tr)[^>]*@click' frontend/src --include=*.vue | wc -l

    # 2) 浮层语义缺口
    grep -rnE 'class="[^"]*(mask|overlay|scrim)[^"]*"' frontend/src --include=*.vue | grep -v 'role=' | wc -l

    # 3) 仅 placeholder 的输入
    grep -rnE '<input' frontend/src --include=*.vue | grep -v 'aria-label' | grep -v 'id="' | wc -l

    # 4) 静默 catch
    grep -rn 'catch (e) {}' frontend/src --include=*.vue --include=*.ts | wc -l

    # 5) i18n 缺口（node scripts/i18n-coverage.mjs）
    #    输出应为 used 3489 / missing 159

i18n 覆盖脚本（保存为 scripts/i18n-coverage.mjs）：

    import { readFileSync, readdirSync, statSync } from 'node:fs';
    import { join } from 'node:path';
    const root = 'frontend/src';
    const walk = (d, o = []) => { for (const e of readdirSync(d)) { const p = join(d, e);
      statSync(p).isDirectory() ? walk(p, o) : /\.(vue|js|ts)$/.test(e) && o.push(p); } return o; };
    const keys = (f) => new Set([...readFileSync(f, 'utf8').matchAll(/^\s*'((?:[^'\\]|\\.)*)'\s*:/gm)].map(m => m[1]));
    const en = keys('frontend/src/core/i18n.js'), ja = keys('frontend/src/core/i18n_ja.js');
    const used = new Set();
    for (const f of walk(root)) for (const m of readFileSync(f, 'utf8').matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g))
      if (/[\u4e00-\u9fa5]/.test(m[1])) used.add(m[1]);
    const miss = [...used].filter(k => !en.has(k) || !ja.has(k));
    console.log('used', used.size, 'missing', miss.length);

---

## 10. 附：值得保留的做法（避免后续改动把它们改坏）

1. **注释带实测数据**：ViewEdit.vue:3261-3267（为什么必须 min-width:0）、styles.css:271-274（scrollbar-gutter 的原因）、router.ts:57-69（预取只取 5 个的原因）。这类注释是后续改动的护栏。
2. **空状态文案写“下一步动作”而不是“没有数据”**：ViewSing.vue:2232-2256（且明确注释了“同文案同功能到处都有”的教训）、ViewTranscribe.vue:2246（三种空态分别指向不同动作）。
3. **长任务的反馈闭环**：ViewTranscribe.vue:2338-2340（分离日志）、TaskCenter.vue:123-131（只在 running→done/error 时提示，避免打扰）。
4. **表单语义化做得对的地方**：SongTabs.vue:110-121（role=tablist/tab + aria-selected + tabindex 管理）、SideBar.vue:921-923（分隔条 role=separator + 键盘左右键）。
5. **进度条一律 transform: scaleX()**（styles.css:1879-1885 一处集中声明）—— 新增进度条请复用这个选择器列表。
6. **减少动效三层保险**（tokens.css / styles.css / brand.css）+ 抽屉开关。

---

*报告结束。全部结论基于 E:\Midi\FuFumidi-Source 静态代码；标注“待实测”的 5 项需在安装版里跑一遍（deploy-installed.cjs + 冒烟脚本）。*
