# 仓库卫生审计（hygiene）

这一页记录**一次实际跑过的**卫生审计、每一条发现的处理结论，以及怎么再跑一遍。
它不是愿望清单：写在这里的每一条要么已经改掉，要么写明了为什么不改。

## 怎么再跑一遍

审计脚本是离线检查（不联网、不查 CVE），由 `repo-hygiene-bundle` 技能附带：

```powershell
# 本机没有 pwsh；python 也不能用 `python`（那是 Windows 应用别名），要写全路径
$py = "E:\Midi\_attic\_sing_tmp\venv\Scripts\python.exe"
$sk = "$env:USERPROFILE\.dsh\skills\repo-hygiene-bundle\scripts\hygiene.py"
& $py $sk . --fail-on none            # 人读的报告
& $py $sk . --json --sarif hygiene.sarif   # 机器读 / 上传 code scanning
```

在 git 工作树里它只读 **已入库** 的文件（`git ls-files`），所以本地未提交的中间产物不会污染结果。

## 这次审计的范围与结论

- 时间与版本：2026-10-06，`package.json` 5.0.0-beta.2，工作树 HEAD `dd7e2b2`。
- 规模：680 个入库文件（`git ls-files`），pack 体积 46.4 MiB。
- 结果：**0 high / 25 medium / 6 low**（首次运行）。
- 本轮修完后复跑：**0 high / 7 medium / 2 low**（687 个入库文件）。剩下的 7 条 medium 全是 `HYG-LARGE`，
  2 条 low 是 `HYG-GENERATED` 的误报与 `HYG-COC` —— 三条都在下面写明了为什么接受。
- 明确**没有**检查：已知漏洞（CVE）、依赖许可证树、git 历史里的密钥。这三项不在这个脚本的能力范围内。

## 处理结论

| 规则 | 首次发现 | 结论 |
| --- | --- | --- |
| `HYG-LICENSE` 根目录无许可证 | 1 | **已修**：加 `LICENSE`（MIT，与 `package.json` 的 `license` 一致），并在文件末尾列出随包分发的第三方许可证位置 |
| `HYG-SECURITY` 无安全策略 | 1 | **已修**：加 `SECURITY.md`（支持的版本、私有报告入口、在范围内的攻击面、不在范围内的事项） |
| `HYG-SPDX` `rust-core/Cargo.toml` 无 license | 1 | **已修**：补 `license = "MIT"` |
| `HYG-PIN` workflow 用 tag 而不是 commit SHA | 13 | **已修**：四个 action 全部钉到 commit SHA，并保留 `# v4` 注释 |
| `HYG-PERMS` workflow 没有顶层 `permissions` | 2 | **已修**：`build.yml` / `build-installers.yml` 补 `contents: read` |
| `HYG-LOCK` 有 manifest 无 lockfile | 3 | **已修**：`package-lock.json`（根、frontend、cloud-sync/worker 三个）入库，`.gitignore` 里原来那行 `package-lock.json` 删掉；CI 改用 `npm ci` |
| `HYG-GENERATED` `build/` 被当作构建产物 | 1 | **误报**：`build/` 是 electron-builder 的 `buildResources`（`icon.ico` / `icon.png` / `nsis-custom.nsh` / `kachina.config.json` / `updater-left.webp`），是**输入**不是输出 |
| `HYG-COC` 无行为准则 | 1 | **暂不改**：单人维护、没有对外社区流程；等真的有外部 issue / PR 再补，现在补是摆设 |
| `HYG-LARGE` 单个文件超过 1 MB | 7 | **部分已修**：见下面「大文件」一节 |

首次的 25 条 medium 里 13 条是 `HYG-PIN`、3 条是 `HYG-LOCK`、7 条是 `HYG-LARGE`，
加 1 条 `HYG-LICENSE` 与 1 条 `HYG-SPDX`。

## 大文件（`HYG-LARGE`）

### 已删除（2026-10-06：逐个做过「零引用」核对，见下）

