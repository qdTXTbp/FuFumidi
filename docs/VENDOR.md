# 内置第三方二进制：版本、来源与指纹

这一页回答一个具体问题：**「这个 7MB 的 wasm / 30MB 的音色库，是哪个版本、从哪来的、改了没有？」**

仓库里有若干不经过 npm 的二进制/压缩 JS（离线可用的前提）。它们没有版本号可查，
一次「顺手更新一下 vendor」的提交就可能让音序器时钟或乐谱渲染静默失效。
所以：**改这些文件必须同时改这一页**（版本 + SHA-256），否则下次没人知道基线是什么。

## 清单（2026-10-06 实测）

| 文件 | 字节 | SHA-256（前 24 位） | 上游 | 版本 |
| --- | --- | --- | --- | --- |
| `frontend/public/vendor/verovio-toolkit-wasm.js` | 7,310,681 | `d794119cd5ea83a3e8358499` | [rism-digital/verovio](https://github.com/rism-digital/verovio) 的 wasm 构建 | **未标注**（文件里没有 banner、也没有版本串）—— 待补 |
| `frontend/public/vendor/js-synth/js-synthesizer.min.js` | 33,086 | `7b3137eb8ac367e996db95ee` | [json-schema-org/js-synthesizer](https://github.com/surikov/js-synthesizer) 1.13.0 | 1.13.0 |
| `frontend/public/vendor/js-synth/js-synthesizer.worklet.min.js` | 30,283 | `a2afdec5b6ac793627d80624` | 同上 1.13.0，**本地打过补丁**（见下） | 1.13.0 + 补丁 |
| `frontend/public/vendor/js-synth/libfluidsynth-2.4.6-with-libsndfile.js` | 2,371,528 | `8f0cc693731da2d02f13e921` | js-synthesizer 附带的 libfluidsynth 2.4.6 构建（带 libsndfile） | 2.4.6 |
| `frontend/public/vendor/js-synth/fu-seq-clock.js` | 4,251 | `0a2658fb31608df568aa86b3` | **本项目自有**（AudioWorklet 音序时钟） | — |
| `renderer/vendor/soundfonts/GeneralUser.sf2` | 31,281,186 | `f45b6b4a68b6bf3d792fcbb6` | GeneralUser GS（S. Christian Collins） | v1.471（许可证 v2.0，见同目录 `GeneralUser.LICENSE.txt`） |
| `engine/singing/openutau/native/**` | 4.8 MB（6 个平台） | 逐文件映射见 `native/README.md` | [stakira/OpenUtau](https://github.com/stakira/OpenUtau)（MIT） | **未记录 tag/commit** —— 待补 |

改这一页时用同一条命令重新取指纹：

```powershell
# 本机没有 pwsh；python 也不能用裸 python（那是应用别名）
Get-ChildItem frontend\public\vendor, renderer\vendor -Recurse -File |
  ForEach-Object { "{0} | {1} | {2}" -f $_.FullName, $_.Length, (Get-FileHash $_.FullName -Algorithm SHA256).Hash.Substring(0,24).ToLower() }
```

## 必须知道的三个「坑」

### 1. AudioWorklet 那份 js-synthesizer 是本地改过的，不能从 npm 覆盖

`js-synthesizer.worklet.min.js` 与 npm 上的 1.13.0 **不是同一个文件**（30,283 vs 30,300 字节，
不只是换行差异）。改动点在它的消息处理函数：把 `doCallFunction(...)` 的返回值**回传**，
而 `frontend/src/core/synth.js` 的 `callFunction('__fuSeqClockStart')` 依赖这个返回值（约第 564 行）。
用 npm 原版覆盖 → 音序器时钟拿不到返回值 → 播放调度出问题，而且**构建、类型检查、单测全绿**。

因此 `js-synthesizer` 已经**从 `frontend/package.json` 移除**：运行时用的是这份打过补丁的 vendor 文件，
再声明一个 npm 依赖只会让人以为「更新依赖就能更新它」。要升级就手工同步补丁，并在这一页记下新指纹。

### 2. verovio 没有版本串

`verovio-toolkit-wasm.js` 里既没有 banner 也没有 `VRV_VERSION` 之类的可读版本。
现在唯一的基线是上面那串 SHA-256。**下次动它之前**：先记下当前指纹与来源（哪个 release 的构建），
再替换，然后把版本号补进表里。

### 3. OpenUtau 只记了「哪来的」，没记「哪一版」

`engine/singing/openutau/native/README.md` 给出了上游仓库、源码路径（`runtimes/<rid>/native/`）与逐文件映射，
但没有 tag/commit。`native_lib.py` 只按当前 RID 取对应目录，所以升级上游时无法判断偏移量。
补法：在 `native/README.md` 里补上取文件时的上游 commit。

## 与其它文档的关系

- 体积账与「为什么保留这些大文件」：`docs/HYGIENE.md`。
- 分层、契约、落点：`docs/FOUNDATION.md`。
- 依赖声明的正确姿势（Python 侧）：`engine/requirements-bundle.txt` 的注释说明了哪些是显式声明、哪些曾是隐式依赖。

