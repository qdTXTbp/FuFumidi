# Salamander Grand Piano：为什么它一度不可用，以及现在怎么可用

> 2026-10-04 ｜ 相关文件：`main/soundfonts.js`、`frontend/src/core/synth.js`、`scripts/sf2-subset.py`

## 1. 结论

- 原始 **Salamander Grand Piano SF2 V3（1.18 GB）在本应用里结构上不可用**，不是「上限设小了」；
- 现在随包分发的是 **6 力度层精简版（449.7 MB）**，保留全部 30 个采样键（覆盖 88 键音域）与
  原始 48 kHz / 16 bit 采样，实测在应用里 **0.9 秒载入、实时播放与离线导出都出声**。

## 2. 硬约束：wasm 堆上限 2 GiB

应用的合成器是 `js-synthesizer` + `libfluidsynth 2.4.6` 的 **wasm** 构建
（`frontend/public/vendor/js-synth/libfluidsynth-2.4.6-with-libsndfile.js`）。该 glue 里写死了：

    var getHeapMax = () => 2147483648;   // 2 GiB

载入一个音色要同时占三份内存：

| 占用 | 1.18 GB 原始 | 449.7 MB 精简版 |
|---|---|---|
| 主进程读文件 → IPC 传给渲染进程 | 1.18 GB | 450 MB |
| 渲染进程 Uint8Array → worklet structured clone | 1.18 GB | 450 MB |
| worklet 内 MEMFS 副本 + FluidSynth 解码后的采样 | ≥1.18 GB | ≥450 MB |

合计远超 2 GiB；而且**主进程的 `file:readSoundFont` 先有一道 512 MB 的闸门**
（`main/dialogs.js`），所以 1.18 GB 连渲染进程都进不去 —— 界面上表现为「启用」被禁用，
或者（早期版本）下完 1.18 GB 才在启用时撞上「无法读取音色文件」。

## 3. 精简的做法（`scripts/sf2-subset.py`）

Salamander 的结构是：**30 个采样键 × 16 个力度层 × 2 声道 = 960 个采样**。精简只动「力度层」这一维：

1. 保留全部 30 个采样键与两个声道（音域与立体声不变）；
2. 16 个力度层按均匀间隔取 6 层（`--keep-even 6` → 第 0/3/6/9/12/15 层）；
3. **被丢掉的力度区间合并给相邻的保留层**（改写该分区的 `velRange` generator），
   这样 1..127 每个力度都还有声音，不会出现「某段力度没声」；
4. 采样数据一个字节没改（仍是原始 48 kHz / 16 bit PCM），只重新计算 `shdr` 的偏移；
5. 写出后自带 `SELFCHECK`：记录步长、`ibag` 下标单调性、采样偏移落在 `smpl` 块内、
   循环点落在采样区间内 —— 这几类错误 FluidSynth 只会回一个空错误串，必须先自己拦住。

重新生成（约 1 分钟，读 1.2 GB、写 450 MB）：

    python scripts/sf2-subset.py "<数据目录>\soundfonts\Salamander Grand Piano.sf2" \
        "Salamander_Grand_Piano_SF2_V3_20200602_6L.sf2" --keep-even 6

## 4. 踩过的三个坑（都会让 FluidSynth 直接拒载，且只回空错误串）

1. **`shdr` 的 `dwStart/dwEnd/dwStartLoop/dwEndLoop` 是 16 bit 字的偏移，不是字节**。
   原始文件可自证：最大 `end` 633,195,534 字 × 2 ≈ `smpl` 块大小 1,266,391,160。
   按字节读会让每个采样只拷一半，并且把 RIFF 头当成第一个采样。
2. **`ibag` 记录是 4 字节**（`wInstGenNdx` + `wInstModNdx`），`inst` 记录是 **22 字节**
   （名称 20 + `wInstBagNdx`，**没有** `wInstModNdx`）。少写一个字段整块 pdta 就错位。
3. **INFO 的载荷里已经含 `INFO` 这个 fourcc**，重新封装时不能再套一层 `LIST` 头，
   否则会多出 4 字节、整包非法（这一点连「原样复制一遍」都会失败，是排查的关键线索）。

## 4b. 第四个坑：同名旧文件把新文件顶掉（用户实测「仍然显示加载失败」的来源）

精简版最初沿用旧条目的本地文件名派生规则（按显示名 → `Salamander Grand Piano.sf2`）。
beta.1 时代下过原始音色的用户，数据目录里**正好放着同名的 1.18 GB 文件**，于是：

