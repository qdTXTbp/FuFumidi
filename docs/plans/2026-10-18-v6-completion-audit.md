# FuFumidi v6.0.0 方案完成度审计（2026-10-18）

> 对照 `E:\Midi\_attic\FuFumidi-评估-2026-10-17\v6.0.0-任务清单.csv` 的 28 个工作包逐项核对。
> 状态口径：✅ 主体完成并有测试/验收证据；◐ 核心完成、遗留环境依赖或非阻塞尾巴；✗ 未实现。

## 总览

| 包 | 主题 | 状态 | 证据（路径） |
|---|---|---|---|
| P0-1 | MIDI 导出保真与 round-trip | ✅ | frontend/tests/midi-roundtrip.test.js；midi.js 事件表 |
| P0-2 | 工程保存/自动保存/崩溃恢复 | ✅ | core/session.js + main/project.js；session.test.js；E2E autosave-ipc |
| P0-3 | MIDI 键盘录音 | ✅ | core/midiin.js + recorder.js；midiin/recorder 测试；E2E record-ui |
| P0-4 | 音频导出升级（位深/分轨/响度/元数据） | ✅ | export_audio.js / export_options.js；export-wav-metadata 测试；P0-4c 分轨 ZIP（export:stems-zip + E2E stems-zip-ui） |
| P0-5 | 默认 GM 音色懒加载 | ✅ | default_soundfont.js；E2E soundfont-lazy |
| P0-6 | 多拍号 + SMPTE 导入 | ✅ | midi-timesig 测试；timeline.js |
| P0-7 | 文档/版本一致性 | ✅ | scripts/check-version-consistency.mjs（四源）；audit |
| P0-8 | 小 bug 批次 + i18n 门禁 | ✅ | i18n 欠账 **EN 0 / JA 0**；check:i18n 硬门禁；licenses 审计 |
| P1-1 | 编排时间线（clip/marker/region） | ✅ | core/arrange.js + ViewArrange.vue；15+ 测试；E2E arrange-ui |
| P1-2 | 分析升级（调性/转调/段落/罗马数字/和弦写回） | ✅ | core/analysis.js；analysis-advanced/chord-writeback 测试；ViewAnalyze；E2E analysis-ui |
| P1-3 | 质量基准（合成样本 + F1 门禁） | ✅ | engine/eval_quality.py + scripts/eval-quality.mjs；test:quality 6 用例 |
| P1-4 | OMR 收口（多后端/失败页/按页重试/SMT 适配器） | ✅ | engine_omr_backends.py；engine 测试 62 项；test:omr |
| P1-5 | 翻唱咬字对齐（字级/丢字/严格校验/UI 标记/手动修正入口） | ✅ | engine/align_sofa.py；6 测试；engine_cover 汇总；ViewCover 咬字校验卡 + 严格模式 + 去改歌词 |
| P1-6 | 影视配乐（帧吸附/时间码/视频偏移） | ✅ | core/frame_snap.js；frame-snap 测试；E2E frame-snap-ui |
| P1-7 | 许可与溯源 | ✅ | gen-licenses.mjs → licenses.js/docs；ViewAbout；WAV BWF/INFO；MIDI 版权 |
| P1-8 | 代码签名与安全更新 | ◐ | Ed25519 清单签名 + 更新器验签（7 测试；CNB 实发验签通过）；**Authenticode 证书待采购** |
| P1-9 | 存储与安装治理 | ✅ | main/storage.js 10 类；StoragePanel；storage 测试；E2E storage-ui |
| P1-10 | 性能基线与可视化 | ✅ | scripts/perf-baseline.mjs；perf 6 指标；E2E edit-varmeter |
| P1-11 | 音频轨最小闭环 | ✅ | core/audio-track / song_project / player；audio-track 测试；E2E frame-snap/edit |
| P1-12 | 控件契约/模板/专家模式 | ✅ | ui_contract.js / workspace_templates.js / expert.js；约 18 测试；E2E expert-mode |
| P1-13 | 编辑器交互语言统一 | ✅ | gesture/curve_engine/history_stack（含分标签 registry）；E2E arrange-tabs-undo、edit-pb-lane、edit-selection-toolbar、edit-follow-ui |
| P1-14 | App Shell/导航/命令/会话/多标签/设置搜索 | ✅ | commands.js/nav_history/session/tabs/settings_index；E2E command-palette、nav-history、song-tabs、settings-search |
| P2-1 | VST3/CLAP（离线节点） | ◐ | 内置节点 10 测试 + 导出链接线；**真实 VST3 离线宿主已落地**（engine/plugin_render.py + main/plugin-host.js + 转换页入口；pedalboard 宿主 + 自行获取的 Dexed/OB-Xf/Surge XT/Surge XT Effects 实测加载与渲染，见 docs/plugins.md）；CLAP 与参考 DAW 频谱对比待补 |
| P2-2 | 原生音频 I/O（WASAPI/ASIO） | ◐ | audio_rt.js 契约 + audio:rtl 实测报告；**Rust 原生实现未做**（需 Rust/ASIO + 真机） |
| P2-3 | MIDI 2.0 / MPE / 时钟 | ✅ | midi2.js 13 测试（UMP/MPE/Clock） |
| P2-4 | 跨平台发布 | ◐ | platform.js + build:platform + CROSS-PLATFORM.md；**mac/linux 真机构建、签名公证未做** |
| P2-5 | DAW 互通（DAWproject） | ◐ | dawproject.js 8 测试 + 主进程 ZIP + E2E；**官方 XSD 校验通过**（docs/dawproject/Project.xsd + npm run test:dawproject）；Studio One/Bitwig 实机导入未验证 |
| P2-6 | AI 生成接入（可选、默认关） | ✅ | ai_generate.js 7 测试 + main/ai-generate.js + 设置开关 + E2E ai-generate-ui |

