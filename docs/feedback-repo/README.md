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

**国内访问不到 `*.workers.dev`：是 SNI 阻断，不只是 DNS 污染（2026-10-16 定性）** ——
DNS 层面确实被污染（`fufumidi-cloud-sync.fumivoice.workers.dev` 解析到 OVH 的 `198.27.124.186`、
`fufumidi-feedback.fufumidi.workers.dev` 解析到 Facebook 的 `31.13.75.5`），但**绕过解析也没用**：
用 DoH 拿到真实 CF IP（`172.67.133.241` / `104.21.5.228`）后带正确 SNI 直连，
**三个 IP 全部在 TLS 握手时被 RST（0.08–0.25 秒）**，不指定 IP 则 12 秒超时。
所以「DoH + 固定 IP」这条绕过方案**实测无效**，必须换可达域名/平台。

各平台用同一手法判别（DoH 解析 + 带 SNI 连接）：

| 结果 | 子域 |
|---|---|
| ✅ 可达 | `netlify.app`(0.49 s)、`deno.dev`(1.9 s)、`onrender.com`(1.2 s)、`up.railway.app`(0.77 s)、`zeabur.app`(0.82 s)、`github.io`、`gitee.io` |
| ❌ SNI 阻断 | `vercel.app`(RST 0.09 s)、`workers.dev` |

> **平台首页通 ≠ 函数子域通**（`vercel.com` 200，但 `*.vercel.app` 被 RST）—— 判断可达性必须按子域测。

**Deno Deploy 已停止服务**：Cloudflare 收购 Deno 团队后 Deno Deploy 关停，新账号注册返回
`403 SIGNUP_UNAVAILABLE`。仓库里的 `deno/` 因此废弃（它验证了「附件走 Release 资产」这套协议可用）。

现在的可行路线：

- **A（当前选定，不依赖任何人）**：Netlify Functions（`*.netlify.app` 实测可达）。
  站点根目录 `netlify/`，端点是 `POST /feedback`、`GET /health`；
  代码在 `netlify/lib/feedback-core.mjs`，`npm run test:netlify` 9 项离线单测。
  **附件上限 4 MB**（Netlify 同步函数请求体 6 MB，base64 膨胀 4/3）。
- **B（更省基建，要协作者配合）**：让协作者在**自己账号**里单独建一个 feedback worker
  绑 `fb.de5.net`（**别动线上云同步那个 worker**）。`fusync.de5.net/health` 现在 3.7 秒可达，
  但 `/feedback` 返回 401 —— 反馈路由不在那台已部署的 worker 里。
- **C（最彻底）**：项目自己账号加一个域名并绑自定义域名，用已部署的 `fufumidi-feedback` worker。

在 A/B/C 落地前，反馈页的「上传到反馈仓库」会走完候选地址后失败，并**自动把带 md 的 zip 存到本地**
（界面会提示路径），用户还能用「网页提交 / 存到本地」把反馈送出来 —— 功能不瘫，只是要多点一下。

## 排查

| 症状 | 先看 |
|---|---|
| App 上传报「反馈通道尚未开通」 | worker 没部署，或没配 `GITHUB_TOKEN` secret |
| 提交到了 GitHub，CNB 没有 | Actions 里 `mirror-to-cnb` 那次 run 的日志；多半是没配 `CNB_TOKEN` |
| 两边 HEAD 不一致 | 手动跑一次 workflow_dispatch，再看 run 日志 |
| 附件 404 | worker 的 R2 绑定（`BUCKET`）没配 |
