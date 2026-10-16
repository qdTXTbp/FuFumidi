# FuFumidi 问题反馈上传（Feedback → 仓库）方案 · 2026-10-16

> **本文只做规划，未动任何代码。** 执行时在条目上打 `[x]` 并补一行实测结果。
> 制定依据：本仓库现有实现（每条都带文件:行）+ CNB / GitHub 官方文档联网核对。
> 前置阅读：`docs/DOWNLOADS.md`（下载通道）、`cloud-sync/worker/wrangler.toml`（已有的 Cloudflare Worker）。

---

## 执行进度（2026-10-16 第 1 轮）

| 条目 | 状态 | 实测 |
|---|---|---|
| 决策 D1/D2 | ✅ 已定 | 仓库叫 **FuFumidi-Feedback**（公开、只有维护者可写）；CNB 走**镜像** |
| GitHub 反馈仓库 | ✅ **已建** | github.com/qdTXTbp/FuFumidi-Feedback（公开、Issues 开）；已推 README / 3 套 issue 模板 / config.yml / .gitattributes / issues/README.md，**32 个标签**（kind·area·severity·source） |
| CNB 反馈仓库 | ✅ **已建并通了镜像** | 你先在建了空仓库；建仓/镜像都不在 CNB OpenAPI 里，所以用 git push 播了种。**CNB OpenAPI 也没有"创建提交"端点**（只有 blobs/branches/资产上传），worker 无法自己写 CNB → 改成「GitHub 为唯一写入点 + GitHub Action 推 CNB」。实测**两边 main 头哈希一致**（a435b3be437d），Action 两次 run 均 success。搭建与排查见 docs/feedback-repo/README.md |
| worker 反馈路由 | ✅ 代码+单测完成 · ⏳ **未部署** | 新增 cloud-sync/worker/src/feedback.js（Turnstile / 体积 / 路径白名单 / 限流 → 附件进 R2 → md 走 GitHub Contents API → 可选建 issue），index.js 接 POST /feedback 与 GET /feedback/att/:id/:name，新增迁移 0003_feedback.sql；**9 项离线单测全过**。本机没有 wrangler、也没有 CF 登录态 → 部署要你跑（见文末） |
| 客户端脱敏与打包 | ✅ 代码+单测完成 | 新增 main/feedback-format.js（slug / 文件名 / md 模板 / 脱敏 / 设置洗白 / 日志截断）；npm run test:feedback **9 项全过**（含隐私 golden） |
| 反馈页 UI | ⬜ 待做 | 字段与交互按 §5 |
| worker 部署 | ✅ 已部署（独立 worker） | 发现云同步 worker 跑在**协作者账号**（`3b038b29…`，无权限）→ 反馈改为独立 worker `fufumidi-feedback` 部署在项目自己账号（`a50de010…`）：新建 workers.dev 子域 `fufumidi`、D1 `fufumidi-feedback`、KV `fufumidi-feedback-att`（R2 未开通，附件走 KV，30 天过期）；迁移 `0001_feedback.sql` 已 apply；`/health` 返回 `build: feedback-1, attachments: kv` |
| 端到端上传 | ✅ **已实测通**（本地 miniflare 真流程） | `POST /feedback` → HTTP 200；**GitHub 上文件字节与提交内容一致**（332 B）、**Issue #1 带 kind/severity/source 标签建出**、**附件从 KV 回读 24 B 内容一致**（`Content-Disposition` 正确）、**立刻重复提交被 429 拦**（限流生效）；**CNB 镜像头哈希一致**（`fd7ca44be046`）。测试文件与 Issue 已清理 |
| Deno 备用后端 | ✅ 代码+单测完成 · ⏳ **未部署** | 因为 `*.workers.dev` 国内不可达，**走方案 C：Deno Deploy**。新增 `deno/feedback.ts`（与 CF 版同规则同限流）+ `deno/main.ts`（`BUILD=deno-feedback-1`）：附件改走 **GitHub Release 资产**（固定 tag `attachments`），限流用 **Deno KV**；`deno/feedback_test.ts` **8 项离线单测全过**（本机 deno.land/jsr 被墙，测试不引外部依赖） |
| Deno 端到端 | ✅ **已实测通**（本地 `deno run` 真流程） | `POST /feedback` 200 → **GitHub 上 md 文件字节一致**（160 B）、**附件经 Release 资产回读 96 B 逐字节一致**、**Issue #2 带 kind/severity/source 三个标签建出**、**立刻重复提交被 429 拦**。测试文件 / Issue / 资产随后全部清理（release 里剩 0 个测试资产） |
| ⏳ 待办：Deno 部署 | ⬜ **要你登录一次** | 需要 `deno deploy` 的登录态（或 `DENO_DEPLOY_TOKEN`），以及一个**只授权 FuFumidi-Feedback** 的 fine-grained PAT 作为 `GITHUB_TOKEN` secret。部署后把客户端 `main/feedback.js` 的 BASES 指到 `https://fufumidi-feedback.<org>.deno.dev` |
| ⚠️ 可达性 | ⬜ **待你定** | `*.workers.dev` 在**国内被 DNS 污染**（解析到 OVH / Facebook 的 IP，curl 60 s 超时），`fusync.de5.net` 0.7 s 通、`*.deno.dev` 3 s 通。三条路：A 由协作者把反馈路由部署到现成的 worker（代码已在 index.js，客户端 BASES 已把 `fusync.de5.net` 排第一）；B 给自己账号加域名并绑自定义域名（最彻底）；C 搬去 Deno Deploy。未定之前上传会失败并**自动存本地**，页面另给「网页提交/存到本地」 |

