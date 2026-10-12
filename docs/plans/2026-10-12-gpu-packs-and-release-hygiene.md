# GPU 加速包矩阵 + Release 治理 计划（2026-10-12）

## 0. 用户原话（本轮新增要求）

> 资源中心做「CUDA 加速包」可选下载，**所有转录模型都要有一份**。不但要有 CUDA，还要有
> **英特尔和 AMD 显卡的加速包**。
>
> 在 https://github.com/qdTXTbp/FuFumidi/releases?page=2#release-gpu-v2 里构建和更新加速包。
>
> 统一 release 各版本名称格式，一律 **FuFumidi 加上版本号 vx.x.x**。
>
> 删除预发行版本，以后有正式版后都提醒删除预发行版（**在仓库里设置提醒**）。

---

## 1. 现状（已核实，勿重复调研）

### 1.1 加速包体系**已经建好了**，不是从零做

| 位置 | 作用 |
|---|---|
| `engine/requirements-gpu-cuda.txt` | `torch==2.9.1+cu128` + `torchaudio==2.9.1+cu128` + `onnxruntime-gpu==1.20.2` |
| `engine/requirements-gpu-directml.txt` | `torch==2.4.1` + `torchvision==0.19.1` + `torch-directml==0.2.5.dev240914` + `onnxruntime-directml>=1.16` |
| `build-gpu-package.js` | 构建加速包；产物默认 `E:\Midi\安装包\FuFumidi\增强包`（`GPU_PACKAGE_OUT`） |
| `main/gpu.js` | 主进程服务：安装/卸载、**分卷合并**、类型识别、Python 版本约束、清单读写 |
| `main/gpu-ipc.js` | IPC + **安装后自检**（不只 `is_available()`，还比一次算力，不支持则返回 `archUnsupported`） |
| `engine/engine_gpu.py` | 设备选择 + issue #20 算力护栏 + 运行期 CUDA 报错自动退回 CPU |
| `engine/ort_compat.py` | 加速包里的 onnxruntime 建会话段错误时自愈，缓存 `ort-compat.json` |
| `main.js` | 只挂**与当前解释器 ABI 匹配**的加速包；没装隔离包时**强制 CPU**（防止宿主 PYTHONPATH 里的旧 GPU 包偷偷生效） |

**三种 kind（`main/gpu.js:20-23`，权威定义）**：

```js
const GPU_KINDS = ['cuda', 'directml', 'rocm'];
const KIND_PY   = { cuda: '3.11', directml: '3.11', rocm: '3.12' };
const KIND_LABEL= { cuda: 'CUDA', directml: 'DirectML', rocm: 'ROCm' };
```

- **cuda** —— NVIDIA（torch cu128 + onnxruntime-gpu）
- **directml** —— **AMD / Intel**（torch-directml + onnxruntime-directml）
- **rocm** —— AMD 较新 Radeon（ROCm 7.2；**只有 cp312 轮子，必须把解释器切到 3.12**）

### 1.2 `gpu-v2` release 里现在有什么（实测）

| 资产 | 体积 | 下载次数 |
|---|---|---|
| `fufumidi-gpu-cuda.zip.001` | 1900 MB | 14 |
| `fufumidi-gpu-cuda.zip.002` | 1121.1 MB | 15 |
| `fufumidi-gpu-directml.zip` | 237.7 MB | 17 |
| `fufumidi-gpu-rocm.part1` | 1024 MB | 2 |
| `fufumidi-gpu-rocm.part2` | 814.5 MB | 1 |

**资产命名不一致**：CUDA 是 `xxx.zip.001/.002`（分卷 zip），ROCm 是 `xxx.part1/.part2`（**没有扩展名**）。
`main/gpu.js` 的 `inferGpuKind()` 靠文件名里的 `cuda`/`directml`/`rocm` 关键字识别，所以目前能跑，
但对用户是两套写法，也不利于「分卷合并」按扩展名判断。**→ 统一成 `fufumidi-gpu-<kind>.zip.001/.002/...`。**

### 1.3 「所有转录模型都要有一份」——覆盖情况

| 转录模型 | 后端 | 靠哪个包加速 |
|---|---|---|
| MuScriptor | torch | cuda / directml / rocm |
| piano-transcription | torch | 同上 |
| Aria-AMT | torch | 同上 |
| Transkun | torch（子进程 `--device`） | 同上 |
| MSST 人声分离 | torch | 同上 |
| **Basic Pitch** | **onnxruntime**（不是 torch） | `onnxruntime-gpu` / `onnxruntime-directml`（两个 req 文件里都有）✅ |
| DiffSinger（调教）/ GPT-SoVITS（翻唱） | onnxruntime + torch | 同上 ✅ |

