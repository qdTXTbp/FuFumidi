# FuFumidi 测试规范

本文件是 FuFumidi 的**测试基准**。任何版本在构建发布产物（NSIS 安装包 / kachina 离线包）之后、
上传到 GitHub Releases 之前，都必须按本规范完成验证。

---

## 0. 金科玉律（不可绕过）

> **所有全功能测试必须在「干净的 Windows 虚拟机」里进行。**
> 宿主机（开发者本机）**不算**测试环境；宿主机上跑通只代表代码没坏，不代表用户装得上。

原因：宿主机是「脏」的——已经装过 VC++ 运行库、Python、旧版本程序、注册表残留、缓存的模型、
曾经迁移过的数据目录。这些会**掩盖**干净环境才会暴露的问题：

| 只有干净虚拟机才能发现的问题 | 宿主机为什么发现不了 |
|---|---|
| 内置依赖缺失（缺 VC++ 运行库 / DLL） | 宿主机早已装过 |
| 首次启动路径假设（写死盘符 / 依赖 C 盘可写） | 宿主机目录已存在且有权限 |
| 数据目录迁移逻辑（旧位置→`FuFumidiData`） | 宿主机已迁移完成 |
| 模型/声库/音色库首次下载链路 | 宿主机文件已在本地 |
| 注册表/快捷方式/开始菜单项 | 宿主机是覆盖安装 |
| 卸载残留（文件、注册表、用户数据） | 宿主机很少真正卸载 |
| 覆盖安装/升降级（4.1.0 → 4.2.0） | 宿主机目录结构是历史演化来的 |
| 无网/弱网首次启动、镜像回退 | 宿主机网络已被反复调通 |

**因此：宿主机的自动化回归（`cdp-*.cjs`）是「开发期快速反馈」，不是发布闸门。发布闸门是本文第 3 节的虚拟机清单。**

---

## 1. 测试分层

| 层级 | 环境 | 目的 | 是否发布闸门 |
|---|---|---|---|
| L1 单元 / 引擎 | 宿主机 | `cargo test`、`pytest engine/tests`、i18n 覆盖检查 | 是（必须全绿） |
| L2 自动化回归 | 宿主机 + 本地安装版 | UI/功能回归（`cdp-*.cjs` 套件） | 是（必须全绿） |
| L3 **干净虚拟机全功能** | **干净 Win11 虚拟机** | 安装/使用/卸载全流程 + 全功能 | **是（必须全绿）** |
| L4 增量更新 | 虚拟机（旧版 → 新版） | 更新器差分下载 + 守护重启 + 数据不丢 | 是（必须全绿） |

L3/L4 只能在虚拟机里做，且必须从**基线快照**恢复后开始。

---

## 2. 虚拟机环境

### 2.1 宿主机前置条件

```powershell
# 一键自检（无需管理员）
powershell -ExecutionPolicy Bypass -File scripts/vm/test-vm-preflight.ps1
```

| 条件 | 要求 | 说明 |
|---|---|---|
| 系统 | Windows 10/11（家庭版可用） | 家庭版**没有** Hyper-V / Windows Sandbox，需第三方 hypervisor |
| 虚拟化 | 固件已开启（VT-x / AMD-V） | BIOS/UEFI 里开启 |
| 内存 | ≥ 16 GB（推荐 32 GB+） | 给虚拟机 8 GB |
| 磁盘 | 目标盘 ≥ 100 GB 可用 | 虚拟机约 80 GB |
| 权限 | **管理员** | 安装 hypervisor 必须提权 |

### 2.2 虚拟机规格

