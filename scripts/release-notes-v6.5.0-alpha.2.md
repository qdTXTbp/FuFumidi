# FuFumidi 6.5.0-alpha.2

日期：2026-11-06
基线：6.5.0-alpha.1（Tauri 壳）+ v6.4.4（Electron 功能基线）

本版继续把 v6.4.4 的资源中心与资源管理能力移植到 Tauri 壳，重点是「下载链路可恢复、可暂停、可校验」。
所有验证均为无头方式（构建 / 单测 / CLI），未启动窗口。

## 完成项

### S2c 基础模型下载规格全量对齐
- 11 个基础模型（钢琴、hFT、MIROS、YourMT3+、MuScriptor ×3、Beat This!、Audio Tagger、Aria-AMT、hnsep）
  的 URL、国内镜像顺序、minSize、清单大小、SHA-256、解包标记与 6.4.4 逐项对齐。
- GitHub 资产优先走 CNB 镜像，失败自动回退 ghfast / gh-proxy / raw；单文件支持 `.part` 断点续传，断点大小或 SHA 不符时自动丢弃重下一次。
- Zip 包安全解包（拒绝 `..` / 绝对路径），SHA 或标记文件不符时拒绝安装。

### S3 MSST 分卷下载
- 分卷期望大小与 6.4.4 一致：固定 25 MiB 切片、末卷为余数；长度不符的旧卷删除重下，只复用精确匹配的卷。
- 并发下载（默认 4 路）、429/5xx 退避与镜像轮换、磁盘预检、合并前总大小校验、合并后 SHA-256。
- 实时进度事件（received / total / percent / text / speed），支持暂停（保留断点）与取消（清理断点）。
- manifest 缓存到 `<数据根>/models/msst-manifest.json`，资源中心可显示清单大小、分卷数与 SHA。

### S4 分离模型配置自愈
- 缺 yaml 时按 模型目录 → `models/_configs` → 内置 `engine/msst_configs` → 上游 configs → `msst_autoconfig` 逐级补齐。
- 下载完成与分离前各触发一次；失败只降级不阻断，并在结果里带回原因。

### S5 RVC
- 翻唱模型：文件夹 / 多文件 / 压缩包三种导入、列表、探测、删除与目录刷新。
- 压缩包安全解压与外部引用式导入保留，删除引用式条目不会删源文件。

### S6 声库 / 音色 / 插件 / GPU / OMR
- 声库：UTAU / DiffSinger 目录、导入、导出、删除；在线声库下载与进度事件。
- 音色工坊：注册表下载、取消、导入、删除、目录；带 min/max 体积校验。
- 插件：列表、启停、平台目录、安装/确认/取消；插件调用在当前 Tauri 宿主下明确报缺。
- GPU 增强包：包列表、下载、导入、自动安装、卸载、进度与取消。
- OMR：引擎/语言包/homr/SR 组件的状态与安装入口；无法自动安装的组件给出明确指引。

### S7 UI 契约
- 资源中心三态：下载中 / 已暂停 / 失败；暂停后可「继续」续传，失败可重试。
- 展示清单大小、分卷、分组、架构、用途、运行时包标识；未安装不再显示 0。
- 中 / 英 / 日文案同步补齐。

### S8 无头回归
- 新增 `scripts/tauri/regression-matrix.mjs`：类型检查、契约审计、UI 单测、cargo test/clippy、前端构建等步骤一键复跑。
- 新增 `scripts/tauri/model-contract-check.mjs`：静态对比 Electron `MODEL_REGISTRY` 与 Tauri 模型规格。
- 默认跳过会启动 GUI / 安装器 / 签名的步骤。

## 验证（本机构建）

- `cargo test --offline`（shells/tauri）：124+ 通过
- `cargo clippy --offline -- -D warnings`：0 警告
- `npm run test:ui`：601 通过
- `npm run typecheck`：0 错误
- 真实下载冒烟：hFT / Audio Tagger / Beat This! / hnsep / MSST 分卷（HTDemucs4 6stems）均成功并通过 SHA/标记校验。
- MSST manifest 缓存与分卷并发：引擎侧 29 个用例通过；真实 manifest 78 条分卷布局全部自洽。
- 无头回归矩阵（--include-network）：11 通过 / 0 失败 / 1 预期警告（内置条目不在 Electron registry）/ 3 跳过（GUI/安装器/签名）。

## 已知限制

- 无头环境未做真实窗口内的交互验证；三态按钮与进度展示由前端单测与静态审计覆盖。
- 插件 JS 宿主、Audiveris MSI 安装与 homr venv 安装尚未在 Tauri 侧完整移植，相关入口返回明确错误。
- 安装包升级 / 数据保留 / 完整 E2E 仍需在 VM 内跑一次（本版未执行窗口级 E2E）。

## 发布状态（2026-11-06 23:30）

- 代码已提交并推送到 GitHub：`feat/audio-tagger-auto-probe`。
- **已发布**到 GitHub Releases 与 CNB Releases（`v6.5.0-alpha.2`，标题「FuFumidi 6.5.0-alpha.2 · Tauri（预发行）」）：
  - `FuFumidi_6.5.0-alpha.2_x64-setup.exe`（251,816,390 B）
  - `FuFumidi.Install.exe`（同一文件，更新器按 install 资产名识别）
  - `FuFumidi-6.5.0-alpha.2-release-notes.md`
  - `SHA256SUMS-alpha.2.txt`
- SHA-256：`0332BF8380B02D220B89D4AD10C917EC92C8A56604B919B0FF0805F70F7EC7CE`
- 本地归档：`E:\Midi\安装包\FuFumidi_6.5.0-alpha.2_x64-setup.exe`
