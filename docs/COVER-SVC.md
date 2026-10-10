# 翻唱：SVC 变声 + 导入模型（取代 GPT-SoVITS / DiffSinger 接 RVC）

> 一句话：**一首歌进去，分离出人声，用你导入的模型把人声换成目标音色，混回伴奏，成品出来。**
>
> 与旧链路最大的三处不同：
>
> 1. **不再有 GPT-SoVITS**（纯 TTS 硬凑旋律那套）和 **DiffSinger 接 RVC**（先合成再变声）；
>    翻唱只有一条音色路线：**SVC 变声转换**。
> 2. **扒谱与歌词环节整段删除**：SVC 是「把原唱的人声换成另一个音色」，旋律、节奏、咬字
>    本来就来自原唱，不需要知道歌词也不需要音符表（`cover_notes.py` 仍在，调教/扒谱自己用）。
> 3. **应用不内置模型、不代下载**（授权见下），音色由用户**导入**。
>
> 引擎：`engine/engine_svc.py`（变声）+ `engine/engine_cover.py`（编排）。
> 界面：导航「翻唱」（`ViewCover.vue`）+ 模型管理「翻唱模型」分类（`components/cover/SvcModelPanel.vue`）。

## 链路

```
源音频 ─┬─ 分离（music2midi.py separate，与「音频处理」面板同一个入口）→ vocals / instrumental
        │
        ├─ 变声（engine_svc.py convert：导入的 SVC 模型整轨转换）→ svc/dry.wav
        │
        └─ 混音（engine/cover_mix.py：能量配平 + 吐字 EQ + 压缩 + 混响）→ <名称>.wav
```

命令行等价物：

```bash
python engine_cover.py all 歌曲.flac --outdir 输出目录 --svc-model <模型 id> \
    --transpose 0 --f0-method rmvpe --index-rate 0.3 --device auto
```

子命令：`analyze`（只分离）/ `convert`（只变声）/ `mix`（只混音）/ `all`。

## 模型从哪来：导入（不内置、不代下载）

### 授权：**CC-BY-NC-4.0**

两个社区仓库都是 CC-BY-NC-4.0（**禁止商用**、**必须署名训练者**）：

| 仓库 | 内容 | 状态 |
|---|---|---|
| <https://www.modelscope.cn/models/aihobbyist/RVC_Model_Collection> | RVC 裸权重：959 个角色（`48k（新版）/作品/{中文\|英语\|日语\|韩语}/角色/` + `40k（旧版）`） | **已接入目录** |
| <https://www.modelscope.cn/models/aihobbyist/ACG-DDSP-Model> | DDSP：255 个 **`.sf_pkg`**（SVC-Fusion 专用封装） | **挂起**：不是裸权重，见下 |

所以应用**不做一键下载**：目录只做索引（把用户送到 ModelScope），下载由用户自己完成，
再「导入」进应用。界面顶部常驻授权提示条；成品目录里的 `说明.md` 也写明许可与署名。

### 目录快照（`main/svc-catalog.json`）

`scripts/build-svc-catalog.js` 拉 ModelScope 文件树，产出精简索引（1214 条 / 433 KB）：

```
{ id, name（角色）, work（作品）, lang（语言）, sr, gen, engine, pth, pthSize, index, indexSize }
```

- 内置快照 → 打开即有、可离线浏览；「刷新目录」才联网重写缓存（`<数据根>/svc-catalog.json`）。
- 界面按**语言**（中文 222 / 英语 211 / 日语 202 / 韩语 140 / 未标语言 184）+ 作品筛选 + 搜索。

### 导入三种形态

| 形态 | 行为 | 说明 |
|---|---|---|
| 选文件夹 | **登记引用，不复制** | 权重 + index 近 180MB/角色，复制纯属浪费磁盘 |
| 逐个选文件 | 复制到 `<模型目录>/svc/<id>/` | 元数据手填（扩展名先自动归类） |
| 导入 zip | 解压到应用目录再识别 | 散文件没有可引用的家 |

★ **引用式导入删除时只注销条目，不动用户的原文件** —— 那可能是他的下载目录
（`main/svc.js` 的 `remove()` 只在 `dir` 位于 `svcRoot` 之下时才物理删除）。

每个模型一份 `model.json`：

```json
{ "id": "rvc-nene", "name": "ねね", "engine": "rvc", "version": "v2", "sr": 40000,
  "dir": "D:/…/下载/ねね", "files": { "model": "nene.pth", "index": "added_IVF….index" },
  "defaults": { "transpose": 0, "indexRate": 0.3, "filterRadius": 3, "rmsMixRate": 0.25,
                "protect": 0.33, "f0Method": "rmvpe", "chunkSec": 60 },
  "source": "folder", "lang": "日语", "work": "原神", "importedAt": "…" }
```

