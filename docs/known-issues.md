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

## KI-4 MuScriptor 长音频「僵尸音墙」：音频证据在密集配器里兜不住（2026-10-15 实测）

- **现象**：《星铁LIVE 2024》120 分钟录播转出的 MIDI（`E:\Midi\midi\output\…m4s (1).mid`，116,806 音）
  在 **105 分钟**开始出现"一片密集音符"：同时发声数从 105 分钟前的 8~14 跳到
  **67（105–106 min）→ 157（106–107 min）→ 179（110–111 min）**，音高铺满 16~127。
- **不是音频、不是电平、不是阈值**：105 分钟处音频 RMS ≈ −16 dBFS、峰值 0.72、无削波、无直流；
  全曲体检 噪声底 −56.2 dBFS / 动态范围 38 dB / 峰值 −1.9 dBFS。**音符"起点"速率没变**
  （104–105 min 1125 个/分、105–106 min 729、106–107 min 1743 —— 与更早的响段 1091~1955 同量级），
  变的是**音符不肯结束**：
  | 时刻 | 同时开着的音 | 最老年龄 | 最长音 |
  |---|---:|---:|---:|
  | 6200 s | 3 | 1 s | 2 s |
  | 6300 s | 0（31.7 s 空檔） | — | — |
  | 6360 s | 42 | 20 s | 47 s |
  | 6420 s | 157 | 57 s | **408 s** |
  | 6600 s | 148（15 个已开 >60 s） | 230 s | 408 s |
  | 6800 s | 11 | 0 s | 0 s |
  全曲最长的音：pitch 79 **6370.0 s → 6777.8 s = 407.8 s（6.8 分钟）**；pitch 91 = 299 s。
  即 **~6360 s 起模型停止吐 note-off，~6778 s 才恢复** —— 与"105 分钟起一片密集"完全对上。
- **机理（代码里早有记录）**：上游在块边界把 `tracker.open_keys()` **无条件**塞进 tie 段
  （`transcription_model.py:554`），模型被反复告知"这些音还在响"，于是一个音**只能靠模型显式吐
  note-off 才结束**；模型在长音频里漏一次收尾，这颗音就被强制延续
  （见 `engine/patches/muscriptor-events-fufumidi.1.py:47-56`）。
- **为什么现有的「音频证据式收尾」没拦住（KI-3 的边界，实测数字）**：把**全曲**音频过一次证据函数，
  再用它判用户那份 MIDI 的音符：

  | 窗口 | 音符 | 保持原样 | 收尾提前 | 整颗删除 |
  |---|---:|---:|---:|---:|
  | 104–105 min | 1125 | 1125 | 0 | 0 |
  | 105–106 min | 729 | 723 | 6 | 0 |
  | 106–107 min | 1743 | 1733 | 10 | 0 |
  | 107–108 min | 1190 | 1174 | 15 | 1 |
  | 110–111 min | 2137 | 2123 | 14 | 0 |
  | 118–119 min | 2608 | 2607 | 1 | 0 |

  **99.5% 被判"音频里确实一直在响"** —— 密集管弦乐里每个音高都被别的乐器/混响/观众声填满，
  `P_FLOOR`/`E_FLOOR` 是**绝对量**，量不出"这是别人的能量"。要真判，得拿到音色/乐器归属那一层。
- **可选修法（都没有改，等用户定）**：
  1. **硬保险**：把 `engine/patches/muscriptor-events-fufumidi.1.py:56` 的
     `DEFAULT_MAX_NOTE_HOLD_SEC` 由 `None` 改成 **30.0**。依据：同一份素材**正常段落最长音 12.3 s**，
     僵尸音 408 s；上游注释也记着 cap=15 s 对正常文件零改动。代价：属"按时长截断"，用户此前明确否过，
     所以**默认保持关闭**。
  2. **治本**：块边界只把「**模型自己上一块显式 tie 过的键**」放进强制 tie 段，不再无条件塞
     `open_keys()`。要先补 `transcription_model.py` 的补丁 + 回归测试
     （`engine/tests/test_muscriptor_sustain_evidence.py` 已钉住现有语义，改前先看它）。
