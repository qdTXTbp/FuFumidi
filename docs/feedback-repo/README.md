# 反馈仓库的搭建与搬运（两份副本 + 一条镜像）

反馈功能牵扯**三个地方**，这份文档说明它们各自是什么、怎么重建。

| 位置 | 作用 | 谁写 |
|---|---|---|
| GitHub `qdTXTbp/FuFumidi-Feedback` | **唯一写入点**：反馈 md 的归档地，Issues 在这里 | 只有 App 的 worker（服务端令牌） |
| CNB `FuFuCloud-mirror/FuFumidi-Feedback` | 国内可达的**镜像** | 由 GitHub Action 自动推（人不碰） |
| `cloud-sync/worker`（Cloudflare） | 收 App 的 POST，校验后写 GitHub | 部署在 Cloudflare 上 |

```
App（设置 → 反馈）
  └─ POST /feedback  →  Cloudflare Worker（Turnstile / 限流 / 体积）
        ├─ 附件 → R2
        ├─ md   → GitHub Contents API（写 qdTXTbp/FuFumidi-Feedback）
        └─ 可选 → 开一条 Issue
                        │
                        └─ GitHub Action(mirror-to-cnb.yml)  git push --force
                                → cnb.cool/FuFuCloud-mirror/FuFumidi-Feedback
```

## 为什么 CNB 那步是「Action 推」而不是「worker 直接写」

CNB 的 OpenAPI（`https://api.cnb.cool`，swagger 199 个端点）**没有创建提交的端点** ——
只有 `/{repo}/-/git/blobs`（建 blob）、`/-/git/branches`（建分支）、
`/-/upload/files`（资产上传，走预签名对象存储，不进 git 历史）。
没有 tree/commit 组合接口，worker 就没法自己落一个文件到 CNB 的仓库里。
所以选：**GitHub 写一次 → Action 原样推过去**。两边 HEAD 哈希一致，可验证。

（CNB 的建仓与「镜像仓库」设置也不在 OpenAPI 里，只能在 cnb.cool 的界面操作。
本仓库那三份脚手架因此是用 git push 播的种。）

## 重建步骤（从零）

1. **GitHub 仓库**：`qdTXTbp/FuFumidi-Feedback`，公开、开 Issues。
2. **脚手架**：README、`.github/ISSUE_TEMPLATE/*.yml`、`.gitattributes`、`issues/README.md`
   —— 见 App 仓库 `docs/feedback-repo/scaffold/`（与本文件同目录）。
3. **标签**：`kind/*`、`area/*`、`severity/*`、`source/*`（`scripts/feedback-labels.json`）。
4. **镜像**：把 `mirror-to-cnb.yml` 放进 `.github/workflows/`，然后
   **Settings → Secrets and variables → Actions → New repository secret**：
   `CNB_TOKEN` = cnb.cool 的访问令牌（个人设置 → 访问令牌）。
   没配这个 secret 时工作流会**跳过**（不会红）。
5. **CNB 仓库**：`FuFuCloud-mirror/FuFumidi-Feedback`（公开）。建好后第一次可以用
   `git push https://cnb:<令牌>@cnb.cool/FuFuCloud-mirror/FuFumidi-Feedback.git main:main` 播种。
6. **worker**：见 App 仓库 `docs/plans/2026-10-16-feedback-upload.md` §11 的部署命令。

## 部署现实（2026-10-16 实测，务必先读）

线上其实有**两个** Cloudflare worker，别搞混：

| worker | 跑在哪 | 域名 | 状态 |
|---|---|---|---|
| `fufumidi-cloud-sync` | **协作者的 CF 账号**（`3b038b29…`，我们没权限） | `fusync.de5.net`（+ `*.workers.dev` 兜底） | 云同步在用；**反馈路由已在代码里，但没部署上去** |
| `fufumidi-feedback` | **项目自己的 CF 账号**（`a50de010…`） | `fufumidi-feedback.fufumidi.workers.dev` | ✅ 已部署（D1 + KV 都绑好），但**国内访问不到**（见下） |

**国内访问不到 `*.workers.dev`** —— 实测 DNS 被污染：
`fufumidi-cloud-sync.fumivoice.workers.dev` 解析到 `198.27.124.186`（OVH 的 IP）、
`fufumidi-feedback.fufumidi.workers.dev` 解析到 `31.13.75.5`（Facebook 的 IP），
curl 60 秒都连不上；而 `fusync.de5.net` 0.7 秒通、`*.deno.dev` 3 秒通。
所以**客户端上传必须有一个可达的域名**，三条可行路线：

- **A（最快）**：把反馈路由部署到协作者那个 worker（代码已在 `src/index.js`）——
  `wrangler d1 migrations apply DB --remote` + `wrangler secret put GITHUB_TOKEN` + `wrangler deploy`，
  客户端走 `https://fusync.de5.net`（已是 BASES 第一条）。
- **B（最彻底，推荐长期）**：给项目自己的账号加一个域名（任意注册商 → 加进 Cloudflare 免费版），
  然后把 `fufumidi-feedback` 绑一个自定义域名（如 `fb.<你的域名>`），客户端 BASES 换过去。
  这样反馈完全不依赖协作者。
- **C（备选）**：把同一份逻辑搬到 Deno Deploy（`*.deno.dev` 实测可达）。

在 A/B/C 落地前，反馈页的「上传到反馈仓库」会走完两条候选地址后失败，并**自动把带 md 的 zip 存到本地**
（界面会提示路径），用户还能用「网页提交 / 存到本地」把反馈送出来 —— 功能不瘫，只是要多点一下。

## 排查

| 症状 | 先看 |
|---|---|
| App 上传报「反馈通道尚未开通」 | worker 没部署，或没配 `GITHUB_TOKEN` secret |
| 提交到了 GitHub，CNB 没有 | Actions 里 `mirror-to-cnb` 那次 run 的日志；多半是没配 `CNB_TOKEN` |
| 两边 HEAD 不一致 | 手动跑一次 workflow_dispatch，再看 run 日志 |
| 附件 404 | worker 的 R2 绑定（`BUCKET`）没配 |