---
## 0. 一句话

现在的「去 GitHub 反馈」是**把体检报告复制到剪贴板 + 打开一个预填好的 issue 网页，让用户自己粘贴**
（`frontend/src/components/SettingsPanel.vue:1259-1262`）。
本方案把它变成：**用户在反馈页填好问题 → 一键把「问题 md + 体检报告 + 诊断包」上传到专门的反馈仓库**
（GitHub 一个、CNB 一个镜像），仓库里一人一个 md 文件，可检索、可归档、可离线看。

---

## 1. 现状：管道其实已经铺好了大半

| 已有的东西 | 位置 | 对本方案的意义 |
|---|---|---|
| 反馈入口（剪贴板 + 预填 issue） | `frontend/src/components/SettingsPanel.vue:1229-1265`（`reportIssue()`）；首页卡片 `ViewHome.vue:155` | 就是 P0 的兜底通道，保留 |
| 全局体检（会下结论、带脱敏） | 引擎 `engine/health.py`；`main/diagnostics.js:45` `diag:health` | **已经有 redactor**（`health.py:33 make_redactor`，替换主机名/用户名/家目录）——体检报告可直接上传 |
| 诊断包（zip） | 引擎 `engine/diag.py`；`main/diagnostics.js:24` `diag:export` | 里面是 **settings.json + 依赖状态 + 最近日志**(`diag.py:34-39`)——**含隐私，必须脱敏且默认不上传** |
| **已部署的 Cloudflare Worker** | `cloud-sync/worker/`：`wrangler.toml`（账号 `3b038b…`、R2 桶 `fufumidi-midi`、D1 `fufumidi-cloud-sync`、Turnstile）；客户端已在用 `https://fufumidi-cloud-sync.fumivoice.workers.dev`（`frontend/src/core/cloudSync.ts:14-19`，自定义域名优先 + workers.dev 兜底） | ★ 上传通道**直接挂在这上面**，不用新建任何基础设施：附件进 R2、限流用 D1、防刷用现成 Turnstile；上传客户端照抄它的多域名候选与回退 |
| 双通道仓库体系 | `main/download-source.js:15-53`：GitHub `qdTXTbp/FuFumidi`；CNB `FuFuCloud-mirror/{FuFuMIDI,Models,Media,FuFumidiSoundFonts,DiffSinger}` | 新反馈仓库沿用同一命名与镜像习惯 |
| 客户端已会跟 worker 说话 | `frontend/src/stores/cloud.ts`（登录/会话/分片上传） | P1 的上传客户端可以照抄它的鉴权与错误处理 |
| CNB OpenAPI | `https://api.cnb.cool`（Bearer 访问令牌，swagger 在 `/swagger.json`） | 双写的第二通道；**文件写入端点本次未确认**（见 D2） |