- **怎么复现**：`E:\Midi\_attic\tmp\evidence-probe.py`（全曲证据 + 上表）、
  `E:\Midi\_attic\tmp\zombie.py`（同时开着的音 / 最长音）。

---

## KI-5 「没有配置」的模型怎么变成能用：权重推结构 + 前向校验（2026-10-15 实测）

- **背景**：模型清单 79 个 MSST 模型里，原本只有 6 个能直接跑（4 个有 index.json 收录的 .yaml、
  2 个是 VR 家族）。剩下 21 个上游**没有带配置**（逐个查过镜像仓库目录：只有 .ckpt.partNN），
  另有 2 个 UVR 模型因为 inferMsstArch 先命中 karaoke/mel 关键字被误判成 Mel-Band Roformer，
  白白要求一份不存在的 .yaml。
- **修法**（engine/msst_autoconfig.py，引擎在缺配置时自动调用）：
  1. **从权重推结构**（mel_band_roformer / bs_roformer）：dim（norm.gamma）、heads（to_gates）、
     dim_head（**to_qkv.shape[0] / 3 / heads**）、depth、num_bands、num_stems、
     mask_estimator_depth、linear_transformer_depth（which ≥ 2 的个数）→ 套同族模板 →
     1 输出的修复类模型写成 instruments: [noise, clean] / target: clean（另一路由 mix−clean 推出）。
  2. **同族候选配置逐个试**（htdemucs / mdx23c / apollo）：推不了结构就拿现成同族 .yaml 逐一真装。
  3. 结果缓存在 <cache>/msst_autocfg/<模型名>.yaml（**不往只读的安装/数据目录写**），只生成一次。
- **★ 验收必须是「真装一次 + 跑一小段前向」**：pymss 用 load_state_dict(state_dict, assign=True)，
  assign 会**跳过形状校验**；「装上了」不等于「能用」。实测：把配置里 dim 从 384 改成 512，
  会抛 size mismatch for layers.0.0.layers.0.0.norm.gamma —— 说明这套验收对错配置是**敏感**的，
  错配置不会静默通过（脚本 _attic\tmp\verify-sensitivity.py）。
- **实测踩到的两个推导坑**（都已修，并写进 engine/tests/test_msst_autoconfig.py）：
  - dim_head **不能**用 dim // heads：MSST 里 inner_dim 常 ≠ dim（实测 dim 384 / heads 8 /
    dim_head 64 → inner 512；用 48 会让 rotary_embed.freqs 期望 32、给成 24）。
  - linear_transformer_depth **不是**看 .layers.<inner> 的层数：键结构是
    layers.<depth>.<which>.layers.<inner>.*，which 0/1 才是时间/频率变换器，which ≥ 2 才是线性层。
    （这份模型 which 只有 0/1 → 0；写错成 1 时「验证照样通过」，因为 pymss 忽略该字段 ——
    **验证通过不能反推推导正确**，推导本身也得按结构写对。）
- **实测结果**（安装版 CDP）：79 个模型 → **27 个就绪**（其中 21 个标「首次自动配置」）、
  **0 个「缺配置」**；用户撞过的那两个 mel-band 去噪模型
  （denoise_mel_band_roformer_aufr33_sdr_27_9959 / ..._aggr_...）现在**在 app 里直接分离成功**，
  产出 _clean.wav + _noise.wav。
- **尚未在本机验证的部分（诚实说明）**：52 个模型还没下载；其中 8 个非 roformer 家族
  （htdemucs ×4 / mdx23c ×2 / apollo ×2）走「同族候选配置 + 首次使用校验」这条路，
  本机没有它们的 400 MB~1.5 GB 权重，**只能等第一次真正下载使用时验证**。候选都不匹配时
  引擎会明确报错（不会假装能用），届时给那一个模型补一份专属配置即可。

---

## KI-6 全站动画"改了但没跑"：动效令牌自引用（2026-10-15 实测）

- **现象**：动效令牌改造完成后，构建绿、测试绿、源码里确实是三档时长 + 三条曲线，
  但**安装版里所有 CSS transition 一个都没跑** —— 悬停、按压、弹层、进度条全是瞬变。
