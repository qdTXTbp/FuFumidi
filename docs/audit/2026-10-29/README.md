# FuFumidi 2026-10-29 全量审计资料

本目录是 6.2.9 版本的全量审阅资料。主方案：[docs/plans/2026-10-29-full-audit-upgrade.md](../../plans/2026-10-29-full-audit-upgrade.md)。

| 文件 | 内容 | 关键结论 |
|---|---|---|
| frontend-ux.md | 前端/UX/布局/可访问性审计（443 行） | 缩放双实现、编辑器工具条默认窗口溢出、设置外观页签缺失、95 处不可键盘点击、159 条 i18n 欠账 |
| midi-workflow.md | MIDI 制作/编辑/调教/转谱/混音工作流审计（558 行） | 音符无试听、多选拖动只动一个、编辑重置走带/循环、编排片段不参与播放、内置音色 CC 静默 |
| backend-perf.md | 后端/引擎/性能/体积/代码质量审计（725 行） | 退出不杀 worker、设置保存冻结 380ms、storage 3.9s、Python 1.48GB、461MiB 可回收、381 空 catch |
| external-research.md | 外部竞品/开源项目/许可证调研（512 行） | MuScriptor/hFT 权重 NC、YourMT3 GPL、MIROS/piano_pt 无许可；Basic Pitch 多乐器精度低；MuScriptor “一次交付”值得借鉴 |

审计方法：只读源码 + 本机可执行度量 + 公开榜单/API；未改源码。报告中“待实测”的项目需在实施前按复现清单点一遍。