**结论**：缺的只有三样 —— ① 反馈页的字段规范与打包；② 往仓库写文件的那一段；③ 上传前脱敏与预览。

---

## 2. 目标与非目标

**目标**
1. 在 GitHub 与 CNB 各建一个**专门的问题仓库**，一人一个 md 文件。
2. 反馈页有**固定模板**（分类/模块/严重度/症状/复现/期望实际），生成规范的 md。
3. **一键**把体检报告与诊断包一起打包上传；用户只需描述问题 + 点上传。
4. 上传前能看清「究竟会上传什么」；失败时有本地兜底，绝不把用户的问题丢掉。

**非目标（明确不做）**
- 不做账号体系（反馈不必登录；可选复用 cloud-sync 账号只用来关联历史）。
- 不做评论/工单状态/回复（讨论仍去 GitHub Issue）。
- 不做云端日志分析/统计看板（P2 再说）。
- 不自动上传任何东西：**每一次上传都由用户点按钮触发**。

---

## 3. 请你先拍板的 6 个决策点

| # | 决策 | 选项 | 我的建议 |
|---|---|---|---|
| **D1** | 两个反馈仓库叫什么 | ① `qdTXTbp/FuFumidi-Feedback`（GitHub，公开）+ CNB `FuFuCloud-mirror/FuFumidi-Feedback` ② 并进现有 `FuFumidi` 仓库的 `feedback/` 目录 | **①**。问题反馈会长期积累，混进主仓库会污染 clone/更新包 |
| **D2** | 往仓库写文件的通道 | ① **GitHub 写 + CNB 镜像同步**（CNB 的镜像仓库功能/定时流水线） ② 向两边各写一次（需要 CNB 文件写入 API，本次没确认到，见 §9 风险） ③ 只写 GitHub | **①**。CNB 侧零维护且国内可读；CNB 写接口确认可用后再考虑 ② |
| **D3** | 附件（诊断包 zip）放哪 | ① **R2**（已有桶 `fufumidi-midi`，worker 发临时链接） ② GitHub/CNB Release 资产 ③ 直接提交进仓库 | **①**。仓库里只留几十 KB 的 md，附件走对象存储；② 作为 R2 不可用时的备份 |
| **D4** | 默认收集范围 | ① 默认带**体检报告**（已脱敏文本），诊断包**默认不勾** ② 两个都默认带 ③ 都默认不带 | **①**。诊断包含 settings.json 与日志，体积与隐私都更重，要用户明确勾选并看到体积 |
| **D5** | 是否匿名 | ① 匿名（Turnstile + 按 `install_id` 限流） ② 必须登录 cloud-sync 账号 | **①**。反馈的门槛越低越好；`install_id` 只是随机 UUID，用于限流与去重，不关联身份 |
| **D6** | 上传后是否自动开 GitHub Issue | ① 开（正文引用 md 链接 + 打标签，便于讨论与通知） ② 不开（只落文件） | **①**。仓库是归档，Issue 是进度；但**内容只在 md 里维护**，issue 不复制正文，避免两处不一致 |

---

## 4. 架构与数据流