- **根因**：`frontend/src/styles.css` 的 `:root` 里三条曲线写成了自引用：
  `--ease-out: var(--ease-out)`、`--ease-spring: var(--ease-spring)`（`--ease-in-out` 也指向它）。
  CSS 自定义属性**直接引用自己 → 该属性在计算值阶段失效**（cycle detection），于是
  凡是 `transition: <prop> var(--motion-base) var(--ease-out)` 的声明**整条作废**，
  transition 回到初始值 `all 0s ease`。这不是"曲线不对"，是**动画完全不存在**。
- **为什么之前的验收没发现**：验收看的是「元素真的动了 / 高度在变」——
  · 模式切换的高度动画是 JS FLIP 写的**内联** `transition: height .34s cubic-bezier(...)`，
    内联值不经过令牌，照跑；
  · 采样的是 rAF 帧率，帧率正常 ≠ CSS transition 在跑；
  · 用 CDP 只看了 `transform-origin` 生效就当"这条规则是活的"——同一条规则里
    `transform-origin` 有效不代表 `transition` 有效。
- **判别法（唯一可靠）**：在安装版里读**计算值**，不是读源码：
  `getComputedStyle(document.documentElement).getPropertyValue('--ease-out')`
  自引用时返回**空串**；`getComputedStyle(el).transitionDuration` 若为 `0s`、
  `transitionProperty` 为 `all`，就说明那条 transition 已被丢弃。
- **修法**：三条曲线写回真值 —— `--ease-out: cubic-bezier(.22,.8,.36,1)`、
  `--ease-in-out: cubic-bezier(.42,0,.58,1)`、`--ease-spring: cubic-bezier(.2,.9,.3,1.18)`；
  并把仓库里 **40 处**「用了时长令牌但没写缓动」的 transition 全部补上 `var(--ease-out)`。
  现在全仓 `transition: all` = 0 处、裸数字时长 = 0 处（只剩 0.7s/1.1s/1.2s/1.4s/2s/3.2s 这类
  **环境循环动画**与 spinner 的 `linear`，它们本来就不该套 UI 三档令牌）。
- **修复后实测**（安装版 CDP：逐帧采样计算值 + 监听 transition 事件）：
  `.tr-mode` transform 148 ms / 43 个中间值，`.tr-pill` transform 148 ms / 43 个，
  `.tr-mode` background-color 142 ms / 41 个，`.card` box-shadow 223 ms / 67 个 ——
  修复前这些全部是 `0s`。模式切换 FLIP 高度仍连续（每次切换 15~43 个不同高度值），
  高级参数面板 `grid-template-rows` 展开 48 个中间值。
  17 个视图逐个走访 + 转录页交互，未捕获异常 0。
- **顺带修掉的真 bug**：`ViewTranscribe.vue` 的 `applyPresetParams()` 里残留一行
  `if (has('normalize')) normalize.value = !!pr.normalize;` —— `normalize` 这个 ref
  早已随降噪开关删除，运行时抛 `ReferenceError`，**把该函数后半段（auto_bpm / tempo /
  力度归一 / 节拍网格 / 弯音 / 旋律增强）整段吃掉**；切到「音频处理」模式时必然触发
  （`watch([mode, ...], autoApplyForCurrentModel)`）。该行已删除。
- **复现/回归命令**：`node E:\Midi\_attic\tmp\motion-probe2.cjs`（令牌计算值）、
  `motion-probe4.cjs`（transition 事件 + 逐帧插值）、`sweep-probe.cjs`（17 视图异常扫描）。

---

## KI-7 变谱（识谱）质量差：四个真问题（2026-10-15 实测，用用户给的两套谱面定位）

用户给了两套真实谱面：`桌面\test`（6 页**管弦乐总谱**，1588×2246，一页 24 行谱表）与
`桌面\gang`（3 页**钢琴独奏**，2977×4208，一行 2 行大谱表）。逐项量过之后，问题不在
「Audiveris 不行」，而是**喂给它的图、合并它的结果、以及回报给界面的信息**都有毛病。

### ① 3×3 加粗把密集总谱整页弄成 invalid（最严重）

`prep_image()` 里 `thicken=True` 是默认值（当初为 630×924 的低清 GIF 加的）。
同一张图、同一个放大倍数，只改这一个开关：

