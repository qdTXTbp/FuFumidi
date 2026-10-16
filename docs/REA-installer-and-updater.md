# 安装 / 卸载 / 更新：对齐 BetterGI 与 FufuLauncher 的取证记录

**日期** 2026-10-14 · **方法** REA（静态取证：程序集字面量 / 配置 / 资源清单）
**被测对象**（用户机器上的安装版，**全程只读**）

| 对象 | 字节 | SHA-256（前 16） | 形态 |
| --- | --- | --- | --- |
| `D:\miHoYo Launcher\BetterGI\BetterGI.exe` | 111,164,958 | `73732f440bc8ff3b` | .NET 自包含（含 WPF BAML） |
| `D:\miHoYo Launcher\BetterGI\BetterGI.update.exe` | 9,910,837 | `75ac150810c10d28` | NativeAOT · **kachina** |
| `D:\miHoYo Launcher\BetterGI\BetterGI.uninst.exe` | 6,362,939 | `41a920e342c5f288` | NativeAOT |
| `D:\FuFu\FufuLauncher\FufuLauncher\UpdateFufuLauncher.exe` | 5,400,424 | `666d131a5e5adf38` | .NET IL（CLR 元数据在） |
| `…\FufuLauncher\unins000.exe` | 5,025,190 | `7f8c6274691a7c87` | **Inno Setup** |
| `…\FufuLauncher\Update.json` | 190 | `17a6be6fed86ad06` | JSON（版本 + 信息页 URL） |

**拆解纪律**：只在 `E:\Midi\_attic\rea-refs\` 里分析副本（哈希清单 `MANIFEST.json`），
`D:\` 下的原件一个字节都没改。

## 1. 最重要的一条：BetterGI 的安装器**就是 kachina**

`BetterGI.update.exe` 与我们的 `tools/kachina-builder.exe` 出现**同一批**内部字面量：

```
uninstallName:"uninst.exe", updaterName:"update.exe", programFilesPath:"Kachina"
uacStrategy:"prefer-admin", windowBorderless:!1
src\thirdparty\mirrorc.rs        ← 差分补丁（changes.json / .metadata.json）
steambird.cocogoat.cn/insight/kachina-installer/
```

也就是说：**本项目的安装/卸载/更新程序与 BetterGI 是同一个框架**（`scripts/build-kachina.ps1`
的文件头注释 "BetterGI style" 是字面意思）。它的 UI 是 **Tauri 2.10 + Vue 3 + Fluent 组件**
（`fui-Spinner__spinner` / `step-desc` / `card-container`，源列表是一叠可点的卡片），
还有 `mirrorc://` 与 `KachinaInstaller_MirrorChyanCDK_<app>`（Mirror酱 CDK 存在 Windows 凭据管理器）。

**推论（决定了本次怎么改）**：kachina 的页面结构在**闭源打包器**里，我们只能配
`build/kachina.config.json` 的 schema（source / title / description / windowTitle / uacStrategy /
图标 / `-t` 左图）。所以"**能改、能测**的安装界面是我们自己的 NSIS 安装包与卸载器，
而**测速选源**落在应用自己的更新页（那里我们有全部源码与测试）。

## 2. BetterGI 的"测速更新"到底是怎么做的

字面量与类型名（`BetterGI.exe`）：

- `BetterGenshinImpact.Helpers.Http.ProxySpeedTester`
  → `GetFastestProxyAsync`（d__2/d__3）、`GetFastestUrlAsync`（d__4）、**`TestUrlAsync`（d__5）**
  → **并发试多条线路、拿一个小测试文件量时间，取最快的那条**。
- 更新源是**二选一**：`您已选择「Github」作为更新源。` / `您已选择「Mirror酱」作为更新源`；
  `UpdateFromMirrorChyan`（Mirror酱 = 付费第三方加速）。
- UI 侧有 `节点 ` 这样的列表项字面量。

**我们抄的是机制，不是它没有的东西**：BetterGI 主程序里没有"每条线路一张表 + 延迟/速率列"
的现成界面（那部分在 kachina 的闭源 UI 里）。所以我们的落地形态来自两边的并集。

## 3. FufuLauncher 的更新器（本次 UI 的直接参照）

