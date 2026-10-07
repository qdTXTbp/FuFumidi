# DOWNLOADS —— 资源下载的唯一入口（规范）

> **一句话规则：FuFumidi 里任何"从网络取文件字节"的代码，都必须走 `main/fast-download.js`。**
> 不许在别处再写 `net.fetch` + `createWriteStream` 的下载循环。新增下载点必须同时补
> `scripts/test-fast-download.mjs` 的用例 —— 没用例的下载点算未完成。

这条规则是踩出来的，不是审美偏好。

---

## 1. 为什么要收敛成一个入口

历史上每个模块各写了一份下载器，每份只解决了自己踩到的那个坑：

| 模块 | 自己解决了 | 缺的 |
| --- | --- | --- |
| `main/models.js` | 多源测速 + 分段 | 低速轮换；分卷缺完整性校验 |
| `main/diffsinger.js` | 测速 + 分段 + 续传 | （已迁 FastDL） |
| `main/soundfonts.js` | 停滞看门狗 + 续传 | 无测速：排第一的源只要"慢而不断"就一路走完 |
| `main/utau.js` | 轮换 + 续传 | 无测速、无分段 |
| `main/wallpaper.js` | 无 | 连断点续传都没有，断了从 0 重来 |
| `main/update.js` | 多镜像轮换 | 无测速、无分段（143MB 安装包单连接） |

同一种故障因此在不同页面反复出现：**"有时 50MB/s、有时几百 KB"**、**"下一半就断"**、
**"下到 100% 又说校验失败，重试还是卡在同一处"**。

---

## 2. 三条实测事实（决定了现在的策略，改策略前先重测）

测量脚本：`node scripts/bench-download.mjs`（真实分卷，非模拟）。

1. **CNB 的 git raw 端点不支持 Range、也不返回 `content-length`**（`transfer-encoding: chunked`）：
   - 带 `Range: bytes=0-1023` 请求仍然返回 **200 + 整个文件**；
   - 因此 **走它的单文件无法分段、也无法用 Range 续传**，单连接实测约 **6.7 MB/s**；
   - 它还会返回错误的 `content-type`（`.ckpt.part01` 报 `application/zip`）—— 别信这个头。
   - → 走 CNB 的大文件**提速只能靠"多文件/多分卷并发"**，不能靠"单文件多分段"。
1. **传输层比什么都重要：Electron 的 `net.fetch` 走 HTTP/2，在 CNB 上慢 93 倍。**
   同一台机器、同一批分卷、同样 12 路并发，在 Electron 33 主进程里实测：

   | 传输层 | 协议 | 聚合吞吐 |
   | --- | --- | --- |
   | `net.fetch`（Chromium 网络栈） | HTTP/2（`cnb.cool` 的 ALPN 协商结果是 `h2`） | **0.28 MB/s** |
   | `globalThis.fetch`（Node / undici） | HTTP/1.1 | **26.01 MB/s** |

   这正是「资源中心下载龟速、下一半就断」的真身：以前所有资源下载都走 `net.fetch`。
   1.7 GB 的模型在 0.28 MB/s 下要一个多小时，任何一次抖动都会前功尽弃。

   **因此 `fast-download.js` 的传输层顺序是「Node 优先、Chromium 兜底」**：
   Node 的 fetch 不读 Windows 系统代理，企业代理环境下可能连不通，所以保留 Chromium ——
   某条通道连续失败 3 次就换顺序（会话内记住）。
   → 新增下载点别自己调 `net.fetch` 取正文；也别拿 `net.fetch` 去判断「这条路通不通」——
   通不通与快不快是两件事。

2. **分卷并发是主要提速杠杆**（每个分卷一个连接，实测聚合吞吐）：

   | 并行分卷 | 2 | 4 | 8 | **12** | 16 | 20 | 24 |
   | --- | --- | --- | --- | --- | --- | --- | --- |
   | 聚合 MB/s | 9.6 | 13.8 | 18.5 | **24.5** | 28.3 | 33.5 | 35.9 |

   收益递减且要顾及镜像压力，默认取 **12 路**（`FastDL.PARTS_CONCURRENCY`）。
3. **Models 仓库的分卷是固定 25 MiB 切片**，最后一卷是余数：
   `expectedPartSize(total, parts, i) = min(25MiB, total - (i-1)*25MiB)`。
   已用 muscriptor/small（16 卷）、vr/1_hp_uvr（5 卷）、htdemucs4（4 卷）核对，
   推导值与实际字节数逐一相符，且各卷求和 == manifest 的 `size`。
   → **每卷的期望字节数可以零成本推导**，这是分卷下载能做完整性校验的基础。

其他候选源在本机的实测（2026-10）：`ghfast.top` 4 路 ≈ 2.8 MB/s；
`raw.githubusercontent.com` / `gh-proxy.com` 吞吐 ≈ 0（1 字节 Range 探测仍可用，
所以"探长度"能过、"下正文"不能，别把探测成功当成可用）。

---

## 3. 适用范围与唯一例外

**必须走 FastDL**：模型权重（含 HuggingFace 整仓）、分卷仓库（MuScriptor / MSST 分离模型 / VR）、
DiffSinger 声库与声码器、UTAU 声库归档、音色库 SF2/SF3、动态壁纸视频、GPU 增强组件、更新安装包。

**唯一例外**：**元数据**（`manifest.json`、HF 的 `/api/models/.../tree`、Release API 的 JSON、缩略图）
可以用 `net.fetch` 直接取，但必须：只读小响应、带超时、带渠道回退。
凡是"写进用户磁盘的实体资源"，一律 FastDL。

---

## 4. FastDL 提供的能力（调用方直接拿到，不要重造）