| 项目 | 值 |
|---|---|
| Hypervisor | VirtualBox 7.x（家庭版可用、自带虚拟 TPM 2.0） |
| guest | Windows 11 x64（正式版 ISO） |
| 规格 | 4 vCPU / 8 GB 内存 / 80 GB 动态磁盘 |
| 固件 | **UEFI + Secure Boot + TPM 2.0**（Win11 硬性要求） |
| 显卡控制器 | **VBoxSVGA**（`vmsvga` 下 Win11 会黑屏且无 ACPI 响应，勿用） |
| 目录 | `E:\VMs\FuFumidiTest\`（宿主机盘符按实际可用空间调整） |
| 网络 | NAT（与宿主机共享网络） |
| 共享/剪贴板 | 共享文件夹 `\\?\E:\Midi\安装包` 挂到虚拟机 `Z:`，便于取安装包 |

### 2.3 部署

```powershell
# 需管理员：装 VirtualBox + 下载 Win11 ISO + 建好虚拟机（含 TPM/SecureBoot）
# 首次会用 unattended 方式无人值守安装 Win11；完成后自动打基线快照
powershell -ExecutionPolicy Bypass -File scripts/vm/deploy-test-vm.ps1
```

部署脚本会：
1. 自检（提权 / 虚拟化 / 磁盘 / 内存）
2. `winget install Oracle.VirtualBox`
3. 下载 Windows 11 官方 ISO 到 `E:\VMs\_iso\`
4. 用 `VBoxManage` 建虚拟机：UEFI + Secure Boot + TPM 2.0 + 80 GB
5. 无人值守安装 Windows 11（跳过 OOBE，创建 `tester` 账号）
6. 安装完成后**打基线快照 `clean-baseline`**（这是后面每轮测试的起点）

### 2.4 每轮测试的起止

```powershell
# 开始一轮测试：回滚到干净基线并启动
powershell -ExecutionPolicy Bypass -File scripts/vm/reset-test-vm.ps1

# ... 在虚拟机里按第 3 节清单测试 ...

# 结束时关闭虚拟机（不保留状态）
powershell -ExecutionPolicy Bypass -File scripts/vm/stop-test-vm.ps1
```

> **纪律**：每轮测试**必须**从 `clean-baseline` 回滚开始。
> 不允许「上一轮装过的虚拟机继续用下一轮」，否则等价于宿主机那种脏环境，失去全部意义。

### 2.5 在虚拟机里执行命令

用 `guest-run.ps1` 把一段 PowerShell 送进 guest 执行并取回 UTF-8 输出：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/vm/guest-run.ps1 -ScriptPath .\probe.ps1
```

> 不要直接用 `VBoxManage guestcontrol ... -- powershell -Command "..."`：
> VBoxManage 会剥掉参数里的引号（带空格的命令必被拆散），且 stdout 按本地代码页解码，中文全乱码。

`guest-probe.ps1` 是现成的环境自检（系统版本 / 身份 / 时间 / 硬件 / 分辨率 / 网络连通性 / 是否已装被测程序），
每轮测试开始前先跑一次，确认基线符合本节规格。

配套工具（`scripts/vm/`）：

| 脚本 | 用途 |
|---|---|
| `test-vm-preflight.ps1` | 部署前自检（虚拟化 / 磁盘 / 工具链 / ISO） |
| `deploy-test-vm.ps1` | 建虚拟机 + 无人值守装 Win11 |
| `make-baseline.ps1` | 关机并创建基线快照 `clean-baseline` |
| `reset-test-vm.ps1` | 回滚到基线并启动（每轮测试的起点） |
| `stop-test-vm.ps1` | 关闭虚拟机 |
| `guest-run.ps1` | 在 guest 内执行 PowerShell 并取回输出 |
| `guest-probe.ps1` | guest 环境自检 |

### 2.6 宿主机 Hyper-V 的性能陷阱

若宿主机启用了 Hyper-V / VBS（`HvHost`、`vmcompute` 在运行，或「内核隔离 → 内存完整性」开启），
AMD-V 会被 Windows 虚拟机监控程序独占，VirtualBox 只能退回 **NEM 模式**
（日志出现 `NEM: Snail execution mode is active!`）。

后果：安装 Windows 就要 1 小时以上，guest 会长时间无响应、黑屏、ACPI 关机不生效。
要拿到可用的测试速度，**必须**在宿主机上关掉 Windows 虚拟机监控程序后重启：

```powershell
# 管理员执行，之后重启宿主机；恢复用 auto
bcdedit /set hypervisorlaunchtype off
```

> 副作用：依赖 Hyper-V 的功能（WSL2、Docker Desktop、部分安卓模拟器等）在关闭期间不可用。

### 2.7 宿主机 L2 探针套件（`scripts/cdp/`）

L2 的 CDP 探针已收入仓库，不再散落在打包目录里。统一约定：

| 项 | 约定 |
|---|---|
| 目标 | 本地安装版渲染进程，需带 `--remote-debugging-port=9222` 启动 |
| 端口 | `CDP_PORT`（默认 9222） |
| 单段表达式 | `CDP_OUT_DIR` 无关；`cdp-eval.cjs` 用 `EXPR_FILE` 传入表达式文件（避免 PowerShell 拆坏引号） |
| 输出目录 | `CDP_OUT_DIR`（默认脚本所在目录），写报告类脚本使用 |
| 极密压力曲目 | `CDP_MIDI`（默认脚本同目录的 `large-60k.mid`）。仓库不含该二进制样本，用任意 ≥100 音符/秒的 MIDI 替代即可 |