| 文件 | 体积 | 为什么可以删（证据） |
| --- | --- | --- |
| `renderer/fonts/HYWenHei.ttf` + `licence.txt` | 6.9 MB | 全仓库对 `HYWenHei` / `.ttf` / `@font-face` 的引用数为 **0**（构建后的 CSS 里也是 0）；`styles.css` 用的是 DM Sans / PingFang SC / 微软雅黑。它旁边那份 `licence.txt` 还是**汉仪商用字体**授权（仅限个人非商业），放在 MIT 仓库里分发是实打实的法律风险 |
| `renderer/vendor/verovio-toolkit-wasm.js` | 7.0 MB | 与 `frontend/public/vendor/verovio-toolkit-wasm.js` **逐字节相同**；渲染进程按 `./vendor/verovio-toolkit-wasm.js` 从 `renderer/dist/vendor/` 加载（`main/window.js` 加载的是 `renderer/dist/index.html`），`renderer/vendor/` 这一份没有任何加载点 |
| `renderer/vendor/vexflow-min.js` | 0.75 MB | 全仓库 `vexflow` 命中数为 **0**（只在它自己文件里）；`EditorCanvas.vue:949` 的注释还专门写了「没有采用 VexFlow」 |
| `renderer/vendor/abcjs-min.js` + `frontend/public/vendor/abcjs-min.js` | 1.0 MB | `ViewScore.vue` 里的 `loadAbcjs()` 定义后**从未被调用**（全仓库仅此一处命中），Rollup 也把它 tree-shake 掉了；乐谱只有 Verovio 一条渲染路径 |
| `renderer/vendor/jssynth/*` | 2.4 MB | 与 `frontend/public/vendor/js-synth/*` 重复；`main/` 只读 `renderer/vendor/soundfonts/`（`soundfonts.js:84/:371`、`dialogs.js:75`），从不读 `renderer/vendor/jssynth/`。`LICENSE.js-synthesizer.txt` 已挪到 `frontend/public/vendor/js-synth/` 保留 |
| `frontend/public/vendor/js-synth/libfluidsynth-2.4.6.js` | 0.57 MB | 不带 libsndfile 的变体，`synth.js` / `sf2render.js` 加载的一律是 `-with-libsndfile` 版本，零加载点 |

合计约 **19 MB**，同时把安装版 asar 里的一份重复（sf2 与 js-synth 既内联又 unpacked，36.9 MB）一并消掉。

### 保留（体积大但确实在用）

| 文件 | 体积 | 为什么必须在 |
| --- | --- | --- |
| `renderer/vendor/soundfonts/GeneralUser.sf2` | 29.8 MB | 默认音色，离线可用。它是**唯一**一份：渲染进程走 `../vendor/soundfonts/GeneralUser.sf2`（`synth.js:646`、`sf2render.js:51`），Node 侧走 `main/soundfonts.js`。删了就没有内置音色 |
| `frontend/public/vendor/verovio-toolkit-wasm.js` | 7.0 MB | 乐谱渲染（WASM），运行时按 `./vendor/...` 从 `renderer/dist/vendor/` 加载 |
| `frontend/public/vendor/js-synth/libfluidsynth-2.4.6-with-libsndfile.js` | 2.3 MB | 合成器运行时（AudioWorklet 与 `<script>` 两条路径都指向它） |
| `engine/singing/openutau/native/**` | 4.8 MB | OpenUtau 的本地库；只有当前 RID 的那份会被 `native_lib.py` 用到，但跨平台构建需要各自的文件。来源与逐文件映射见 `engine/singing/openutau/native/README.md` |

处理方式：**不引入 Git LFS** —— LFS 让 clone 多一步（要装 git-lfs 并联网拉取），
而「离线可用」是这个项目的卖点。这些文件随仓库分发是有意的。

★ 上一版这一节把 `HYWenHei.ttf` 写成「界面字体，缺了中文排版会掉字」、把两份 vendor 说成「删任何一边都会让某条路径 404」——
两句都是**没核对就写下的**，与实测相反（见上表证据）。这条教训写在这里：
「某个文件看起来该在用」不等于在用，判据只有一个 —— 全仓库引用数。

## CI 里发现的死代码（脚本查不出来，读 workflow 才看得见）

`HYG-PIN` 只说明「action 没钉 SHA」，翻文件时另外发现三处更严重的问题：