| 第 1 页（24 行谱表） | 导出 MusicXML | 音符 |
|---|---:|---:|
| scale=2 + MinFilter(3) 加粗 | **0 个**（Error in export） | 0 |
| scale=2 不加粗 | 1 个 | **235** |

六页一起跑：加粗时 **6 页只出 4 页**（第 1、2 页静默丢失），不加粗 + 逐页配对后 6 页全出。
→ 默认改成 **off**，只留给「扫描件谱线断裂」的场景（界面上是「加粗谱线」开关）。

### ② 分辨率：Audiveris 的 20M 像素硬上限 + interline ≥ 11px 下限

- 实测整页放大 3 倍（32,099,832 px）→ `Too large image ... Sheet flagged as invalid`，
  它连处理都不处理。旧代码的 6000px 上限会把它压回 2 倍（**1520 万像素**）。
- Audiveris 的 ScaleBuilder 要求**谱线间距 ≥ 11px**；总谱页在 1588px 宽下只有 **6px**，
  放大倍数因此必须由**实测行距**推出来（`measure_interline()` → `auto_scale()`，
  目标 22px，上限 = min(6000px 单边, 1900 万像素)）。
- PDF 侧栅格化的目标宽度从 **1700px 提到 3200px**：PDF 多是矢量图，直接渲高分辨率
  比「先渲小图再插值放大」清楚得多。

### ③ 声部名塌陷：按名字分组合并 = 整部总谱并成 1~2 轨

Audiveris 导出的声部名**全是通用名**（`Voice` / `Piano`）。旧实现把逐页 MIDI 按
`track_name` 分组，于是 15 个声部全进同一条轨：

| | 之前 | 现在 |
|---|---|---|
| 总谱 6 页 | 4 页 / 1430 音 / **2 轨**（Voice 879 + Piano 551） | 6 页 / **1693 音 / 25 轨** |
| 钢琴 3 页 | 3 页 / 1151 音 / **1 轨** | 3 页 / 1128 音 / **2 轨**（左手 25–69、右手 51–95） |

做法：在**谱这一层**合并，声部身份 = `(页内 part 序号, <staff> 行号)`；
`parse_musicxml` 现在会记下每个音符的 `<staff>`，钢琴大谱表的左右手因此能拆成两条轨。
MIDI 里的轨名一律写 ASCII 的 `Part N`（**mido 的 track_name 是 latin-1，中文轨名会直接
抛 UnicodeEncodeError** —— 实测崩在 `meta.encode → encode_string`），中文名放 `label` 给界面。

### ④ 失败页静默丢失 + 参数是摆设

- 旧实现只 `glob` 输出目录里的 `.mxl`，「6 页只出 4 份」这种情况用户完全看不到，
  拿到的是**缺了三分之一音乐的 MIDI**却没有任何提示。现在按输入名逐页配对，
  失败页带 Audiveris 的真实原因回报（`page-failed` + `reasons`），并**自动降一档放大倍数重试**
  （实测第 1 页在 ×2.3 时 `OutOfMemoryError: Java heap space`（`-Xmx8G` 也一样），
  降到 ×1.72 后成功出 256 个音符）。
- 界面上的**拍号 / 速度在 Audiveris 路径上根本没传给引擎**（只喂给经典后端），
  也就是「做了但没作用」。现在支持 `auto`：谱面自己写的优先，用户填了才覆盖。
- 新增真接线的参数：`--upscale`（自动/1/2/3/4）、`--thicken`、`--quantize`（off/1/4…1/32）、
  `--min-note-ms`、`--dedupe`；经典后端也会走 `postprocess_midi_file()`，参数在两条路径上都生效。

### ⑤ Audiveris 按**系统**出 part：一页两个系统 → 整份声部表重复一遍

2026-10-15 第 2 轮实测（第 5 页）：**23 个 part = 10（系统 1）+ 13（系统 2）**，两次都从长笛开始
（`Systems: #1[1..13] #2[14..26]`）。所以「一个 part = 一件乐器」不成立，**一个 part = 某系统里的一段谱**：

- 按**页内序号**对齐（旧做法 + 第一版 M2-2）时，第二个系统整片错位、再新建一整套槽位 ——
  实测 6 页总谱轨数从 21 涨到 **41**（同一支单簧管出现两条轨）。
