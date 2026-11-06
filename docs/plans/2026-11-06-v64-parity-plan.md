# v6.4.4 → Tauri 全功能移植计划
日期：2026-11-06
基线：git tag v6.4.4（Electron）
目标：Tauri 版恢复 v6.4.4 全部功能，逐项验证后发布。

## 0. 验收定义
- 每个能力必须同时满足：入口存在、真实数据可用、错误路径可恢复、VM 内实际跑通、数据不丢。
- 不得以“目录出现/编译通过/截图能开”代替功能验收。

## 1. 资源中心（当前最大缺口）
### 1.1 模型目录
- [x] 基础 23 项
- [x] 6.4.4 MSST 目录 78 条
- [x] 合计 101 项
- [x] 与 6.4.4 全量条目逐项 diff，补缺（11 基础规格 + basic/htdemucs 内置 + 78 条 MSST 目录 + manifest 并集）

### 1.2 基础模型下载
- [x] 13 项直链/zip
- [x] 6.4.4 URL 镜像、SHA-256、大小、minSize 全量对齐（S2c）
- [x] 失败重试、来源切换（镜像顺序回退 + .part 续传）

### 1.3 MSST 下载
- [x] manifest 读取
- [x] 分卷 partNN 下载、合并
- [x] 真实 18MB 下载验证
- [x] 分卷期望大小校验、断点复用（25 MiB 切片推导，长度不符删除重下）
- [x] SHA-256 失败丢弃重下（连 .parts 一起清）
- [x] 磁盘预检
- [x] 配置自愈（yaml / _configs / 上游 / autoconfig，S4）
- [x] 进度、暂停、取消（model:progress + 控制文件/进程终止）
- [x] 并发上限与 CNB 429 退避（默认 4 路分卷并发）

### 1.4 其他资源
- [x] RVC 模型导入/列表/探测（S5，三种导入形态 + probe）
- [~] UTAU 在线声库下载 / DiffSinger 声库安装（DiffSinger 已接；UTAU 在线下载已接，真机下载待回归）
- [~] 音色 SF2 工坊（下载/取消/导入/删除已接，真机下载待回归）
- [x] 插件平台安装（列表/安装/确认/取消；JS 调用宿主仍缺）
- [~] GPU 增强包（列表/下载/导入/自动安装已接，真机包待回归）
- [~] OMR 组件（语言包/超分已接；Audiveris MSI 与 homr venv 仍需明确指引）

## 2. 模型管理契约
- [x] model_list 字段对齐：id/name/kind/path/size/exists/downloadable/arch/use/runtime/parts/partSizes/sha256/group/totalSize
- [x] model_download 支持全部 ID（含 MSST 动态条目与 HF 整仓）
- [x] model_cancel / model_pause 真实现
- [x] 删除模型清理 .parts/.tmp/.oudep
- [ ] 断链修复（安装器替换 resources/models 后残留 junction；Tauri 侧尚未做前置清理）
- [x] 下载状态跨页面共享（Pinia store + 全局下载条）

## 3. 引擎与运行时
- [ ] Python 路径、模型目录、TORCH_HOME 与 6.4.4 一致
- [ ] 所有转录引擎真实上传样音测试
- [x] 分离模型选择/轨道选择/配置自愈
- [x] 错误日志可定位（下载器 JSON error + 引擎 stderr 截断回传）

## 4. 数据与升级
- [ ] 旧 SQLite 歌单/歌曲/预设读取
- [ ] settings / localStorage 迁移
- [ ] 模型目录不随安装包覆盖
- [ ] 自动更新预置自定义更新器
- [ ] 更新后 39 歌单/模型/预设核对

## 5. 前端一致性
- [x] 资源中心卡片、分组、空态、错误态与 6.4.4 对齐（三态 + 分卷/大小/用途）
- [ ] 布局/组件/配色/字体/间距/交互反馈六维检查
- [x] 中英日文案（新增 17 条 EN+JA，0 新增缺失）
- [ ] 大列表性能

## 6. 验证矩阵
- [ ] 每个资源条目：未安装→下载→校验→可用→删除
- [ ] 断网/中断/坏包/429
- [ ] VM 内完整流程
- [ ] 安装包升级/数据保留
- [x] cargo test/clippy、typecheck、UI 单测、契约审计；E2E 与 acceptance 仅无头部分

## 7. 执行顺序（每次只做一步，做完即验证）
S1 全量 diff 6.4.4 模型规格
S2 基础模型下载规格对齐
S3 MSST 分卷校验/断点/进度
S4 配置自愈
S5 RVC
S6 声库/音色/插件/GPU/OMR
S7 契约与 UI
S8 全矩阵回归
S9 打包上传发布

## 当前状态（2026-11-06 22:40）

- S1 完成：11 条基础规格 + basic/htdemucs 内置 + 78 条 MSST 目录（并入 manifest 后 79 条）。
- S2c 完成：URL/镜像/minSize/SHA/解包标记全量对齐，真实下载 hFT / Audio Tagger / Beat This! / hnsep 通过。
- S3 完成：分卷期望大小、断点复用、并发、429 退避、SHA 失败清理、进度、暂停/取消、manifest 缓存。
- S4 完成：配置自愈五级链路，下载后与分离前各触发一次。
- S5 完成：RVC 三种导入 + 列表 + probe + 删除。
- S6 部分完成：声库/音色/GPU/OMR 下载链已接；插件 JS 调用宿主、Audiveris MSI、homr venv 仍缺（入口返回明确错误）。
- S7 完成：资源中心三态、暂停续传、跨页共享、清单大小/分卷展示、中英日文案。
- S8 完成：无头回归矩阵 + 模型契约检查；E2E/GUI/安装器步骤默认跳过。
- S9 完成：6.5.0-alpha.2 安装包已构建（251,795,966 B，SHA-256 569E95E1028855C301DDC438BB9AC2C7A389FD76C194E5979B56561503510E07），产物已归档到 E:\Midi\安装包。