1. **`ci.yml` 的 `package` job 永远不会运行。** 它的条件是
   `if: github.event_name == 'push' && contains(github.ref, 'refs/tags/v')`，
   但同一个文件的 `on.push` 只列了 `master` / `main` 两个分支 —— tag 推送不会触发这个工作流。
   实测：GitHub API 查 `v5.0.0-beta.1` / `v5.0.0-beta.2` 两个 tag 的运行记录，**各 0 次**。
   结论：删掉这个 job。发布用的 Windows 安装包本来就在本机构建，因为
   `electron-builder.yml` 的 `extraResources` 需要仓库外的 `resources/`（python / models / g2p）。
2. **`build.yml` / `build-installers.yml` 的触发条件写死在 `tags: ['v2.0.0*']`。**
   版本号已经走到 5.x，这个过滤器永远匹配不上 —— 两个跨平台工作流自 v2.0.0 起就是死配置。
   结论：去掉失效的 tag 过滤器，保留 `workflow_dispatch`（手动跨平台验证路径），
   并把 node 版本对齐到 `ci.yml` 的 24。没有把它们接到 `v*`：那三个 runner 都无法从本机验证，
   在发布 tag 上引入一个自己都跑不了的红色工作流不是改进。
3. **`test-installers.yml` 把 `v2.0.0` 和产物名硬编码在四处。**
   结论：改成 `workflow_dispatch` 的 `tag` 输入，版本串在脚本里由 `${TAG#v}` 推出。
   同时写清它默认会失败：当前发布通道只上传 Windows 安装包，Release 里没有 AppImage / deb / dmg。

## action 钉版表

四个 action 的 commit SHA 由 GitHub API 解析（`/git/ref/tags/<tag>`，若 `object.type` 是 `tag` 再解一层），
不是手抄的：

| action | tag | commit SHA |
| --- | --- | --- |
| `actions/checkout` | v4 | `11d5960a326750d5838078e36cf38b85af677262` |
| `actions/setup-node` | v4 | `49933ea5288caeca8642d1e84afbd3f7d6820020` |
| `actions/setup-python` | v5 | `a26af69be951a213d495a4c3e4e4022e16d87065` |
| `actions/upload-artifact` | v4 | `ea165f8d65b6e75b540449e92b4886f43607fa02` |

升级时重跑同一段 API 调用取新 SHA，**不要**凭记忆写。

## 行尾与编码（核对过的事实）

`.editorconfig` 只声明仓库里已经成立的事实，量法：

```powershell
$b = [System.IO.File]::ReadAllBytes((Resolve-Path 'main.js'))
$crlf = 0; for ($i=0; $i -lt $b.Length-1; $i++) { if ($b[$i] -eq 13 -and $b[$i+1] -eq 10) { $crlf++ } }
"CRLF=$crlf"
```

- **仓库里存的是 LF**。`git config --system --get core.autocrlf` 是 `true`，所以提交时 git 把行尾归一化成 LF、
  检出到工作区时再写成 CRLF。同一份工作树里 `main.js` / `README.md` 是 CRLF 而新写的 `docs/FOUNDATION.md`
  还是 LF，不是谁写错了，是「已入库并被检出过」与「刚写、还没过 git」的差别。
- 因此 `.editorconfig` 声明的全局行尾是 **`lf`（入库形态）**，并且新增了 `.gitattributes`：
  把「存 LF / `*.ps1` 与 `*.bat` 等 Windows 脚本在工作区用 CRLF / 二进制后缀禁止任何转换」写进仓库，
  不再依赖某一台机器的 system 级 git 配置。换机器结果一致，这是构建可复现的一部分。
- **`*.ps1` 必须是 UTF-8 with BOM**：Windows PowerShell 5.1 否则按 ANSI 解码，中文注释变乱码并直接报语法错（本机实测）。

## 与其它约定文档的关系

- 架构分层、依赖方向、契约、门禁命令：`docs/FOUNDATION.md`。
- 分支、提交信息、发布与上传：`.github/CODING_GUIDELINES.md`。
- 什么算验过：`docs/TESTING.md`。
- 本页：仓库卫生与 CI 配置的现状与理由。改 workflow 或加第三方文件前先看这里。

