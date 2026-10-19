# 许可与溯源（P1-7）

> 由 scripts/gen-licenses.mjs 从代码/docs/VENDOR.md 生成，不要手改；漂移会被 npm run check:licenses 拦下。

## 应用

| 名称 | 版本 | 许可证 |
| --- | --- | --- |
| fufumidi | 6.1.3 | MIT |

## 内置音色库

| 名称 | 版本 | 许可证 |
| --- | --- | --- |
| GeneralUser GS | v1.471 | CC BY 3.0 · 可免费用于个人/商用，见包内许可证 |
| FluidR3_GM | 3.1 | MIT · 可自由使用/分发（保留署名） |
| MuseScore General | 0.2 (2020-05-13) | MIT · 可自由使用/分发（FluidR3 © Frank Wen · 适配 © S. Christian Collins） |
| Allvoice (ToH 基底 · 最全) | 2.0 | ToH 派生 · 已获作者书面授权，可再分发（授权凭证见项目档案） |
| Sonatina Symphonic Orchestra | SF2 (2.0) | 免费使用（Sonatina 采样库，详见包内许可） |
| Arachno SoundFont | 1.0 | 免费可自由使用（官方许可） |
| Timbres of Heaven | 4.0 (XGM) | 免费使用 · 不可再分发（Don Allen / Midkar 授权条款） |
| SGM-V2.01 (Part 1) | 2.01 | 免费个人/商用（SGM 许可条款） |
| SGM-V2.01 (Part 2) | 2.01 | 免费个人/商用（SGM 许可条款） |
| SGM-V2.01 (Part 3) | 2.01 | 免费个人/商用（SGM 许可条款） |
| Aspirin-DX Soundbank | 2026-07-08 | libre 开源重制（NeoSoundFonts 维护） |
| Salamander Grand Piano | 3+20200602 (6 力度层) | CC BY 3.0（使用需署名原钢琴录音艺术家） |
| FluidR3 Mono GM | 3.1 (mono) | CC BY 3.0 · 可自由使用（保留署名） |
| FM/GM 紧凑版 |  | GPL-3.0 |
| GIGA FM GM |  | CC BY 4.0 |
| 雅马哈 C5 三角钢琴 |  | GPL-3.0 |
| Galaxy 电钢琴 |  | GPL-3.0 |
| Supersaw 合成音色 |  | GPL-3.0 |
| Florestan 轻量 GM |  | 公共素材 |
| Vintage Dreams Waves |  | 公共素材 |

## 内置第三方二进制（docs/VENDOR.md 清单）

| 文件 | 上游 | 版本 | 许可证 |
| --- | --- | --- | --- |
| 文件 | 上游 | 版本 | 见上游仓库 LICENSE |
| --- | --- | --- | 见上游仓库 LICENSE |
| frontend/public/vendor/verovio-toolkit-wasm.js | [rism-digital/verovio](https://github.com/rism-digital/verovio) 的 wasm 构建 | 6.3.0 —— npm `verovio@6.3.0` 的 `dist/verovio-toolkit-wasm.js`，逐字节相同（2026-10-13 确定） | MIT（上游 rism-digital/verovio） |
| frontend/public/vendor/js-synth/js-synthesizer.min.js | [json-schema-org/js-synthesizer](https://github.com/surikov/js-synthesizer) 1.13.0 | 1.13.0（代码与上游逐字节相同，只有 CRLF；见坑 1 末注） | MIT（js-synthesizer）；libfluidsynth: LGPL-2.1+ |
| frontend/public/vendor/js-synth/js-synthesizer.worklet.min.js | 同上 1.13.0，本地打过补丁（见下） | 1.13.0 + 补丁 | MIT（js-synthesizer）；libfluidsynth: LGPL-2.1+ |
| frontend/public/vendor/js-synth/libfluidsynth-2.4.6-with-libsndfile.js | js-synthesizer 附带的 libfluidsynth 2.4.6 构建（带 libsndfile） | 2.4.6 | MIT（js-synthesizer）；libfluidsynth: LGPL-2.1+ |
| frontend/public/vendor/js-synth/fu-seq-clock.js | 本项目自有（AudioWorklet 音序时钟） | — | 本项目自有代码（MIT） |
| renderer/vendor/soundfonts/GeneralUser.sf2 | GeneralUser GS（S. Christian Collins） | v1.471（许可证 v2.0，见同目录 `GeneralUser.LICENSE.txt`） | GeneralUser GS License v2.0（见包内 GeneralUser.LICENSE.txt） |
| resources/models/audio-tagger/model.int8.onnx | [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) 的 audio-tagging 模型（zipformer-small，AudioSet 527 类，int8 ONNX） | 2024-04-15 发布包；CPU 推理，用于自动乐器组探测（方案 B） | 见上游仓库 LICENSE |
| resources/models/audio-tagger/class_labels_indices.csv | 同上（AudioSet 标签表） | 同上 | 见上游仓库 LICENSE |
| engine/singing/openutau/classic/data/mel.onnx | [stakira/OpenUtau](https://github.com/stakira/OpenUtau)（源路径 `OpenUtau.Core/Classic/Data/mel.onnx`） | 上游 commit `4d26fa51a62effe586e5be036eb46fbe8d550a1b`（2025-11-28「update worldline-r2 model」） | MIT（上游 stakira/OpenUtau） |
| engine/singing/openutau/native/** | [stakira/OpenUtau](https://github.com/stakira/OpenUtau)（MIT） | commit `04c4e61005`（2026-09-27，PR No.2468 Rebuild Worldline）—— 2026-10-13 用 blob 比对确定 | MIT（上游 stakira/OpenUtau） |

## 说明

- 内置音色库与二进制随应用分发；模型/声库为按需下载，适用各自上游许可证，不随包分发。
- Allvoice（Timbres of Heaven 派生）已取得作者书面授权，可再分发（授权凭证见项目档案）。
- 导出文件不改变素材的许可义务；商业使用前请自行核对相应音色库/模型条款。
