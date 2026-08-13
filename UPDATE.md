# 更新规范（Update Guide）

> 面向 FuFumidi 的后续维护与版本发布，AI 与开发者共用。发布前请先读 `AGENTS.md` 与 `CHANGELOG.md`。

## 一、版本号规则

| 变更类型 | 规则 | 示例（当前 1.0.1） |
| --- | --- | --- |
| 大功能更新 | 版本号 **+0.1** | 1.0.1 → 1.1.0 |
| 缺陷修补 / 小功能更新 | 版本号 **+0.0.1** | 1.0.1 → 1.0.2 |

- **大功能更新**：新增 / 重构显著功能面（如新引擎、新主视图、架构调整）。
- **修补和小更新**：bug 修复、预设 / 参数调整、界面细节、打包优化等。
- 每次只做一种加法，不要在同一版本里既 +0.1 又 +0.0.1。

## 二、版本号改哪里（必须同步改）

1. `app/package.json` → `"version": "x.y.z"`：决定安装包文件名（`FuFumidi-Setup-<version>.exe`）与系统版本信息。
2. `app/renderer/FuFumidi.html` → `const APP_VERSION = 'x.y.z';`：界面显示版本。

> 注意：`app/engine/music2midi.py` 里的 `VERSION` 是转录引擎 CLI 自身的版本号，独立维护，**不随应用版本号改动**。

## 三、每次更新必做清单

1. 按规则改版本号（上面两处）。
2. 在 `CHANGELOG.md` 顶部追加本次条目（新增 / 修复 / 备注），记录版本号与日期。
3. 全流程回归测试（详见 **四、测试流程与测试规范**）：
   - 安装 → 使用 → 卸载；
   - 转录至少一次真实文件（通用 / 钢琴 / 分离三种模式各至少一次）→ 智能修正 → 载入播放 / 编辑 / 乐谱。
4. 重建发布产物：
   - 内置运行时瘦身（可选，大幅减小安装包）：`node app/scripts/prune-python.js --commit`（只删 #38 点名的无运行期用途内容：`__pycache__` / `Lib/test` / `torch bin|share|include`；绝不碰依赖包）。`scripts/bundle-python.js` 构建后会自动调用它。
   - 安装包：在 `app/` 目录 `npm run dist:win`，产物 `FuFumidi-Setup-<version>.exe`。
   - 源码包：**必须用内置 python 跑 `scripts/pack-source-zip.py` 生成真 zip**（GNU tar `-a` 对 `.zip` 只会产出 ustar tar，Explorer 无法解压）。脚本会自动收录 `AGENTS.md` / `CHANGELOG.md` / `UPDATE.md` / `.gitignore` / `.github/` 与 `app/`（排除 python / node_modules / dist）。
   - 两份产物放桌面，替换旧版本；有问题的旧包不要留在桌面。
5. 用户确认「可以」之后才把新安装包对外发布（`AGENTS.md` 四.5「打包门禁」）。

## 四、测试流程与测试规范

> 目标：模拟真实用户交互，覆盖全部功能与选项；任一流程出问题就重新走一遍，直到完全通过。以下流程在 1.0.1 实测建立并验证，后续开发与更新沿用。

### 4.1 三阶段总流程

**阶段 A · 安装**
1. 卸载旧版后，静默安装新包到固定测试路径：
   `cmd //c "dist\FuFumidi-Setup-<ver>.exe /S /D=C:\Users\qdTXTbp\_fufuinst\FuFumidi"`
   （Git Bash 直传 `\` 会被吃成路径分隔符，必须走 `cmd //c` 转交。）
2. 验证安装完整：`resources\python` + `models\piano_transcription` 就位、桌面 / 开始菜单快捷方式存在、注册表卸载项版本号正确。

**阶段 B · 使用（核心回归）**