```powershell
cd scripts/cdp
$env:CDP_PORT='9222'
node cdp-viz-immersive.cjs        # 可视化沉浸 / 瀑布流 / 帧内绘制（含 26 项断言）
node cdp-fx-tempo.cjs             # 音效链 + 倍速
node cdp-fx-gain.cjs              # 音效链增益（固定测试音、时对齐）
node cdp-init-recovery.cjs        # 音频初始化稳健性（注入故障后能否恢复）
node cdp-frametime-probe.cjs      # 帧交付间隔（可视化页瀑布流，需 SONG=normal|heavy）
node cdp-guide-walk.cjs           # 新手引导全章节逐步走查（每步的选择器都要真实可解析）
$env:EXPR_FILE='.\expr-spatial-channels.js'; node cdp-eval.cjs    # 空间声声道分离度
$env:EXPR_FILE='.\expr-viz-drawcost.js';     node cdp-eval.cjs    # 帧内绘制耗时 / 渐变数
$env:EXPR_FILE='.\expr-dense-fix.js';        node cdp-eval.cjs    # 极密曲目丢音（内置合成器路径）
```

> 探针里的 `expr-*.js` 是「单段被测代码」，必须与断言口径一起看：例如
> `expr-spatial-channels.js` 判「居中信号不变」用的是**同源同相同频**的 L/R，
> 用两路不同频率的振荡器测「居中」是无效的（L-R 本来就不为 0）。

---

## 3. 干净虚拟机全功能测试清单（发布闸门）

每轮测试按顺序执行，逐项勾选并记录结果（含截图/日志路径与失败现象）。

### A. 全新安装
- [ ] 断网状态下运行 `FuFumidi Setup X.Y.Z.exe`，确认安装器能正常启动（不因缺网络/缺依赖报错）
- [ ] 选择安装目录（含带空格/中文的路径各测一次），安装完成无报错
- [ ] 开始菜单 / 桌面快捷方式创建正确，图标正常
- [ ] 安装目录内**包含内置环境**：`resources\python`、`resources\app.asar`、`resources\rust-core`、`FuFumidi.update.exe`
- [ ] 连接网络后首次启动：能进入主界面，无白屏/长时间卡死

### B. 首次启动与数据目录
- [ ] 首次启动自动创建 `<安装目录>\FuFumidiData`（models / gpu-enhancements / soundfonts / voicebanks / midi / cache / temp / logs）
- [ ] 若存在旧位置数据（C 盘用户目录），出现迁移进度窗，迁移后旧位置不再被读取
- [ ] `设置 → 数据目录` 显示正确路径与各条目体积
- [ ] 确认**没有**在 C 盘用户目录产生新的模型/缓存（`%USERPROFILE%\.cache`、`AppData\Local\pip\cache`、`%USERPROFILE%\.matplotlib` 为空或不存在）

### C. 模型下载
- [ ] `资源管理 → 模型管理`：每个模型可下载，进度正常、断点续传可用
- [ ] Beat This（`beat_this-final0.ckpt`）走分段并行下载，校验 SHA256 通过
- [ ] 弱网/中断场景：自动换源重试，错误文案可读（非 `The operation was aborted`）
- [ ] 下载完成后模型落在 `FuFumidiData\models`，不占 C 盘

### D. 曲库与文件
- [ ] 导入 MIDI：每个曲目都生成真实 `.mid` 落到 `FuFumidiData\midi`
- [ ] 无空壳曲目（`曲库文件体检` 无“无主文件/损坏曲目”）
- [ ] 右键菜单：`打开所在文件夹` / `从歌单移除`（仅移出歌单、文件保留）/ `删除（含本地文件）`（文件被删）
- [ ] 歌单数量与曲目数一致

### E. 转录
- [ ] 导入音频 → 转录跑通，产出 MIDI 可播放
- [ ] 诊断包无 `missing`（aria/amt/ariautils/orjson 等依赖齐备）
- [ ] 转录期间界面可交互（不卡死）

### F. 编辑
- [ ] 钢琴卷帘：画笔/橡皮/选择/静音四工具可用，拖拽移动、边缘拉伸、Alt 拖拽调力度生效
- [ ] 撤销/重做、量化、音阶约束、和弦轨、演奏法库（Key Switch）可用
- [ ] **大 MIDI（≥5 万音符）加载与操作不卡顿**（这是 4.2.0 的性能修复点）
- [ ] 高级功能栏（「更多」）展开后不影响卷帘可用高度，无错位/裁切
- [ ] CC 泳道、歌词、波形对齐、视频轨可用

