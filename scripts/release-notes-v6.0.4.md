# FuFumidi 6.0.4

> 最终收尾版：与源码保持一致，包含 6.0.3 之后新增的**真实 VST3 离线宿主**与 **DAWproject 官方 XSD 校验**。

## VST3 离线渲染（P2-1，可选、宿主自备）

- 转换页新增「VST3 离线渲染（实验）」：选插件（.vst3）→ 选输入 WAV → 输出 WAV。
- 由 pedalboard 宿主执行（可选手装：`uv pip install pedalboard numpy soundfile mido`），
  解释器用 `plugin.host_python` 或 `FUFUMIDI_PLUGIN_PYTHON` 指定；插件目录用 `plugin.dirs` 或 `FUFUMIDI_PLUGIN_DIRS`。
- 不随包分发宿主与插件；未配置时功能明确报不可用。实测可加载/渲染 Dexed、OB-Xf、Surge XT、Surge XT Effects。
- 详见 `docs/plugins.md`；CLAP 不在范围内。

## DAWproject（P2-5）

- 导出子集（音符轨/速度/拍号/标记）通过 **DAWproject 官方 XSD 校验**（`npm run test:dawproject`）。
- 仍未经 Studio One / Bitwig 实机导入验证（按用户决定不实现）。

## 范围说明

- 以下经用户确认不再实现：Authenticode 受信证书、macOS/Linux 构建、原生音频 I/O（WASAPI/ASIO）、参考 DAW 实机验证、CLAP 宿主。
- 更新包安全由 Ed25519 清单验签承担；GitHub Release 资产已同步（源码分支推送受 github.com:443 直连限制）。