- `sf-workshop:list` 用 `size >= minSize` 判「已下载完整」→ 1.18 GB 通过了 440 MB 的下界；
- 条目又没有 `overLimit`（精简版本来就不该有）→ 界面给出可点的「启用」；
- 点下去才在 `file:readSoundFont` 的 512 MB 闸门处失败 → 提示「加载失败，已回退默认合成器」。

**这是「只判下界」的判定错误，不是文件问题。** 两条一起改：

1. 本地文件名带版本：`fileName: 'Salamander Grand Piano 6L.sf2'`，与旧文件物理隔离；
2. 完成判定加上界：`isCompleteSf(it, size)` = `size >= minSize && (!maxSize || size <= maxSize)`，
   Salamander 的 `maxSize = 500000000`（< 512 MB 闸门、> 真实 471,555,050 B）。
   列表因此给出 `stale: true`，界面显示「检测到旧版文件（1.2 GB），需重新下载」并**不给**「启用」；
   下载前会先把不合格的旧文件删掉，避免「本地 1.2GB」这种自相矛盾的显示。

顺带把「我的音色」（自定义导入）也按同一个闸门标了 `overLimit` ——
手动导入一个 1.18 GB 的 sf2 同样会失败，界面现在直接说明原因而不是给一个必然失败的按钮。

## 5. 验证方式（可复现）

应用本体就是最好的验证器：用 CDP 在渲染进程里走**应用自己的**路径，
分别走「主线程离线渲染」与「AudioWorklet 实时播放」两条：

    const buf = await window.fuBridge.readSoundFont("<音色路径>");   // 主进程 512MB 闸门
    await window.JSSynth.waitForReady();
    const syn = new window.JSSynth.Synthesizer();                    // 或 AudioWorkletNodeSynthesizer
    syn.init(48000, { reverbActive: false, chorusActive: false });
    await syn.loadSFont(new Uint8Array(buf));                        // FluidSynth 真解析

实测（449.7 MB 版）：

| 项 | 主线程 | AudioWorklet |
|---|---|---|
| 载入 | `sfontId=1`，905 ms | `sfontId=1`，866 ms |
| 出力 | 力度 20/40/60/80/100/127 → peak 0.0005/0.005/0.017/0.046/0.104/0.207 | vel 100 → rms 0.019 / peak 0.106 |
| 音域 | 键 36/48/60/72/84/96 全部有声（peak 0.09~0.14） | — |

### 走完整链路的一次验收（安装版 v5.0.0-beta.2，2026-10-04）

1. 音色工坊 → Salamander 卡片：`expected 471555050 / onDisk 0 / downloaded false / overLimit false`；
2. 点「下载」→ 走 CNB 直链，**90~120 秒**下完 471,555,050 B（`ok:true`，`.part` 归位）；
3. `readSoundFont` 1148 ms 读入（512 MB 闸门内），FluidSynth `sfontId=1` 454 ms；
4. 力度扫描 20/40/60/80/100/127 → peak 0.0005/0.005/0.017/0.046/0.104/0.207，键 36~96 全部有声；
5. AudioWorklet 实时：`rms 0.0183 / peak 0.1063`，48 kHz，`ctx running`；
6. 界面点「启用」→ 卡片变「使用中」，`settings.active_soundfont` 落到该路径；重启应用后仍是「使用中」；
7. **回归**：把 1.18 GB 旧文件放回该路径 → 列表 `downloaded false / stale true`，界面显示
   「检测到旧版文件（1.2 GB），需重新下载」+ 只有「下载/删除」，点下载后旧文件被删除并重新下成 471,555,050 B。

## 6. 分发

- 文件名：`Salamander_Grand_Piano_SF2_V3_20200602_6L.sf2`（471,555,050 B，
  SHA256 `254C46AD382FB663D8D8A52903F7C687A3EE9E6BF2F68246166043E9A166B2A4`）
- GitHub：`qdTXTbp/FuFumidi` release `soundfonts-v1`
- CNB：`FuFuCloud-mirror/FuFuMIDI` release `soundfonts-v1`（`main/soundfonts.js` 的
  `CNB_SF_RELEASE_FILES` 会据此把 CNB 直链排到最前）

## 7. 以后再加更大的音色怎么办

- 单文件必须 **< 512 MB**（主进程闸门）**且**在 wasm 里解码后仍留有余量（2 GiB 上限）；
- 450 MB 级别的音色已经吃掉约 1.3 GB 的合成器内存，**不建议再往上顶**；
- 真要放更大的音色，出路只有：减少采样键/力度层（本工具）、缩短采样，
  或把合成器换成非 wasm 的后端（工程量另计）。