### G. UTAU 工作台
- [ ] `声库制作 → 浏览免费声库`：3 个声库可一键下载安装，装完自动成为当前声库
- [ ] 声库落到 `FuFumidiData\voicebanks`，`合成渲染` 能真实渲染出 WAV
- [ ] `曲谱与调声`：别名替换、参数车道、颤音/性别/气声与 flags 生效
- [ ] 导入本地 zip 声库、导出声库压缩包可用

### H. 转译 / 其他
- [ ] 转译（Convert）流程可用
- [ ] 乐谱 / 可视化 / 歌词 / 演奏页可用
- [ ] 多语言：简体 / 繁体 / 英文 / 日文 四语言切换后界面无残留源文案、无错位
- [ ] 深色 `studio` 主题切换正常

### I. 增量更新（L4，需先装旧版）
- [ ] 虚拟机里装上一个已发布旧版（如 4.1.0），确认可运行
- [ ] `设置 → 更新 → 检查更新` 能发现新版本
- [ ] 更新器下载差分包、替换文件、守护进程自动重启到新版本
- [ ] **更新后 `FuFumidiData` 完好无损**（曲库数、模型、声库、音色库数量与更新前一致）

### J. 卸载
- [ ] 通过 `设置 → 应用` 或安装目录的 `Uninstall FuFumidi.exe` 卸载成功
- [ ] 卸载后：安装目录内程序文件被清除、快捷方式被移除、注册表卸载项被清除
- [ ] 卸载时弹窗询问是否一并删除数据：选「否」（默认）→ `FuFumidiData` 保留在安装目录，
      重装到同一目录后可继续使用；选「是」→ 连同模型/声库/曲库一起清除；静默卸载 `/S` 一律保留
- [ ] 再次全新安装可成功（无“已安装”误判，验证 `build/nsis-custom.nsh` 的注册表清理生效）

---

## 4. 结果记录

每轮测试产出 `docs/test-reports/YYYY-MM-DD-vX.Y.Z-vm.md`，模板：

```markdown
# vX.Y.Z 干净虚拟机测试报告

- 日期 / 测试人：
- 宿主机：Windows 11 家庭版 / AMD Ryzen 9 9955HX / 61.7 GB
- 虚拟机：VirtualBox 7.x / Win11 x64 / 4 vCPU / 8 GB / 80 GB
- 基线快照：clean-baseline（创建于 YYYY-MM-DD）
- 被测产物：FuFumidi Setup X.Y.Z.exe (SHA256 ...) / FuFumidi.Install.X.Y.Z.exe (SHA256 ...)

## 结论
- [ ] 通过 → 可发布
- [ ] 不通过 → 列出问题与复现步骤，修复后**重跑整份清单**（不允许只重测失败项）

## 明细
| 项 | 结果 | 证据 | 备注 |
|---|---|---|---|
| A-1 断网安装 | PASS | 截图 xx.png | |
| ... | | | |

## 发现的问题
1. ...
```

---

## 5. 与自动化回归的关系

- 宿主机自动化套件（`asar-deploy/cdp-*.cjs`）在提交前跑，用于快速发现回归。
- 自动化**不能**替代第 3 节清单；第 3 节清单不能替代自动化。
- 发布流程（见 `UPDATING.md`）在构建产物之后、上传 GitHub 之前，**必须**附上第 4 节的虚拟机测试报告。
- 若因客观原因（如无可用虚拟化环境）无法完成第 3 节，**必须在报告中显式声明未验证项与风险**，不得默认视为通过。

---

## 6. 相关文件

| 文件 | 用途 |
|---|---|
| `scripts/vm/test-vm-preflight.ps1` | 宿主机前置条件自检（无需管理员） |
| `scripts/vm/deploy-test-vm.ps1` | 部署测试虚拟机（**首次装 VirtualBox 需管理员**；已装好则普通权限即可；支持 `-DryRun` 预演） |
| `scripts/vm/make-baseline.ps1` | 系统装完后打基线快照 `clean-baseline` |
| `scripts/vm/reset-test-vm.ps1` | 回滚到 `clean-baseline` 并启动（每轮测试起点） |
| `scripts/vm/stop-test-vm.ps1` | 关闭虚拟机（可加 `-Revert` 顺手回滚） |
| `UPDATING.md` | 版本发布流程 |
