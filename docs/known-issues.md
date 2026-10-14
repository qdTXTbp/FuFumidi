# 已知问题（KI）

> 编号一旦分配不再复用。每条写清：**现象**（用户看到什么）、**根因**（代码级）、
> **现状**、**怎么验**（能复现的命令）。
> `build/nsis-custom.nsh` 里引用的 `docs/known-issues.md` 就是本文件。

---

## KI-1 卸载页排版：nsDialogs 静态控件不会自适应高度

- **现象**：卸载欢迎页（`customUnWelcomePage`）上的长句被控件高度裁掉 / 折行后看不全。
- **根因**：`nsDialogs::CreateControl` 建出来的静态控件（`${NSD_CreateLabel}`）**不按文本自适应高度**；
  100% 宽度下中文每行约 17~19 字，长句必然折行，高度必须按**行数**给（单行 `12u`、两行 `26u`，
  段间留 4~8u）。
- **现状**：2026-10-14 已按行数给高，见 `build/nsis-custom.nsh` 的 `un.fuUnWelcomeCreate`。
- **怎么验**（照抄即可；**不要用截图判内容**，见下面的坑）：

  ```powershell
  # 1) 编译预览包（.nsi 非 ASCII → 必须 Unicode true + UTF-8 BOM）
  makensis _attic\nsis-preview\preview.nsi
  # 2) 静默装到临时目录，再跑卸载器 -> 弹出真实卸载页
  _attic\nsis-preview\preview-setup.exe /S /D=%TEMP%\fufumidi-uninst-preview
  "%TEMP%\fufumidi-uninst-preview\Uninstall FuFumidi.exe"
  # 3) 枚举控件：文本 / 矩形 / 可见性 全部可读
  powershell -NoProfile -ExecutionPolicy Bypass -File _attic\tools\list-child-windows.ps1 -Match "Un_A"
  ```

  2026-10-14 实测输出（关键两行）：

  ```
  Static [542,462 450x39] 数据位置（模型 / 声库 / 音色库 / 曲库 / 设置）：
  ...\fufumidi-uninst-preview\FuFumidiData
  Button [542,510 450x18] 保留我的数据（推荐）—— 重装到同一目录后可继续使用
  ```

- **★ 验证方法上的坑（白排查了一轮）**：**`PrintWindow` 截 NSIS 自定义页会漏画控件。**
  nsDialogs 的 label 带 `WS_EX_TRANSPARENT`，`PrintWindow(hwnd, dc, 2)` 对它们**时画时不画** ——
  同一页里前两个 label 画出来了、第三个没有，看上去就像"标签丢了"。
  用 `EnumChildWindows` 一查：控件在、文本对、矩形对、`IsWindowVisible`=1。
  **结论：NSIS 页面的内容用"控件枚举"验；截图只用来验位图与整体观感。**
- **残留风险**：`数据位置` 那一行是 `$INSTDIR\FuFumidiData`，路径很长时会在第 2 行内折到第 3 行，
  而控件只有 2 行高（39 px）→ 会被裁掉。本机路径（`E:\Midi\FuFumidi\FuFumidiData`）远短于此，
  换到很深的安装目录要重新量。

---

## KI-2 中断的安装会留下「程序还在、应用和功能里没有条目」

- **现象**：`设置 → 应用` 里找不到 FuFumidi，但安装目录还在、程序也能启动，且无法从系统里卸载。
- **根因**：`build/nsis-custom.nsh` 的 `preInit`（electron-builder 的 `installer.nsi` 里最早的
  `.onInit` 钩子）会**先删掉**两处注册表键，装完再由 `registryAddInstallInfo` 写回：
  - `HKCU\Software\<APP_GUID>`（InstallLocation / KeepShortcuts / ShortcutName）
  - `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\<APP_GUID>`

  **中途取消 / 中断的安装**（以及用预览包走一遍卸载向导）会停在"删了、没写回"的状态。
