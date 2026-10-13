# 内置第三方二进制：版本、来源与指纹

这一页回答一个具体问题：**「这个 7MB 的 wasm / 30MB 的音色库，是哪个版本、从哪来的、改了没有？」**

仓库里有若干不经过 npm 的二进制/压缩 JS（离线可用的前提）。它们没有版本号可查，
一次「顺手更新一下 vendor」的提交就可能让音序器时钟或乐谱渲染静默失效。
所以：**改这些文件必须同时改这一页**（版本 + SHA-256），否则下次没人知道基线是什么。

## 清单（2026-10-06 实测）

| 文件 | 字节 | SHA-256（前 24 位） | 上游 | 版本 |
| --- | --- | --- | --- | --- |
| `frontend/public/vendor/verovio-toolkit-wasm.js` | 7,310,681 | `d794119cd5ea83a3e8358499` | [rism-digital/verovio](https://github.com/rism-digital/verovio) 的 wasm 构建 | **6.3.0** —— npm `verovio@6.3.0` 的 `dist/verovio-toolkit-wasm.js`，**逐字节相同**（2026-10-13 确定） |
| `frontend/public/vendor/js-synth/js-synthesizer.min.js` | 33,086 | `7b3137eb8ac367e996db95ee` | [json-schema-org/js-synthesizer](https://github.com/surikov/js-synthesizer) 1.13.0 | 1.13.0（**代码与上游逐字节相同，只有 CRLF**；见坑 1 末注） |
| `frontend/public/vendor/js-synth/js-synthesizer.worklet.min.js` | 30,283 | `a2afdec5b6ac793627d80624` | 同上 1.13.0，**本地打过补丁**（见下） | 1.13.0 + 补丁 |
| `frontend/public/vendor/js-synth/libfluidsynth-2.4.6-with-libsndfile.js` | 2,371,528 | `8f0cc693731da2d02f13e921` | js-synthesizer 附带的 libfluidsynth 2.4.6 构建（带 libsndfile） | 2.4.6 |
| `frontend/public/vendor/js-synth/fu-seq-clock.js` | 4,251 | `0a2658fb31608df568aa86b3` | **本项目自有**（AudioWorklet 音序时钟） | — |
| `renderer/vendor/soundfonts/GeneralUser.sf2` | 31,281,186 | `f45b6b4a68b6bf3d792fcbb6` | GeneralUser GS（S. Christian Collins） | v1.471（许可证 v2.0，见同目录 `GeneralUser.LICENSE.txt`） |
| `engine/singing/openutau/classic/data/mel.onnx` | 85,404 | `1493ffc868c6fb8b66104e2c` | [stakira/OpenUtau](https://github.com/stakira/OpenUtau)（源路径 `OpenUtau.Core/Classic/Data/mel.onnx`） | 上游 commit `4d26fa51a62effe586e5be036eb46fbe8d550a1b`（2025-11-28「update worldline-r2 model」） |
| `engine/singing/openutau/native/**` | 4.8 MB（6 个平台） | 逐文件映射见 `native/README.md` | [stakira/OpenUtau](https://github.com/stakira/OpenUtau)（MIT） | commit **`04c4e61005`**（2026-09-27，PR #2468 Rebuild Worldline）—— 2026-10-13 用 blob 比对确定 |

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

**★ 2026-10-13 补充核对（两件事）**：

1. **`js-synthesizer.min.js` 并没有被打补丁** —— 它 33,086 B 对上上游 33,056 B 的那 30 B，
   **全部是 CRLF vs LF**（banner 30 行，每行多 1 字节）。归一化换行后与上游 1.13.0 **逐字节相同**。
   所以**按 SHA 核对会误判主文件也被改过**，要连换行一起归一化再比。
2. **npm 上 js-synthesizer 的最新版就是 1.13.0** —— 「升级到新版就不用打补丁」这条路**不存在**。
   把它移出 `package.json`、只留 vendor 文件是**正确决定**，不是临时绕过。
   worklet 的补丁实测是 4 个差异区块，实质一件事：上游 `,O(this._messaging,e.id,e.method,void 0`，
   我们去掉了 `void`（另有两处 `void ` 也去掉），**让返回值回传**。

### 2. verovio 没有版本串

**2026-10-13 已闭合。** `verovio-toolkit-wasm.js` 里既没有 banner 也没有 `VRV_VERSION` 之类的可读版本。

**确定方法（不下载 19 个版本也能定位）**：用 jsDelivr 的文件清单 API 一次拿到各版本
`dist/verovio-toolkit-wasm.js` 的**字节数**，先按大小筛，再只下载命中的那个核 SHA-256。
结果：**`verovio@6.3.0`**，字节数与哈希全部吻合。

```
https://data.jsdelivr.com/v1/packages/npm/verovio@<版本>?structure=flat
```

**下次动它之前**：先记下当前指纹与来源，再替换，然后把版本号补进表里。

### 3. OpenUtau 只记了「哪来的」，没记「哪一版」

**2026-10-13 已闭合。** `engine/singing/openutau/native/README.md` 给出了上游仓库、源码路径
（`runtimes/<rid>/native/`）与逐文件映射，但没有 tag/commit，`native_lib.py` 只按当前 RID 取目录，
升级上游时无法判断偏移量。

**确定方法（可复现，别再靠猜）**：`git clone --filter=blob:none --no-checkout` 拉上游，
对 6 个二进制逐个算 `git hash-object`，再遍历改动过该路径的 commit 取 `git rev-parse <sha>:<path>`，
**blob 哈希相同即字节相同**。结果：6 个文件全部唯一命中 `04c4e61005`（2026-09-27，PR #2468）。
这也把**移植基线**钉在了 2026-09-27。

### 4. 随包的 mel.onnx：**许可证未核实**（发布前必须处理）

**2026-10-14 记录。** `classic/data/mel.onnx`（85,404 B，见上表）是 **Worldline v20** 的编码器：
WORLD 特征 → `mel [1,T,128]`，再喂 128bin/512hop 的 PC-NSF-HiFiGAN 声码器出波形。
它是 v20 唯一必须自带的东西（声码器用户可以从资源中心装），所以**随包**。

- 已验证可加载，签名 `f0 [1,T]` · `sp_env [1,T,1025]` · `ap [1,T,1025]` → `mel [1,T,128]`；
  帧数补到 16 的倍数后，输出样本数 = 补齐帧数 × 512（`engine/tests/test_worldline_r2.py` 盯着这条）。
- **待办（发布前）**：其许可证性质**没有查证**。上游仓库整体是 MIT，但这一个模型文件没有单独声明；
  本机 clone 里只有 `OpenUtau.Core/Analysis/Crepe/LICENSE.txt`，没有根 `LICENSE`，
  且本机直连 github 不通，无法核对。**发布前必须确认**：
  若确为 MIT 就照上表保留；若不是，改为**运行时从上游 release 获取**，或把 v20 从渲染器选项里摘掉。

（同一提交 `4d26fa51` 也是上游那版 `WorldlineRenderer.cs:150-175` 的来源，编排照它写。）

## 与其它文档的关系

- 体积账与「为什么保留这些大文件」：`docs/HYGIENE.md`。
- 分层、契约、落点：`docs/FOUNDATION.md`。
- 依赖声明的正确姿势（Python 侧）：`engine/requirements-bundle.txt` 的注释说明了哪些是显式声明、哪些曾是隐式依赖。