**结论：torch 系一个包全覆盖，onnx 系两个 req 文件里都已带上 → 已有的 cuda/directml 包在覆盖面上是完整的。**

### 1.4 本机实测（为什么这件事值得做）

- 显卡：**RTX 5070 Ti Laptop / 12227 MiB / compute_cap 12.0（Blackwell）/ 驱动 617.14**，**完全闲置**
- 内置运行时：`python 3.11.12` + **`torch 2.13.0+cpu`**（site-packages 里没有任何 `nvidia-*`）
- 后果：星铁 LIVE（120.5 分钟 / 1447 个 5 秒块）实测 **6.2 s/块 → 全程约 150 分钟**
- `engine_gpu.py` 的护栏已完整：`need_cu128`（Blackwell 需 CUDA ≥12.8，判断写成 `float(cuda) >= 12.8`，**cu130 也算通过**）、
  `arch_supported()`（issue #20）、`cuda_usable`、运行期报错 → 自动退回 CPU。**装错不会静默出错。**
- 索引实测：`download.pytorch.org/whl/cu128` 最高只到 **2.11.0**；**`cu130` 上有 `2.13.0+cu130`**（与内置版本一致）

---

## 2. 待办

### [ ] G1 加速包矩阵补齐 + 资产命名统一

- [ ] 资产命名统一为 `fufumidi-gpu-<kind>.zip.001`、`.002`…（含 rocm 改成 `.zip.00N`）
- [ ] 评估 CUDA 包是否从 `torch 2.9.1+cu128` 提到 **`2.13.0+cu130`**（与内置版本一致；cu128 上到不了 2.13）
- [ ] **Intel 专属 XPU 包（待用户拍板）** —— 见 §3 决策点
- [ ] 三个包都补 `SHA256SUMS` 与 `test:download` 用例（`docs/DOWNLOADS.md` 的硬规则）

### [ ] G2 在 `gpu-v2` release 里构建并更新

- [ ] 重新构建三个包 → 分卷 → 上传替换 `gpu-v2` 的资产
- [ ] 更新 release body 里的表格（体积/SHA256/适用显卡/所需 Python 版本）
- [ ] ⚠️ **上传前必须先确认**：用户此前说过「别发布和构建，先让我在安装包测试」——
      加速包不属于「程序发布」，但仍是**对外可见的下载物**，动手前应当确认一句

### [ ] G3 Release 名称统一为 `FuFumidi v{x.y.z}`

现状（66 个 release）三种写法并存：

| 写法 | 例子 | 处理 |
|---|---|---|
| name = tag | `v5.0.1`、`v5.0.0`、`v4.3.0`、`v4.2.x`、`v4.1.0` | 改成 `FuFumidi v5.0.1` |
| 规范 | `FuFumidi v4.4.1`、`FuFumidi v4.0.2` | 不动 |
| 旧格式 | `FuFumidi 3.2.9（新手引导修复）`、`FuFumidi 3.2.8（更新器原子写入修复）` | 改成 `FuFumidi v3.2.9`（括号内容移进 body） |
| 非程序通道 | `gpu-v2`、`soundfonts-v1`、`beta` | **保持描述性名称，不套版本号格式** |

- [ ] 写脚本批量改名（`gh release edit <tag> --title ...`），**先 dry-run 打印再执行**
- [ ] 在发布脚本 / CI 里固化为 `FuFumidi v${version}`，杜绝以后再漂

### [ ] G4 删除预发行版 + 仓库提醒

**⚠️ 不能一刀切删所有预发行版**（三个是资产通道，删了会断下载）：

| tag | 性质 | 处置 |
|---|---|---|
| `beta` | **测试通道锚点**，release body 明写「不要手动删除」 | **保留** |
| `gpu-v2` | GPU 加速包仓库 | **保留**（资产不能丢） |
| `soundfonts-v1` | SoundFont 镜像资产 | **保留** |
| `v5.0.0-beta.1` … `beta.6` | 已过时的程序预发行版（v5.0.0 正式版已发） | **删除**（6 个） |

- [ ] 删除 6 个 `v5.0.0-beta.*`（`gh release delete <tag> --yes`；是否连 tag 一起删要先确认）
- [ ] **在仓库里设置提醒**：发布正式版后提醒删预发行版。方案见 §4

---

## 2.5 用户决定（2026-10-12，已按此执行）

| 问题 | 决定 | 状态 |
|---|---|---|
| 加速包资产要不要统一命名成 `fufumidi-gpu-<kind>.zip.00N`？ | **不改**（保持 `cuda.zip.001/.002`、`rocm.part1/.part2` 原样） | ✅ 无需动作 |
| `FuFumidi 3.2.9（新手引导修复）` 这类标题改不改？ | **改**成 `FuFumidi v3.2.9` | ✅ 已执行（括号说明移进 body，不丢信息） |
| Intel 加速包？ | **方案 B：新增 `xpu` kind（`torch+xpu`）** | ⏳ 待做 |
| GitHub token | `C:\Users\qdTXTbp\Desktop\work\git\token令牌\新建 文本文档.txt`（40 字符 `ghp_`，账号 qdTXTbp） | ✅ 已验证可用 |