```
反馈页（渲染进程）
  ├─ 填：分类 / 模块 / 严重度 / 标题 / 症状 / 复现 / 期望实际 / 联系方式
  ├─ 勾：☑ 体检报告（默认）  ☐ 诊断包（默认关，显示体积与「含日志」提示）
  ├─ 生成 md（本地）→ **脱敏** → **预览**（用户点「查看将要上传的内容」）
  └─ 点「上传到仓库」
        ↓ IPC（preload 暴露 feedback:submit）
主进程（main/feedback.js 新增）
  ├─ 收集：health.py 报告（已脱敏）+ diag.py 打包（再脱敏一遍，见 §6）
  ├─ 组包：feedback-<id>/ { issue.md, health-report.md, diagnostic.zip }
  └─ POST https://fufumidi-cloud-sync.<账号>.workers.dev/feedback
        ↓（Turnstile token + install_id + md + 附件分片）
Cloudflare Worker（cloud-sync/worker/src/feedback.js 新增路由）
  ├─ 校验：Turnstile / 体积上限 / install_id 限流（D1）
  ├─ 附件 → R2：feedback/<id>/diagnostic.zip（不可猜路径）
  ├─ 提交 md：GitHub Contents API（GITHUB_TOKEN 只存 worker secret，客户端永不接触）
  ├─ 可选：GitHub Issues API 建 issue（引用 md 链接 + 标签）
  └─ 返回：{ id, url_github, url_cnb, issue }
        ↓
反馈页显示结果（可点的仓库链接 + 「已保存一份到本地」）
```

**失败兜底（三选，P0 就有，不依赖 worker）**：保存到本地 zip / 复制 md 到剪贴板 / 打开预填好的 GitHub「新建文件」页。

---

## 5. 反馈页规范

### 5.1 字段

| 字段 | 必填 | 控件 | 说明 |
|---|---|---|---|
| 分类 `kind` | ✔ | 下拉 | `bug` 功能异常 / `crash` 崩溃或无响应 / `perf` 卡顿慢 / `quality` 识别或音质不对 / `idea` 功能建议 / `docs` 文档与文案 |
| 模块 `area` | ✔ | 下拉 | 转录 / 变谱 / 转换 / 音色 / 调教 / 播放 / 曲库 / 编辑 / 更新 / 资源中心 / 其它 |
| 严重度 `severity` | ✔ | 分段 | `blocker` 用不了 / `major` 很影响 / `minor` 小问题 |
| 标题 | ✔ | 单行（≤60 字） | 生成文件名与 issue 标题 |
| 症状描述 | ✔ | 多行（≥20 字） | 「发生了什么」 |
| 复现步骤 | ✖ | 多行 | 越具体越好，允许贴自己的操作序列 |
| 期望 vs 实际 | ✖ | 双栏 | |
| 出现频率 | ✖ | 下拉 | 每次 / 偶尔 / 只出现过一次 |
| 联系方式 | ✖ | 单行 | 留空即匿名（**默认空**） |
| 附件勾选 | ✔ | 复选框 | ☑ 体检报告（默认） ☐ **诊断包（含日志与设置，默认关）** |

### 5.2 md 模板（front-matter + 正文）

```markdown
---
id: 2026-10-16-a1b2c3
title: 变谱第 2 页总是识别失败
kind: bug
area: 变谱
severity: major
app: 5.1.0
build: f4c1938
os: Windows 11 23H2 (x64)
cpu: AMD Ryzen 9 7940HS
gpu: NVIDIA RTX 5070 Ti · 驱动 566.03 · CUDA 12.8
mem: 32 GB
install: 安装版
install_id: 8f3c1d2e-…        # 随机 UUID，仅用于限流与去重，不含个人信息
created: 2026-10-16T01:23:45+08:00
attachments:
  - health-report.md
  - diagnostic.zip (4.2 MB, sha256: 3f9a…)
contact:                      # 空 = 匿名
---

## 症状
<用户填>

## 复现步骤
<用户填>

## 期望 vs 实际
<用户填>

## 频率
偶尔

## 附件
- [x] 体检报告（自动脱敏）
- [ ] 诊断包

<details><summary>体检报告（自动生成，已去用户名/机器名）</summary>

（health.py 的 report_text）

</details>
```

### 5.3 文件名与目录