`UpdateFufuLauncher.exe` 里抽到的字面量（原文）：

```
正在测速中...            请先在列表中选择一个可用节点
 MB/s                    站点线路下载失败，已经切回GitHub线路
下载缓慢 / 下载进度长期未动或网络极慢，建议取消当前下载并更换其他节点尝试
这个安装包看起来好像有问题，没有通过数字签名校验   ← 装前校验
下载的文件SHA-256校验失败，文件可能在传输过程中被损坏或篡改
```

- 界面是**节点列表 + 测速 + 速率列**（` MB/s`），失败自动切回 GitHub；
- 通道只有两档（`Update.json` 的 `Version` 与 `PreReleaseVersion` + 两个信息页 URL）；
- `Assets/mirrors.json` 是**镜像清单**：`ProbeUrl` + `ProbeMd5` + 44 个镜像域名 ——
  **用固定小文件 + 哈希校验判断镜像是否真的可用**（只看 HTTP 200 不够）。
- 安装/卸载走 **Inno Setup**（`unins000.exe`）。

## 4. 本次落到 FuFumidi 的三件事

### 4.1 更新线路测速（应用内，新功能）

| 参考 | 我们的实现 |
| --- | --- |
| BetterGI `TestUrlAsync` 小文件取样 | 每条线路 `Range: bytes=0-262143`，**只取 256 KB 就 cancel** |
| BetterGI `GetFastestProxyAsync` 取最快 | 并发 3（再多会互相抢带宽），`pickBest`：可用优先 → 速率 → 延迟 |
| FufuLauncher「正在测速中…」+ 列表 | 主进程测一条 `update:speedtest:progress` 回一条，表格**一条条亮起来** |
| FufuLauncher ` MB/s` 列 | 每行显示「延迟 ms + 速率 MB/s」，最快那条高亮并标「最快」 |
| FufuLauncher 失败切回 GitHub | 选中的线路只是**提到最前**，不可达时沿回退链自动换源（不是硬绑定） |
| FufuLauncher `ProbeMd5` 内容校验 | 首块必须 `MZ`（PE 头）—— 镜像返回 200 但塞拦截页时判为失败，不让用户选一条会下载失败的"最快"线路 |

代码：`main/update-speedtest.js`（纯函数）· `main/update.js`（`update:sources` /
`update:speedtest` / `update:setPreferredSource`）· `frontend/src/core/speedtest.js`（呈现层）·
`SettingsPanel.vue` 的更新页；测试 `scripts/test-update-speedtest.mjs` + `frontend/tests/speedtest.test.js`。

**本机实测**（stable 通道，2026-10-14）：

```
cnb          延迟   783 ms     1.56 MB/s   实收 256 KB
ghfast       延迟  4886 ms     0.09 MB/s   实收 256 KB
ghproxy      延迟  2250 ms     0.23 MB/s   实收 256 KB
ghproxy-net  不可达：This operation was aborted
github       不可达：This operation was aborted
```

—— 这正是以前界面上看不到的信息：CNB 比 ghfast 快约 17 倍，而 GitHub 直连在本机根本不通。

### 4.2 安装 / 卸载界面

- `build/installerSidebar.bmp`（164×314）与 `build/installerHeader.bmp`（150×57）：
  NSIS 默认是一块白板，与软件的深色 + 青蓝完全不搭。两张图**代码绘制**
  （`scripts/gen-installer-art.py`，Pillow），产物提交进仓库，构建不需要跑脚本。
- 卸载从**裸 MessageBox** 改成**真正的页面**（`customUnWelcomePage`，替换默认卸载欢迎页）：
  默认选中「保留我的数据」，写明数据在哪、删了不可恢复；静默卸载（`/S`）不显示页面，
  仍按「保留」处理（与既有安全语义一致）。选择经 `$PLUGINSDIR\fu-uninstall.ini` 传给
  `customUnInstall` —— 用文件而不是全局变量，是因为该文件在安装器那一遍也会被 include，
  顶层 `Var` 会触发 warning 6001，而 electron-builder 把警告当错误。
- `electron-builder.yml`：`installerIcon` / `uninstallerIcon` / `installerHeader` /
  `installerSidebar` / `uninstallDisplayName`。
