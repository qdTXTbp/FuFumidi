// ⚠️ 由 scripts/gen-licenses.mjs 生成，不要手改（改数据源后运行 --write）
// 关于页 import 这份数据渲染「许可与溯源」；仓库内可读版本见 docs/licenses.md。
export const LICENSES = {
  "generatedBy": "scripts/gen-licenses.mjs",
  "app": {
    "name": "fufumidi",
    "version": "6.1.4",
    "license": "MIT"
  },
  "soundfonts": [
    {
      "id": "generaluser_gs",
      "name": "GeneralUser GS",
      "version": "v1.471",
      "license": "CC BY 3.0 · 可免费用于个人/商用，见包内许可证"
    },
    {
      "id": "fluidr3",
      "name": "FluidR3_GM",
      "version": "3.1",
      "license": "MIT · 可自由使用/分发（保留署名）"
    },
    {
      "id": "mscore_general",
      "name": "MuseScore General",
      "version": "0.2 (2020-05-13)",
      "license": "MIT · 可自由使用/分发（FluidR3 © Frank Wen · 适配 © S. Christian Collins）"
    },
    {
      "id": "allvoice",
      "name": "Allvoice (ToH 基底 · 最全)",
      "version": "2.0",
      "license": "ToH 派生 · 已获作者书面授权，可再分发（授权凭证见项目档案）"
    },
    {
      "id": "sonatina",
      "name": "Sonatina Symphonic Orchestra",
      "version": "SF2 (2.0)",
      "license": "免费使用（Sonatina 采样库，详见包内许可）"
    },
    {
      "id": "arachno",
      "name": "Arachno SoundFont",
      "version": "1.0",
      "license": "免费可自由使用（官方许可）"
    },
    {
      "id": "timbres",
      "name": "Timbres of Heaven",
      "version": "4.0 (XGM)",
      "license": "免费使用 · 不可再分发（Don Allen / Midkar 授权条款）"
    },
    {
      "id": "sgm_v2_part1",
      "name": "SGM-V2.01 (Part 1)",
      "version": "2.01",
      "license": "免费个人/商用（SGM 许可条款）"
    },
    {
      "id": "sgm_v2_part2",
      "name": "SGM-V2.01 (Part 2)",
      "version": "2.01",
      "license": "免费个人/商用（SGM 许可条款）"
    },
    {
      "id": "sgm_v2_part3",
      "name": "SGM-V2.01 (Part 3)",
      "version": "2.01",
      "license": "免费个人/商用（SGM 许可条款）"
    },
    {
      "id": "aspirin_dx",
      "name": "Aspirin-DX Soundbank",
      "version": "2026-07-08",
      "license": "libre 开源重制（NeoSoundFonts 维护）"
    },
    {
      "id": "salamander",
      "name": "Salamander Grand Piano",
      "version": "3+20200602 (6 力度层)",
      "license": "CC BY 3.0（使用需署名原钢琴录音艺术家）"
    },
    {
      "id": "fluidr3_mono",
      "name": "FluidR3 Mono GM",
      "version": "3.1 (mono)",
      "license": "CC BY 3.0 · 可自由使用（保留署名）"
    },
    {
      "id": "fm_gm_mini",
      "name": "FM/GM 紧凑版",
      "version": "",
      "license": "GPL-3.0"
    },
    {
      "id": "giga_fm_gm",
      "name": "GIGA FM GM",
      "version": "",
      "license": "CC BY 4.0"
    },
    {
      "id": "yamaha_grand",
      "name": "雅马哈 C5 三角钢琴",
      "version": "",
      "license": "GPL-3.0"
    },
    {
      "id": "galaxy_ep",
      "name": "Galaxy 电钢琴",
      "version": "",
      "license": "GPL-3.0"
    },
    {
      "id": "supersaw",
      "name": "Supersaw 合成音色",
      "version": "",
      "license": "GPL-3.0"
    },
    {
      "id": "florestan",
      "name": "Florestan 轻量 GM",
      "version": "",
      "license": "公共素材"
    },
    {
      "id": "vintage_dreams",
      "name": "Vintage Dreams Waves",
      "version": "",
      "license": "公共素材"
    }
  ],
  "vendors": [
    {
      "file": "文件",
      "size": "字节",
      "sha256_24": "SHA-256（前 24 位）",
      "upstream": "上游",
      "version": "版本",
      "license": "见上游仓库 LICENSE"
    },
    {
      "file": "---",
      "size": "---",
      "sha256_24": "---",
      "upstream": "---",
      "version": "---",
      "license": "见上游仓库 LICENSE"
    },
    {
      "file": "frontend/public/vendor/verovio-toolkit-wasm.js",
      "size": "7,310,681",
      "sha256_24": "`d794119cd5ea83a3e8358499`",
      "upstream": "[rism-digital/verovio](https://github.com/rism-digital/verovio) 的 wasm 构建",
      "version": "6.3.0 —— npm `verovio@6.3.0` 的 `dist/verovio-toolkit-wasm.js`，逐字节相同（2026-10-13 确定）",
      "license": "MIT（上游 rism-digital/verovio）"
    },
    {
      "file": "frontend/public/vendor/js-synth/js-synthesizer.min.js",
      "size": "33,086",
      "sha256_24": "`7b3137eb8ac367e996db95ee`",
      "upstream": "[json-schema-org/js-synthesizer](https://github.com/surikov/js-synthesizer) 1.13.0",
      "version": "1.13.0（代码与上游逐字节相同，只有 CRLF；见坑 1 末注）",
      "license": "MIT（js-synthesizer）；libfluidsynth: LGPL-2.1+"
    },
    {
      "file": "frontend/public/vendor/js-synth/js-synthesizer.worklet.min.js",
      "size": "30,283",
      "sha256_24": "`a2afdec5b6ac793627d80624`",
      "upstream": "同上 1.13.0，本地打过补丁（见下）",
      "version": "1.13.0 + 补丁",
      "license": "MIT（js-synthesizer）；libfluidsynth: LGPL-2.1+"
    },
    {
      "file": "frontend/public/vendor/js-synth/libfluidsynth-2.4.6-with-libsndfile.js",
      "size": "2,371,528",
      "sha256_24": "`8f0cc693731da2d02f13e921`",
      "upstream": "js-synthesizer 附带的 libfluidsynth 2.4.6 构建（带 libsndfile）",
      "version": "2.4.6",
      "license": "MIT（js-synthesizer）；libfluidsynth: LGPL-2.1+"
    },
    {
      "file": "frontend/public/vendor/js-synth/fu-seq-clock.js",
      "size": "4,251",
      "sha256_24": "`0a2658fb31608df568aa86b3`",
      "upstream": "本项目自有（AudioWorklet 音序时钟）",
      "version": "—",
      "license": "本项目自有代码（MIT）"
    },
    {
      "file": "renderer/vendor/soundfonts/GeneralUser.sf2",
      "size": "31,281,186",
      "sha256_24": "`f45b6b4a68b6bf3d792fcbb6`",
      "upstream": "GeneralUser GS（S. Christian Collins）",
      "version": "v1.471（许可证 v2.0，见同目录 `GeneralUser.LICENSE.txt`）",
      "license": "GeneralUser GS License v2.0（见包内 GeneralUser.LICENSE.txt）"
    },
    {
      "file": "resources/models/audio-tagger/model.int8.onnx",
      "size": "27,038,066",
      "sha256_24": "`69304b8a1b96bbe6b7d16c24`",
      "upstream": "[k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) 的 audio-tagging 模型（zipformer-small，AudioSet 527 类，int8 ONNX）",
      "version": "2024-04-15 发布包；CPU 推理，用于自动乐器组探测（方案 B）",
      "license": "见上游仓库 LICENSE"
    },
    {
      "file": "resources/models/audio-tagger/class_labels_indices.csv",
      "size": "14,675",
      "sha256_24": "—",
      "upstream": "同上（AudioSet 标签表）",
      "version": "同上",
      "license": "见上游仓库 LICENSE"
    },
    {
      "file": "engine/singing/openutau/classic/data/mel.onnx",
      "size": "85,404",
      "sha256_24": "`1493ffc868c6fb8b66104e2c`",
      "upstream": "[stakira/OpenUtau](https://github.com/stakira/OpenUtau)（源路径 `OpenUtau.Core/Classic/Data/mel.onnx`）",
      "version": "上游 commit `4d26fa51a62effe586e5be036eb46fbe8d550a1b`（2025-11-28「update worldline-r2 model」）",
      "license": "MIT（上游 stakira/OpenUtau）"
    },
    {
      "file": "engine/singing/openutau/native/**",
      "size": "4.8 MB（6 个平台）",
      "sha256_24": "逐文件映射见 `native/README.md`",
      "upstream": "[stakira/OpenUtau](https://github.com/stakira/OpenUtau)（MIT）",
      "version": "commit `04c4e61005`（2026-09-27，PR No.2468 Rebuild Worldline）—— 2026-10-13 用 blob 比对确定",
      "license": "MIT（上游 stakira/OpenUtau）"
    }
  ],
  "notes": [
    "内置音色库与二进制随应用分发；模型/声库为按需下载，适用各自上游许可证，不随包分发。",
    "Allvoice（Timbres of Heaven 派生）已取得作者书面授权，可再分发（授权凭证见项目档案）。",
    "导出文件不改变素材的许可义务；商业使用前请自行核对相应音色库/模型条款。"
  ]
};