```
issues/2026/10/2026-10-16-a1b2c3-<slug>.md
                             └ slug = 标题的 ASCII 化，≤40 字符，[a-z0-9-]
```

- 冲突时追加 `-2`、`-3`；`id` 全局唯一（时间 + 6 位随机）。
- 同一天同模块的文件天然聚在一起，按日期分目录避免单目录几万个文件。

---

## 6. 脱敏规则（上传前的硬闸门）

| 目标 | 规则 | 现状 |
|---|---|---|
| 机器名 | → `<host>` | ✅ `health.py:33-47` 已做 |
| 用户名 / 家目录 | `C:\Users\<x>` → `C:\Users\<用户>`；`/home/<x>` 同 | ✅ 已做 |
| **诊断包内部的 settings.json / 日志** | 同样规则再过一遍（当前 `diag.py` **没有**做） | ❌ **P0 必须补**：路径、令牌、歌名 |
| 令牌形状 | `hf_*`、`sk-*`、`Bearer *`、32+ 位 hex、`gh[pousr]_`、CNB 令牌 → `<已隐藏>` | ❌ 要加 |
| 曲库内容 | 只保留「N 首 / N 个歌单」计数，不带歌名与文件名 | ❌ 要加 |
| 网络标识 | MAC / IP / 序列号 → 掩码 | 待核对 |
| 播放历史、最近打开 | 默认不带 | 待核对 |

**必须有的两道保险**：① 上传前**可展开预览**完整的 md 与附件清单（含每个附件的大小与 sha256）；
② 首次上传弹一次明确告知（记住选择），把「会上传什么」写清楚。

---

## 7. 仓库规范

**GitHub `qdTXTbp/FuFumidi-Feedback`（公开）**
- `README.md`：怎么提反馈（App 内一键 / 网页手动）、模板说明、隐私说明、附件策略。
- `.github/ISSUE_TEMPLATE/{bug,quality,idea}.yml`：网页手动提交走同一套字段。
- `issues/YYYY/MM/*.md`：App 上传的文件。
- 标签：`kind/*`、`area/*`、`severity/*`、`source/app`、`source/web`。
- `.gitattributes`：`*.md text eol=lf`（与主仓库一致）。

**CNB `FuFuCloud-mirror/FuFumidi-Feedback`**
- 公开仓库；按 D2 选镜像同步或双写。CNB 上有 100 MiB raw 读取上限（`download-source.js:38-44`），
  本方案的文件都是几十 KB，不受影响。

---

## 8. 分阶段实施

### P0 · 不依赖任何新凭据，可以立刻做完（建议先做这一档）
- [ ] 反馈页按 §5.1 重做字段与校验（保留现有 `reportIssue()` 作为兜底按钮）
- [ ] 本地打包：`feedback-<id>.zip` = `issue.md` + `health-report.md` + `diagnostic.zip`
- [ ] 脱敏补全（§6 里标 ❌ 的三项）+ **golden 单测**
- [ ] 上传前预览弹窗（md 全文 + 附件清单 + 体积 + sha256）
- [ ] 三条兜底：保存到本地 / 复制 md / 打开预填 issue 页
- [ ] i18n EN + JA、门禁、安装版冒烟
> P0 结束时，用户已经能「一键拿到一份规范化的 md + 附件」，自己丢进仓库或邮件发出去 —— 不等凭据。

### P1 · 上传通道（需要 D1–D6 的答复与凭据）
- [ ] 建两个反馈仓库（含 README、issue 模板、标签）
- [ ] worker 新增 `POST /feedback`：Turnstile → 限流（D1）→ 附件进 R2 → Contents API 写 md →（可选）建 issue
- [ ] `main/feedback.js` + `preload` + `frontend/src/types/ipc.ts`（新能力三处同改）
- [ ] 首次上传的同意弹窗 + 「我的反馈历史」本地记录（只存 id/标题/时间/链接）
- [ ] 端到端实测：真上传到**测试仓库**，核对目录/文件名/front-matter/附件可下载
- [ ] 失败四种情形各有明确提示与兜底：无网 / Turnstile 失败 / 超限 / 仓库 5xx