## 当前门禁（每次提交验证）

- `npm run typecheck` / `npm run test:ui`：**546/546**
- `npm run test:e2e`：**26/26**
- `npm run audit`：版本四源、i18n 0 欠账、许可清单、token 审计全绿
- `npm run test:omr`（开发环境 pytest）：引擎 OMR/对齐 68 项
- 安装版部署冒烟：`node scripts/deploy-installed.cjs`（首屏/preload/0 异常）

## 剩余（均为外部资源/环境依赖）

1. **Authenticode 代码签名证书**（P1-8 尾巴）：需采购证书；当前靠 Ed25519 更新清单验签兜底。
2. **原生音频 I/O**（P2-2）：需 Rust + cpal/ASIO SDK 实现 + 真机 RTL 测量（≤10ms 目标）。
3. **macOS/Linux 真机构建与签名公证**（P2-4）：需 Apple Developer 账号 / Linux runner。
4. **GitHub 源码分支推送**：github.com:443 直连超时（Release 资产经 api.github.com/uploads 已成功上传）；需可用的 git 代理/SSH。
5. **DAWproject 实机导入验证**（P2-5）：需 Studio One / Bitwig；当前仅按官方 XSD/示例自测。
6. **CLAP 宿主 / 参考 DAW 频谱对比**（P2-1 尾巴）：pedalboard 仅宿主 VST3；参考 DAW 可脚本化渲染环境未获取。

## 结论

- 28 包中 **21 项 ✅ 完成**、**7 项 ◐ 核心完成但有外部依赖**（P1-8 / P2-1 / P2-2 / P2-4 / P2-5 及上述资源）；无 ✗ 未开工项。
- 可交付产品：**6.0.3（CNB latest，2026-10-18 发布）**，含 P0-4c 分轨 ZIP、P1-13 分标签撤销、P0-8 i18n 欠账清零、P1-5 手动入口；
  发布链路（构建 → 签名 → CNB latest → 安装包下载验签 → 安装版部署冒烟）全部验证通过。
