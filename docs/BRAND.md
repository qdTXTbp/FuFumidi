# 品牌资产与前端设计约束（logo 守恒）

> 状态：M0 冻结（2026-11-03）。本文件是**品牌资产的唯一清单与变更规则**；
> 自动化门禁：npm run check:brand（manifest: scripts/brand/brand-manifest.json）。
> 关联：docs/DESIGN.md（界面设计语言）、scripts/gen-logo.py（品牌图生成器）、
> docs/plans/2026-11-03-master-integrated-plan.md、master-ai-spec（P-026/P-027）。

## 1. 用户定下的品牌规则（2026-08，不要再弄反）

1. **图标 = 头像特写 + 透明底**（exe / 安装器 / 窗口 / 托盘）。**不做白底圆角卡**：
   白底卡在深色任务栏上是一块白板，也会盖掉任务栏主题。
2. **立绘进应用内**：侧边栏品牌位、首页工作区吉祥物、文档页 nav；立绘是竖构图整幅，不裁方。
3. **母图只此一份**：docs/assets/brand/立绘-定稿-带描边.png（1092x1550，透明底，用户拍板的定稿）。
   所有品牌图由 scripts/gen-logo.py 从母图生成；不要手改生成物。
4. **运行时重写/换壳期间 logo 不得变**：Electron→Tauri 迁移必须复用同一套
   build/icon.*、installer 图、splash 品牌位、官网 logo；不允许「顺便换个新 logo」。
5. 颜色/材质/字体继续以 docs/DESIGN.md 的 token 表为准；品牌图不参与主题换色（不重着色）。

## 2. 资产清单（16 个，SHA-256 见 manifest）

| 资产 | 角色 | 使用点 |
|---|---|---|
| build/icon.png / icon.ico | 应用图标（512 头像特写 + 多尺寸 ico） | exe、窗口、NSIS 安装器、托盘 |
| build/updater-icon.png / .ico | 更新器图标 | FuFumidi.update.exe、更新提示 |
| build/installerHeader.bmp / installerSidebar.bmp | NSIS 安装器头图/侧图 | electron-builder NSIS |
| frontend/src/assets/logo.png | 侧栏徽标（38px 圆角容器，object-fit: cover） | PrimaryRail.vue |
| frontend/src/assets/mascot.png | 首页/工作区吉祥物 | 首页工作区 |
| docs/assets/logo.png / logo-fufumidi-download.png | 官网/下载页 | docs/pages |
| docs/assets/brand/FuFumidi.ico、徽记-512.png | 品牌规范件 | 文档/发布物 |
| docs/assets/brand/立绘-*.png（4） | 母图与各底色稿 | 生成源 |

> manifest 由脚本从磁盘计算，不要手写哈希。加新资产时同步更新本表与脚本 ASSETS 清单。

## 3. 变更流程（唯一合法路径）

1. 用户明确要求改品牌 → 改母图（或确认新母图）；
2. 跑 scripts/gen-logo.py 重新生成全部尺寸；
3. npm run brand:update 重记 manifest；
4. 在本文件「变更记录」追加：日期 / 原因 / 用户确认原话 / 影响文件；
5. 提交时同时带 manifest 与生成物；CI 的 check:brand 会拦未登记变更。

## 4. 迁移检查清单（Electron → Tauri / 任何打包变更）

- [ ] tauri.conf.json 的 bundle.icon 指向 build/icon.ico / icon.png（或从同一母图生成的新尺寸），不得沿用 src-tauri/icons 旧原型图；
- [ ] 安装器（NSIS/update）继续使用 build/installer*.bmp；
- [ ] splash 品牌位/主窗口图标/托盘图标与 Electron 版逐像素一致（截图对比）；
- [ ] 官网 docs/pages 引用的 logo 文件路径不变；
- [ ] npm run check:brand 绿；brand-manifest 无意外 diff；
- [ ] 截图基线：侧栏 38px 徽标、首页吉祥物、splash、安装器、官网下载页各一张，随发布归档。

## 5. 前端设计完善（与 logo 一起守）

docs/DESIGN.md 的「还没做的」+ 审计遗留，收敛为两条主线：

1. **设计 token / 控件契约收口**：三大视图（ViewSing / ViewEdit / ViewTranscribe）
   的本地样式逐个换成 controls.css 契约类（逐视图截图对比，不能脚本化）；
2. **布局与可访问性回归**：980 / 1280 / 1585 三档窗口的编辑器工具条、设置页、
   浮层焦点陷阱、空状态、错误反馈；每次改版跑 UI token 门禁 + 截图。

规则：前端设计改动**不得**以「换壳/重写」为由顺手改视觉语言；品牌图与 token 表
以本文件 + docs/DESIGN.md 为准，变更需用户确认。

## 6. 变更记录

| 日期 | 变更 | 原因/确认 |
|---|---|---|
| 2026-11-03 | 建立 manifest 与 check:brand 门禁；记录当前 16 个资产哈希 | M0 冻结，用户要求「注意前端设计的完善和工具 logo 的保持」 |