### P2 · 增值（可选）
- [ ] 反馈列表页（读仓库渲染，只读缓存）——用户能看到别人报过什么、避免重复
- [ ] 去重提示：上传前检索标题相似度，建议先看已有 issue
- [ ] 高频问题自动进 `docs/known-issues.md`（人工确认后）
- [ ] 截图附件（需要先做本地缩略图与脱敏）
- [ ] CNB 侧改成真正的双向写入（若 CNB 文件 API 确认可用）

---

## 9. 验收与门禁（可执行）

| 项 | 判据 |
|---|---|
| 脱敏单测 | golden 对照：生成的 md / 诊断包内**不含** `C:\Users\qdTXTbp`、主机名、`hf_` 开头的串、`Bearer `、32+ 位 hex；且**含** `<用户>`、`<host>`、`<已隐藏>` 占位 |
| 打包单测 | `feedback-<id>.zip` 里恰好三个文件；`issue.md` 的 front-matter 能被 YAML 解析；字段与界面输入一致 |
| worker 单测 | `wrangler dev` + mock：限流生效（10 分钟 1 次）、体积超限拒绝、GitHub 5xx 时**内容不丢**（落 R2 并返回可下载链接）、Turnstile 失败返回 403 |
| 端到端 | 安装版真实上传一次到测试仓库：文件路径/命名/front-matter/附件链接全部核对；再跑一遍离线（拔网）验证兜底 |
| 门禁 | `npm run typecheck` / `build:ui` / `test:ui` / `audit` / `deploy-installed.cjs` 冒烟 全绿；新控件必须有 EN+JA 文案 |
| 隐私复核 | 上传前预览里能看到的字节 == 实际 POST 出去的字节（用一个假的 worker 端点做差分断言） |

---

## 10. 风险与代价

| 风险 | 影响 | 对策 |
|---|---|---|
| worker 里的 GitHub 令牌泄露 | 反馈仓库被写坏 | fine-grained PAT **只授权这两个仓库** `contents:write`+`issues:write`、设到期日；只存 worker secret；随时吊销 |
| 用户误传隐私 | 隐私事故 | 诊断包默认关；上传前预览；脱敏 golden 测试；首次明确同意 |
| 垃圾/滥用 | 仓库被刷 | Turnstile + `install_id` 限流 + 体积上限；写入只走 worker，不开公开 PR 通道 |
| CNB 无文件写入 API | 双写做不成 | 默认走 D2 ①「GitHub 写 + CNB 镜像」；② 需要先拿 swagger 确认端点（本次未确认） |
| 仓库膨胀 | clone 变慢 | md 进 git（几十 KB/条），附件走 R2/Release，不进 git 历史 |
| 网络不可达 | 上传失败 | P0 的三条兜底永远可用；上传失败时明确提示并自动把包存到本地 |
| 体积失控 | 上传超时 | md ≤256 KB、附件 ≤20 MB 硬上限；诊断包超限时自动截断日志并在 md 里注明 |

---

## 11. 需要你提供的东西

1. **GitHub 反馈仓库**：名字与可见性（建议 `qdTXTbp/FuFumidi-Feedback`，公开）
2. **CNB 反馈仓库**：名字（建议 `FuFuCloud-mirror/FuFumidi-Feedback`），以及是**镜像同步**还是**双写**
3. **GitHub fine-grained PAT**（只勾这两个仓库的 `contents:write` + `issues:write`，设到期）——
   **请你自己 `wrangler secret put GITHUB_TOKEN`，不要发给我**
4. 附件策略确认（R2 已有桶 vs Release 资产）
5. 是否匿名（建议匿名的理由见 D5）
6. 上传后是否自动开 Issue（D6）

拿到 1–3 就能开 P1；**P0 不需要任何凭据，你现在说「开工」我就先做 P0。**