```js
const createFastDownload = require('./fast-download');
const FastDL = createFastDownload({ net, fs, path });
```

| 能力 | API | 说明 |
| --- | --- | --- |
| ① 多源并发测速 | `rankMirrors(urls, ctrl)` | 各源取一小段实测，按速度降序；结果缓存 5 分钟 |
| ② 源顺序复用 | `hostRankOf(ranked)` + `hostRank` 选项 | 同一批文件只测速一次（66 卷的模型省掉 65 次测速） |
| ③ 分段并发 | `downloadFast`（源支持 206 时自动） | 慢源(<12MB/s)开 8 段、快源开 4 段，最多 8 段/8 并发 |
| ④ 多文件并发 | `downloadMany(items, {concurrency})` | 分卷/整仓；聚合进度 `{bytesDone, bytesTotal, overallPercent}` |
| ⑤ 断点续传 | 单连接路径 `.part` + Range；分段路径每段独立落盘 | 取消/暂停**不清**断点 |
| ⑥ 停滞看门狗 | 内置（按实收字节计时） | N 秒无字节即中止当前连接换源 |
| ⑦ 低速轮换 | 内置（`LOW_BPS` + 12s 热身） | 慢源主动放弃，"有时几百 KB"的解法 |
| ⑧ 完整性 | `expectSize` / 远端长度 / `minSize` 三重校验 + 调用方 SHA-256 | 不符即抛错并丢弃，**绝不把半成品当成功** |
| ⑨ 磁盘预检 | `checkDiskSpace(dest, needBytes)` | 空间不够动手前就报，不等到 90% |
| ⑩ 取消 / 暂停 | `isUserAbort`（对象，`.aborted`/`.isUserAbort`）+ `ctrl` | 中止时抛 `err.cancelled = true` |

### 单文件

```js
const r = await FastDL.downloadFast({
  urls,                       // 候选源（自己按下载源偏好排好序，FastDL 会再实测覆盖）
  dest,                       // 最终路径；内部用 dest + '.part' 续传
  minSize: spec.minSize,      // 过小 → 抛错（多半是被代理返回的错误页）
  expectSize: spec.size || 0, // 已知确切字节数就给，给了就强校验
  headers: { 'user-agent': 'FuFumidi' },
  isUserAbort: guardOf(id),   // { get aborted() { … } }：每读一块问一次
  ctrl,                       // 取消/暂停时由 handler abort
  label: spec.name,           // 出错信息与进度里带上名字
  onProgress: (p) => send(p), // {received,total,percent,speed,segmented,retry,done}
});
// r = { size, total, host, segments }
```

### 多文件 / 分卷

```js
const hostRank = FastDL.hostRankOf(await FastDL.rankMirrors(partUrls(partName(1)), ctrl));
await FastDL.downloadMany(
  jobs.map((j) => ({
    urls: partUrls(j.name), dest: j.dest,
    expectSize: FastDL.expectedPartSize(total, parts, j.index),  // 25MiB 切片推导
    minSize: 1024, singleStream: true,                            // 分卷级并发已吃满，卷内不再分段
    label: j.name,
  })),
  { concurrency: FastDL.PARTS_CONCURRENCY, hostRank, ctrl, isUserAbort: guardOf(id), onProgress: send }
);
```

### 分卷下载的三条硬要求（`downloadSplitRepo` 已实现，照抄）

1. **复用前先验长度**：分卷长度 ≠ 推导值 → 删掉重下。复用半截分卷会让 SHA 校验在 100% 处失败。
2. **先验每卷、再验总量、最后算 SHA**：让错误在最早、最便宜的地方暴露。
3. **SHA 失败 = 分卷整体不可信** → 连 `.parts` 一起丢弃重下。
   只删成品文件会造成"每次都卡在同一处、重试永远失败"的死循环（这正是"模型下一半就中断"的真身）。

---

## 5. 禁止的写法（代码评审直接打回）

- `net.fetch` 之后自己 `createWriteStream` 写正文；`http/https` 模块自己收流。
- 下载结束后**不比对字节数**就 `rename` 成正式文件。
- 把"能连上/探测成功"当作"源可用"（本机 GitHub raw 就是探得通、下不动）。
- 失败时删掉 `.part`（等于把用户的断点扔掉）。
- 在非下载模块里再长出一份 `rankMirrors` / `downloadSingleFast`。

---

## 6. 新增一个资源下载点的清单

1. 候选 URL 用 `main/download-source.js` 的 `orderUrls` / `githubMirrorCandidates` 拼接（按用户下载源偏好）。
2. 调 `FastDL.downloadFast` 或 `downloadMany`；`label` 必填。
3. 给出 `minSize`；能拿到确切大小就给 `expectSize`；有官方 SHA-256 就校验。
4. 大文件先 `checkDiskSpace`。
5. 取消/暂停用 `isUserAbort` + `ctrl`，并按 `err.cancelled` 区分"用户取消"与"网络失败"。
6. 进度按 `phase` 上报，**换源重试不许把百分比打回 0**（用 `retrying`/`retry` 相位说明）。
7. 补 `scripts/test-fast-download.mjs` 用例；跑 `npm run test:download`。

---

## 7. 回归与基准

```powershell
npm run test:download     # 纯逻辑 + 本地 HTTP 服务端到端（分段/续传/完整性/取消/并发）
node scripts/bench-download.mjs    # 真实分卷吞吐基准（会联网，输出 Markdown 表）
```

`test:download` 用本地 HTTP 服务覆盖：分段路径字节一致、忽略 Range 的源自动退回单连接、
预置断点能续传、声明长度不足必须抛错、取消保断点、多文件并发聚合进度正确。
**这些用例不联网**，所以 CI 里可以稳定跑。