用 CDP 驱动真实 UI 交互（应用加 `--remote-debugging-port=9223` 启动），逐项执行：
1. 版本号与 `package.json` 一致。
2. **三引擎转录**：通用 / 钢琴 / 分离各至少一次真实音频 → 严格校验**临时目录出现带新时间戳的 `transcribe_*.mid` 文件**（不能只看 `TR_STATE.lastOut`，否则会读到上次残留的陈旧值）。
3. **智能修正**：转录后点「开始智能修正」，校验输出 `*_refined_*.mid` 新文件 + 统计日志（起音吸附 / 尾音修正 / 主奏轨道）。
4. **导入**：真实 MIDI（`E:\Midi\midi\*.mid`）→ 资料库计数 +1、当前歌曲加载正确；再验证播放 / 暂停（`App.player.playing` 为 true 且 `currentTick()` 递增）。
5. **预设系统**：内置预设切换自动套用参数（「钢琴：最优」→ mode=piano、最短音符 20ms）；排序 / 删除内置 / 恢复默认。
6. 七个视图逐一切换（演奏 / 编辑 / 可视化 / 分析 / 乐谱 / 转录 / 转换），每视图都能正确渲染当前歌曲。
7. 设置 / 主题库对话框打开与关闭正常。

**阶段 C · 卸载**
关闭应用 → 运行 `Uninstall FuFumidi.exe` → 验证安装目录删除、快捷方式移除、注册表卸载项清除。

### 4.2 CDP 实测要点（踩过的坑，务必遵守）

1. **文件选择**：CDP `DOM.setFileInputFiles` 注入的 File 没有 Electron 的 `.path` 属性，`fi.files[0].path || f.name` 会回退成纯文件名，引擎按相对路径解析必然报「找不到文件」。**正解**：模拟原生对话框，直接 `TR_STATE.audio = '<绝对路径>'` 并放行 `$('#btnTranscribe').disabled = false` 再点真实按钮。（真实用户走 `fuBridge.pickAudio()` 原生对话框或拖放，均返回绝对路径，不受影响。）
2. **校验任务真实执行**：点按钮后先等 `TR_STATE.jobId` 递增（证明事件到达），再等 `busy === false`，最后用临时目录快照对比确认新文件。只等 `busy===false && lastOut` 会在瞬时失败时读到残留旧值（假阳性）。
3. **音符数**从 `#convLog` 文本取（正则 `识别出 (\d+) 个音符`）；`#convInfo` 只显示「输出 …」，不含计数。
4. **导入去重**：`addToLib` 按 `name` 去重，重复导入同一文件不会新增条目——测导入要换不同文件或先清空资料库。
5. **后台进程**：用 Bash `run_in_background` 启动应用；普通 `&` 后台进程会随调用 shell 回收而退出。
6. **测试真实文件**：音频用 `C:\Users\qdTXTbp\Music\钢琴曲\*.mp3`（及裁剪的 `_fufutest\t20.wav`），MIDI 用 `E:\Midi\midi\*.mid`。
7. 测试残留脚本（`_apptest.js` / `_trtest.js` / `_diag.js` 等 CDP 驱动器）与临时 MIDI 输出用完即清，不进交付包。

### 4.3 通过标准
- 全部用例 PASS，且转录 / 修正产物为**新生成文件**（非历史残留）。
- 三引擎 + 修正 + 导入 + 播放 + 预设全绿；卸载后系统无残留。
- 任一环节失败 → 修复后**从该环节起重走完整流程**，直到完全通过；出问题的安装包 / 源码包不留桌面。

## 五、预设 / 参数修改注意

- 内置预设写在 `app/engine/presets.py` 的 `_builtin_presets()`；用户数据在 `engine/presets.json`（内置可隐藏 / 排序，勿直接手改该文件）。
- 新增预设参数键名必须与 `music2midi.py` 的 CLI 参数对应（`app/main.js` 里 `engine:convert` 的映射表）。
- 引擎模式默认预设映射在渲染器 `MODE_DEFAULT_PRESET`（`FuFumidi.html`）。

## 六、i18n 提醒

- 新增界面文案：中文为源文案写入 HTML；英文翻译加入渲染器 `I18N_MAP`；动态字符串用 `t('中文')`，静态文本由 `applyLang()` 自动替换。