- **正确身份 = (乐器, 声部编号)**：编号来自谱面自己的写法（`1,2` / `3,4` / `I` / `II`，
  含 OCR 变体 `ll`→`II`、`V1n`→`Violin`）。OCR 读成 Voice 的（两个系统里都会出现）不参与定身份，
  在相邻两个锚点之间**按顺序填空槽** —— 第 2 页前两个声部读成 Voice，正好落回第 1 页的 Flute / Oboe。
- 顺带两个词典 bug（都是实测踩到的）：变体替换按**子串**做时 `cor`(horn 的缩写) 会把
  **Cor anglais 读成圆号、Cornet 读成圆号**（改按整词替换，子串只做兜底）；
  `_key_tag` 在整串里搜调号，把 `Flute 1,2` 里的 `e` 当成了调号（改成只从乐器名片段**之后**取）。
- 移调乐器名字里**没写调号**时（OCR 掉了 `(Bb)`）按常见编制补：单簧管/小号 Bb(−2)、号 F(−7)。
  不补就是「不移调」，对移调乐器必然是错的。

### ⑥ 拍号不明 → Audiveris 按「这一小节认出来的内容」定长 → 各声部各走各的拍

Audiveris 不导出 `<time>`，而且**没有拍号时它不会按统一长度切小节**：每个小节多长，
取决于它在这一小节里认出了多少内容（日志原话：`No target duration for measures [...], please check time signatures`）。
实测那份 6 页总谱：1217 个小节里 1440 tick（3 个四分）只有 528 个，其余是 720/960/1920/2280/2640…
—— **同一页里不同声部的小节长度都不一样**。合到一条时间轴上，音符单看都对，
但声部之间会越走越散（用户听到的是「对不齐」，不是「错了几个音」）。

修法（M1-2）：**先推拍号，再把每个声部按「小节号 × 小节长 + 小节内偏移」重新摆到统一网格上。**

| 指标（第 1 页，21 声部） | 修前 | 修后 |
|---|---|---|
| 跨声部「同刻发音」率 | **0.357** | **0.735** |
| 音符落在八分网格上（全 6 页） | 84.9% | **92.7%** |
| 推定拍号 | 4/4（解析器默认值） | **6/8**（众数 1440 tick，是第二名的 3.2 倍） |

- 判据用「众数明显赢」（≥20% 且 ≥1.5× 第二名）而不是「占多数」：实测分布很散，占多数的判据会直接放弃。
- 页长也一并改对：**按这一页有多少小节**算，不再按「最后一个音落在哪」——
  末小节是空的时候，后者会让下一页整体前移、和上一页叠在一起。
- 小节内偏移（`off`）来自时值本身，是可靠的，所以重排不会动节奏。

### 复现 / 回归

- 引擎用例：`engine/tests/test_omr_backends.py`（按 part 序号合并不塌、量化/去重/丢短音、
  ASCII 轨名、量化网格换算、auto 不被覆盖、加粗是可选项、**两系统重复 part 表**、
  **编号消歧（1,2 / 3,4、I / II）**、Voice 填空槽、大谱表拆轨 + 跨页合并）；
  `engine/tests/test_score_instruments.py`（实测 OCR 名 40+ 条、变体不误伤、调号只从尾巴取、编号进显示名）。
- 端到端命令（用户那两套谱面）：
  `python engine_omr_backends.py to-midi --in 1.png … --backend audiveris --audiveris <exe> --report r.json`
- **仍未解决 / 已知限制**：按系统**切带**识别（每带独立放大到 3.5~4 倍）还没做；
  切分判据已经做出来并 6/6 验证（空白带里没有贯穿竖线 = 系统交界，见
  `docs/plans/2026-10-15-score-recognition-upgrade.md` 的 M2-1 一节），差的是流水线：
  每带跑一次 Audiveris + 同系统多带按时间叠加 + 单带失败隔离。
- **仍未解决**：Audiveris 不导出 `<time>`/`<sound tempo>`，拍号仍是 4/4（原谱 6/8、♩.=60）→
  小节线对不上谱面（见该计划 M1-2 / M4-2）。