- **现状**：`scripts/repair-install-registry.ps1` 按 electron-builder 的**同一组值**重建，
  幂等、只写注册表、不动文件；`-DryRun` 先看再写。
  `APP_GUID` 由 appId 经 UUID v5 派生（`NsisTarget.js:157`，命名空间 `50e065bc-3134-11e6-9bab-38c9862bdaf3`），
  `com.fufumidi.app` → `ee90ae64-4313-5a31-857b-d4c295bf71e7`，不随版本变。
- **怎么验**：

  ```powershell
  Get-ChildItem HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall | ForEach-Object {
    $p = Get-ItemProperty $_.PSPath; if ($p.DisplayName -like "*FuFumidi*") { $p.DisplayName; $p.UninstallString } }
  ```

  应看到 `FuFumidi` + `"E:\Midi\FuFumidi\Uninstall FuFumidi.exe" /currentuser`。

---

## KI-3 音频证据式收尾的**适用边界**：音频说"还在响"的长音符一律不动

- **现象**：某些段落仍有 20 秒以上的长音符。实测《星铁 LIVE 2024》26:20 那段（用户报的）：
  **86 颗 >8 秒的长音**里，15 颗被砍短、**5 颗被删掉**（音频里根本没有那颗音，含被拉成
  24.65 秒的 D1），其余 **66 颗保持原样** —— 判据说它们"音频里确实一直在响"。
- **根因（这是设计，不是漏修）**：判据只信音频，而用户明确要求
  「如果音频真的有这么长的音符，这就会误伤」。密集配器里同一个音高常被别的乐器/泛音填满，
  所以"这个音高在音频里一直在响"推不出"模型分给它的那件乐器真的在拉这个音" ——
  这一层证据（音色/乐器归属）目前拿不到，只能不动。
- **现状**：2026-10-14 第四版判据，见 `engine/engine_muscriptor.py::_make_pitch_evidence`：
  ① 有声 = 该音高突出（峰高于同八度邻域中位数）且有带内能量；
  ② 持续存在 = 0.5 秒窗里至少一半帧有声（单个鼓点接不上）；
  ③ 头部必须有支撑（起音峰 / 开头 1 秒有声 / 带内能量达自己后段的 25%）——
  ③ 不成立时返回 `EVIDENCE_DROP`，引擎把**整颗音删掉**（只砍尾巴会留下"前 20 秒空白"的假长音）。
  每次转录的日志里会给出计数：
  `音频证据式收尾：修正 N 颗长音符的收尾，删除 M 颗「音频里根本不存在」的音符`。
- **怎么验**：`pytest engine/tests/test_pitch_evidence.py`（合成音频）钉住四件事：
  真实延音不被误切（含"起音是尖峰"那一类）、到边界还在响就不动、头部无支撑才删、
  被配器盖住的弱音**不许**被判定为"不存在"。
- **部署注意**：证据钩子本体在**上游级补丁** `engine/patches/muscriptor-events-fufumidi.1.py` 里，
  它必须被复制到运行时的 `Lib/site-packages/muscriptor/events.py`；
  `scripts/deploy-installed.cjs` 只重建 app.asar，**不会**碰 `resources/python`（实测踩过）。

---

## 附：NSIS 脚本编码 / 宏作用域的两条硬要求

1. **`.nsi` / `.nsh` 里有非 ASCII 就必须 `Unicode true`，且文件存成 UTF-8 with BOM。**
   少了 BOM，`makensis` 直接报 `Bad text encoding: xxx.nsi:3` 并中止（实测）。
   `build/nsis-custom.nsh` 是带 BOM 的，别用不写 BOM 的编辑器存回去。
2. **`MUI_HEADER_TEXT` 在 `build/nsis-custom.nsh` 顶层不可用**：electron-builder 把这个文件
   放在 `MUI2.nsh` **之前** include，走到那里宏还不存在（实测报 `macro named MUI_HEADER_TEXT not found!`）。
   卸载页的页面标题由页面自己的 label 承担；`UninstPage` 的回调函数名**必须**带 `un.` 前缀。