**G3 / G4 执行结果（已用 API 复核）**：

- release 总数 **66 → 60**（删掉 6 个过期的 `v5.0.0-beta.*`；**git tag 全部保留**，只删了 release 对象）
- 命名仍不符合 `FuFumidi v{x.y.z}` 的正式版：**0 个**（本轮共改名 18 个）
- 剩余预发行版：**3 个，且正好是必须保留的资产通道** —— `gpu-v2` / `beta` / `soundfonts-v1`
- 抽查 `v3.2.9`：name = `FuFumidi v3.2.9`，body 末尾 = `> 原标题里的补充说明：新手引导修复` ✅

### 执行中踩到的坑（重要，下次别重踩）

**`urllib` 拉 releases 列表会确定性截断。** 不请求 gzip 时单页约 650 KB，
实测**每次都断在同一个位置**（`http.client.IncompleteRead: 606148/652715`），
重试 4 次结果完全一样 —— 是确定性的响应截断，不是网络抖动，加重试没用。
**修法：加 `Accept-Encoding: gzip` 并解压**，体积降一个数量级就绕开了。
（同样的数据 `Invoke-RestMethod` 能正常拿到，所以「PowerShell 能取到」不代表 Python 也能。）

另外：**一次跑不完会被 run_code 的时限掐断**，但脚本是幂等的，重跑会接着做剩下的，
不会重复也不会漏（本轮就是跑了三次才把 18 个改名做完）。

---

## 3. 决策点：Intel 要不要单独一个 XPU 包？

用户说「还要有英特尔和 amd 显卡的加速包」。**AMD 有两个**（directml / rocm），
**Intel 目前只有 `directml` 这一条通用路径**。

| 方案 | 代价 | 收益 |
|---|---|---|
| A. 维持现状（DirectML 覆盖 Intel） | 零 | Intel 核显/Arc 都能用，但 DirectML 对 Arc 通常明显慢于 oneAPI |
| B. 新增 `xpu` kind（`torch+xpu`，Intel oneAPI） | 要改 5 处：`main/gpu.js` 的 `GPU_KINDS/KIND_PY`、`engine_gpu.py` 的设备选择、`main/gpu-ipc.js` 自检、界面文案，再加一个 req 文件 + 一个几 GB 的包 | Arc 独显提速明显 |
| C. 先只补齐 AMD（把 rocm 的资产命名/文档修好），Intel 留到有 Arc 用户反馈再做 | 小 | 避免为一个没有测试机的后端做几 GB 的包 |

**建议 C 或 B，取决于有没有 Intel Arc 机器可测。** 没有测试机的后端做出来无法验证 ——
这和「装了不匹配的 torch 会静默出错」是同一类风险，而 issue #20 就是这么来的。

---

## 4. 「以后有正式版后都提醒删除预发行版」的落地方式

| 方案 | 做法 | 评价 |
|---|---|---|
| **A. GitHub Actions（推荐）** | 新增 `.github/workflows/prerelease-reminder.yml`：`on: release: types: [published]`，若该 release **不是** prerelease，则创建/更新一个 issue（标题固定，避免刷屏），列出当前所有 prerelease 的 tag 与删除命令 | 真正的「仓库里设置提醒」；有记录、可关闭、不依赖谁记得 |
| B. 发布脚本里打印 | `scripts/upload-release-asset.py` 末尾打印提醒 | 只有执行发布的人看得到，容易漏 |
| C. 仓库 Issue 模板 / 固定置顶 issue | 人工维护 | 容易过期 |

**推荐 A**：workflow 里用 `GITHUB_TOKEN` + `issues: write`，先搜同标题 issue，有就追加评论、没有就新建，
这样不会每次发版都开一个新 issue。**并排除 `beta` / `gpu-v2` / `soundfonts-v1` 这三个资产通道**（否则会一直提醒删它们）。

---

## 5. 遗留：正在进行的长跑

星铁 LIVE 转录（带 `--dump-tokens`）在跑，实测 **6.2 s/块 × 1447 = 约 150 分钟**，
截至 `656/1447`。跑完自动触发分析（`_attic\_sing_tmp\analyze_long.py`）与 bf16 基准。
它的 token 流是回放台的燃料 —— 解码器问题可以离线反复复现，约 1 分钟一轮。

另：venv 试验台正在装 `torch 2.13.0+cu130`（**不动安装版**），用来实测 GPU 收益，
装好后可把 150 分钟的长跑压到约 10 分钟量级。