- kachina 侧（schema 允许的范围内）：`windowTitle` 改为「FuFumidi 安装 / 更新」，
  `build/updater-left.webp`（180×400，构建脚本用 `-t` 传进去）重画为同一套语言。

**品牌资产流水线（换 logo 时只改一处）**：

```
docs/assets/logo-master.png           母图，只此一份（1.2 MB，docs/ 不打进安装包）
      │  scripts/gen-logo.py          取「头部特写」+ 透明底 → 512/460/ICO
      ▼
build/icon.png  build/icon.ico  frontend/src/assets/logo.png  docs/assets/logo.png
      │  scripts/gen-installer-art.py （圆角方块卡 + 暗场 + 柔光 + 倒影）
      ▼
build/installerSidebar.bmp  build/installerHeader.bmp  build/updater-left.webp
```

两个实测过的坑（都写进 `scripts/gen-logo.py` 的注释里了）：① **母图本身可能就是透明底**
（看着是白底，其实查看器把透明合成到白上），这时再「去白底」会把图标变成黑底不透明；
② 图标取景**不能用 alpha 边界框中心** —— 魔杖和帽子蕾丝会把中心带偏，要用肤色像素的中位数。
另：`resources/icon.png`（窗口 / 托盘用）是 `extraResources` 落的，`asar` 里不含，
所以 `scripts/deploy-installed.cjs` 现在会一并同步 extraResources 并校验 muscriptor 补丁。

### 4.3 验证方式（哪些是"看过的"，哪些只是"编译过"）

- **编译过**：`makensis` 用独立 harness 编译了改后的 `build/nsis-custom.nsh`
  （`_attic/nsis-check/`，产出 42 KB `check.exe`），nsDialogs / LogicLib / MUI_HEADER_TEXT 全部通过。
  **没有跑 electron-builder 生成发布包**（用户明确要求先不构建发布物）。
- **跑过真页面**（2026-10-14 补）：`_attic/nsis-preview/` 里有两个独立 harness —— `preview-install.nsi`
  （欢迎页 / 目录页 / 完成页，看侧栏与页眉）与 `preview.nsi`（卸载向导，看保留数据那一页）。
  静默装到 `%TEMP%\fufumidi-uninst-preview` 再跑卸载器，就是真实卸载页；
  预览包**不碰**注册表与用户目录（`.nsi` 里没有 `!insertmacro preInit`，`$INSTDIR` 被改到 `%TEMP%`）。
- **看过像素**：侧栏 / 页眉 / 更新器左图三张都导成 PNG 逐张看过（中文未出现豆腐块、暗场不发灰）。
  侧栏倒影一度铺到文字区、把下面的字"透"出来，已改成"只取底部一条 + 纵向压缩 + 渐隐"。
- **★ 验内容靠控件枚举，不靠截图**：`PrintWindow` 截 NSIS 自定义页会**漏画**带 `WS_EX_TRANSPARENT`
  的 label，看上去像"标签不见了"；用 `EnumChildWindows` 读文本 / 矩形 / 可见性才是准的。
  方法与实测输出见 [docs/known-issues.md](known-issues.md) KI-1。
- **跑过网络**：上表的实测数字由与主进程同一套算法（256 KB Range + 扣延迟算吞吐）跑出。

### 4.4 安装中断遗留的状态：注册表项没了

`preInit` 先删键、装完再写回 —— 中途取消（或用预览包走一遍卸载向导）会留下
「程序还在、`设置 → 应用` 里没有条目」。`scripts/repair-install-registry.ps1` 按
electron-builder 的同一组值重建两处键（幂等、只写注册表）。详见
[docs/known-issues.md](known-issues.md) KI-2。

## 5. 明确没抄的

- **不引入 Mirror酱 / `mirrorc://`**：那是付费第三方加速 + Windows 凭据管理器里的 CDK，
  与本项目"离线可用、不引入账号体系"的定位冲突。
- **不引入 Electron 之外的自研安装器**：kachina 是上游给的，重写等于换掉整条发布链。
- **不动那两个工具的任何文件**（只读 + 副本分析）。