★ **探测值只是候选**：权重里真正写着什么只有加载才知道。`engine_svc.py probe`
用 torch 读出真实的 `version` / `f0` / `tgt_sr`，**与清单不一致就回写清单**（界面「校正」按钮）。

## 参数（界面：常用 + 高级折叠）

常用：变调（半音）、f0 算法、index 检索比例、清晰度（混音配平 dB）、设备。

高级（默认折叠）：

| 参数 | 默认 | 说明 |
|---|---|---|
| `filterRadius` | 3 | 中值滤波半径（≥3 才启用 index 检索） |
| `rmsMixRate` | 0.25 | 包络混入（1 = 完全用原唱包络） |
| `protect` | 0.33 | 保护清辅音/气声（0.5 最保险，低了电音、高了哑） |
| `chunkSec` | 60 | 分块秒数（长歌分块转换，防显存爆） |
| `autoPredictF0` | false | 自动预测 f0 曲线（变调时更稳） |

## 运行环境：新增 `kind=svc` 包

RVC 推理要 torch + faiss + contentvec/hubert 编码器 + rmvpe 权重 + pyworld。
这些**不塞进本体**，做成第四种包类型（`main/gpu.js`：`GPU_KINDS` 加 `svc`，`KIND_PY.svc='3.11'`，
`KIND_LABEL.svc='SVC 推理'`），用户在「加速包」页按需安装：

- 包内 `site-packages/` 装 torch 系 + faiss + pyworld；另带 `models/`（contentvec、rmvpe）——
  角色权重是用户导入的，**公共编码器随包走**；
- 模型目录里若自带 `encoder/*.pt` / `rmvpe.pt`，优先用自带的（有的模型绑特定编码器）。

包没装时，翻唱会**明确报「SVC 推理环境未就绪」并指向加速包页**，不假装能跑。

## 引擎骨架（`engine/engine_svc.py`）

```
probe   --model <dir>            读权重实际 version / f0 / 采样率
convert <in.wav> --model <dir> --out <wav> …   整轨变声
```

进度/结果协议与全引擎一致：`###PROG {json}` / `###RESULT {json}`（失败 = `ok:false` + 退出码 0）。

**当前状态（骨架）**：协议、参数、分块计划、依赖自检、断点签名都已就位；
RVC 推理照搬上游后落在 `engine/svc/vendor/rvc/`（MIT，保留声明），没就位时 `convert`
如实返回 `ok:false`，**不为了「看起来能跑」而假装成功**。

DDSP 本轮只留接口（清单能存 `engine:"ddsp"`、界面能显示，选了会提示「尚未支持」）。

## 断点续跑（沿用既有机制）

| 步骤 | 产物 | 复用条件 |
|---|---|---|
| 分离 | `sep/src_Vocals.wav`、`src_Instrumental.wav` | 文件在（`--vocals/--instrumental` 可外部指定） |
| 变声 | `svc/dry.wav` + `svc/dry.meta.json` | 模型指纹 + 人声轨 + 全部参数都没变 |

`--no-resume` 强制重算；`state.json` 记录进度。

## 已经删掉的（GPT-SoVITS 全套）

`engine/engine_gpt_sovits.py`、`engine/gsv_env.py`、`engine/gsv_align.py`、
`engine/tests/test_gsv_channel.py`、`main/gpt-sovits.js`；
`main/cover.js` / `main/models.js` / `ViewCover.vue` / `ViewModels.vue` / `preload.js` /
`types/ipc.ts` / i18n 里的 GSV 分支与文案；模型管理的「GPT-SoVITS 音色」分类。
`engine_cover.py` 的 `--voicebank` / `--gsv-*` / `--lyrics` / `--bpm` / `--steps` 一并移除。

## 相关文件

| 文件 | 作用 |
|---|---|
| `engine/engine_cover.py` | 编排 + 进度/结果协议 + 断点续跑 |
| `engine/engine_svc.py` | SVC 推理（probe / convert，含依赖自检） |
| `engine/svc/vendor/rvc/` | 上游 RVC 推理代码（MIT，照搬不改写）—— 待接入 |
| `main/svc.js` | 模型注册表：导入 / 列出 / 删除 / probe / 目录 |
| `main/svc-catalog.json` | 目录快照（`scripts/build-svc-catalog.js` 生成） |
| `main/cover.js` | 翻唱 IPC（选歌、跑、取消） |
| `frontend/src/views/ViewCover.vue` | 翻唱页 |
| `frontend/src/components/cover/SvcModelPanel.vue` | 翻唱模型：导入 + 已导入 + 在线目录 |
| `frontend/src/views/ViewModels.vue` | 模型管理（新增「翻唱模型」分类） |
