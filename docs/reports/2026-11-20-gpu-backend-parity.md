# GPU 后端对齐：参考 FlowHMR-Windows 补 ROCm 侧校验

- **参考项目**：https://github.com/xiaoerofficial021-collab/FlowHMR-Windows
- **日期**：2026-11-20
- **状态**：已完成「检测 + 校验 + 提示」这一层；架构包本身未做（需实卡与 GB 级构建）

## 一、参考项目做了什么

FlowHMR-Windows 是 Windows 视频动捕软件，GPU 运行环境的管理方式与本项目同构
（按需下载、多后端切换、目录并存）。它值得借鉴的有三点：

1. **ROCm 按显卡架构（gfx）分包**，索引是 AMD 官方
   [`repo.amd.com/rocm/whl-multi-arch/`](https://repo.amd.com/rocm/whl-multi-arch/)，
   每个架构一份 1.08–1.70 GB 的运行时；RX 5000/6000 用
   [AMD TheRock 的 Windows 架构包](https://github.com/ROCm/TheRock/blob/main/SUPPORTED_GPUS.md#rocm-on-windows)，
   与 AMD 的 Windows PyTorch 产品兼容表**不是同一套**。
2. **启用前跑真实算子**（FP16、卷积、注意力、稀疏张量），不只看 `torch.cuda.is_available()`。
3. **CUDA 多版本并存**：RTX 50 → cu128，RTX 20/30/40 → cu121，已装的 12.6/12.9 可保留；
   按设备推荐环境，而不是一个包打天下。

## 二、我们的现状（实测）

### 2.1 已有的

| 能力 | 位置 | 说明 |
|---|---|---|
| 三种增强包目录并存 | `main/gpu.js` | `cuda` / `rocm` / `xpu` / `rvc` 各自独立 `site-packages` + 精简视图（junction 只挂 torch 栈） |
| CUDA 架构护栏 | `engine/engine_gpu.py::arch_supported` | 算力 vs `torch.cuda.get_arch_list()`，issue #20 的失败模式已被拦住 |
| XPU 真实算子对拍 | `main/gpu-ipc.js::verifyXpuBackend` | 256×256 matmul vs CPU |
| ROCm 包构建 | `scripts/build-gpu-package-rocm.js` | ROCm 7.2 + cp312；解压 wheel 而非 pip install，避免二次安装把 `libraries_custom` 卸残 |
| Python 版本约束 | `main/gpu.js::fitsPython` | 以包内 `_C.cp3XX` 文件名为准，不看清单声明 |

### 2.2 实测出来的 ROCm 架构覆盖

直接扫本地 `rocm_sdk_libraries_custom-7.2.0-py3-none-win_amd64.whl`（1.9 GB 的那份）：

```
gfx1201 / gfx1200 / gfx1101 / gfx1100 / gfx1102 / gfx1150 / gfx1151   ← 只有这 7 个
```

对应 RX 9000（9070/9060）、RX 7000（7900/7800/7700/7600）、Radeon 800M 系核显。
**不包含**：RX 6000（gfx1030–1034）、RX 5000（gfx1010–1012）、Raphael 核显（gfx1036）、
740M–780M（gfx1103）——与 AMD 的 Windows PyTorch 兼容表一致，也正是 FlowHMR 用 TheRock 补的那部分。

### 2.3 原来的短板

`main/gpu-ipc.js::verifyTorchBackend('rocm')` 只检查 `torch.version.hip` 非空，
设备名写死成 `'ROCm GPU'`，既不取 gfx，也不跑算子。后果：
RX 6000 用户装完 1.9 GB，自检「通过」，第一次转录才炸 `no kernel image is available`。

## 三、本轮改动

### 3.1 新增 `main/gpu-arch.js`

- `ROCM_GFX_72`：7 个架构（scan wheel 得到，注释里写了复核命令）；
- `GFX_SERIES`：架构 → 显卡系列说明（只用于提示，未知不猜）；
- `normalizeGfx()`：从 `gcnArchName`（`gfx1100:sramecc+:xnack-`）里提取架构；
- `rocmGfxSupported()`：**信息不足返回 `null`（未知）**，不把「读不到」当成「不支持」；
- `rocmGfxHint()`：失败时的可操作说明（架构名 + 系列 + 支持的 7 个 + TheRock 方向 + CPU 兜底）。

### 3.2 `verifyTorchBackend` 增加 ROCm 专用路径

`verifyRocmBackend()`（结构与 XPU 对拍一致）：

1. `torch.version.hip` 非空才算 ROCm；
2. 取真实 `torch.cuda.get_device_name(0)`；
3. 取 `device_properties(0).gcnArchName`、`total_memory`、`torch.cuda.get_arch_list()`；
4. **真跑 256×256 matmul 并与 CPU 对拍**（`diff < 1e-2`）；
5. JS 侧再用 `rocmGfxSupported` 标注 `gfx_supported`：
   - 算子失败 → 把 `rocmGfxHint` 拼到错误前面，用户能直接看到「gfx1030 不在 7.2 包里」；
   - 算子通过但架构不在表里 → **放行**并写 WARN 日志（说明表滞后，该更新表而不是拦人）。

> 设计取向：**算子实测是事实，架构表只是解释**。表若拦住了实际能跑的卡，是表错；
> 算子跑不动才是真的不能跑。

### 3.3 测试

`frontend/tests/gpu-arch.test.js`（4 条）：
- `normalizeGfx` 取架构、脏值返回空、型号名不瞎猜；
- 表恰好 7 项、无重复、**老架构不得被误加**（加了就说明与实测 wheel 脱节）；
- 三态判定 true / false / null；
- 提示文案含架构名、系列名、TheRock 与 CPU 兜底。

## 四、还没做的（诚实清单）

| 项 | 为什么没做 | 需要什么 |
|---|---|---|
| RX 6000/5000、gfx1036、gfx1103 的 TheRock 架构包 | 要下载/构建 1 GB+ 运行时，且必须在对应实卡上验证完整转录 | 至少一张 RX 6000/5000 实卡；TheRock 的 Windows 架构包清单与许可核对 |
| ROCm 按架构**下载**（而不是固定一个包） | 现在只有一个固定包，按架构选包属于发行结构改动 | 先有架构包，再改 `build-gpu-package-rocm.js` 与资源中心清单 |
| CUDA 多版本并存（cu121 / cu128） | 当前统一 cu128；RTX 20/30/40 用 cu128 也能跑，只是包更大 | 发行侧要维护两份包与推荐表 |
| XPU 实机验证 | 仓库里已标注「未经实机验证」 | Intel Arc 实卡 |
| UI 显示 gfx / 架构状态 | 本轮只把字段放进校验返回值，没接界面 | 加速包页加一行（数据已具备） |

## 五、复现与验证

```bash
node --test frontend/tests/gpu-arch.test.js   # 4/4
node --check main/gpu-ipc.js main/gpu-arch.js
npm run test:ui                                # 660/660
```

重新扫 ROCm 包覆盖的架构（换包后必做）：

```bash
python -c "import zipfile,re,sys;z=zipfile.ZipFile(sys.argv[1]);print(sorted({m for n in z.namelist() for m in re.findall(r'gfx[0-9a-f]{3,4}',n)}))" \
  .workbuddy/tmp/rocm-wheels/rocm_sdk_libraries_custom-7.2.0-py3-none-win_amd64.whl
```

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-20 | 首版。参考 FlowHMR-Windows，补 ROCm 设备/gfx/算子校验与架构提示；列出架构包等未做项。 |
