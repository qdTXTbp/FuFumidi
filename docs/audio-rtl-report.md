# 音频 I/O 延迟实测（P2-2）

> 由 scripts/audio-rtl.mjs 在真实 Electron 渲染进程里实测（不是估算表）。
> WebAudio 的 baseLatency/outputLatency 是浏览器上报值；估算 RTL = base + output + 输入缓冲。

| 项 | interactive | playback |
|---|---:|---:|
| 采样率 | 48000 | 48000 |
| baseLatency | 10 ms | 20 ms |
| outputLatency | 0 ms | 0 ms |
| 估算 RTL | **10 ms** | **20 ms** |
| 目标 ≤10ms | 达标 | 未达标 |

后端选择（契约见 core/audio_rt.js）：

- 平台：win32 · 原生 I/O 可用：否
- 结论：webaudio（原生 I/O 未随包提供 → 默认 WebAudio）
- 说明：原生 WASAPI 独占 / ASIO 需要 Rust 侧实现与 ASIO SDK，当前包未提供；
  WebAudio 的 RTL 由系统混音器决定，latencyHint 从 interactive 切到 playback 反而更慢（上表实测）。
- 若将来提供原生后端：本报告脚本可直接扩成 A/B 对比（RTL 目标 ≤10ms）。
