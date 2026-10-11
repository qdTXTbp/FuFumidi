# AGENTS.md —— 在这个仓库里工作的第一步

七份约定，按顺序读：

1. **[docs/FOUNDATION.md](docs/FOUNDATION.md)** —— 架构分层、依赖方向、契约（桥 / 引擎 JSON / 持久化 / i18n）、
   新文件落点、变更规则、**每次都要跑的门禁命令**。
2. **[.github/CODING_GUIDELINES.md](.github/CODING_GUIDELINES.md)** —— 分支、提交信息、PR、发布与上传流程。
3. **[docs/TESTING.md](docs/TESTING.md)** —— 测试清单与"什么算验过"。
4. **[docs/HYGIENE.md](docs/HYGIENE.md)** —— 仓库卫生审计的结论与理由（许可证、lockfile、CI 配置、体积例外）。
5. **[docs/VENDOR.md](docs/VENDOR.md)** —— 内置第三方二进制（verovio / js-synthesizer / 音色库 / OpenUtau native）的版本、来源与 SHA-256；改 vendor 必须同时改它。
6. **[docs/DOWNLOADS.md](docs/DOWNLOADS.md)** —— **资源下载的唯一入口**：所有取文件字节的代码都走 `main/fast-download.js`，能力清单、实测数据、禁止写法、新增下载点的清单。
7. **[docs/COVER.md](docs/COVER.md)** —— **翻唱工作流**（分离 → 扒谱 → 合成 → 混音）：两条音色通道
   （DiffSinger 声库 / GPT-SoVITS 音色）、断点续跑、对齐与客观量，以及 GPT-SoVITS 的四个坑。

几条最容易忘的硬规则：

- **依赖只能向下**：渲染进程不许碰 fs/net/子进程，只能走 `window.fuBridge`；引擎不许 import Electron；主进程不许 require `frontend/`。
- **资源下载只有一个入口**：从网络取文件字节一律走 `main/fast-download.js`（测速 / 分段 / 并发 / 续传 / 看门狗 / 完整性已全在里面），别在业务模块里再写 `fetch` + 写盘循环；新增下载点必须补 `npm run test:download` 用例。见 `docs/DOWNLOADS.md`。
- **新能力三处同改**：`preload.js` 暴露 → `main/<area>.js` 注册 handler → `frontend/src/types/ipc.ts` 补类型。
- **中文文案必须 EN + JA 同时补**（`core/i18n.js` / `core/i18n_ja.js`），缺一条算未完成。
- **界面改动必须装到 `E:\Midi\FuFumidi` 里跑一遍冒烟**（`deploy-installed.cjs` + 冒烟脚本）；构建绿 ≠ 能用。
- **换行/编码**：写 `.ps1` 要 UTF-8 **with BOM**（PowerShell 5.1 否则按 ANSI 读，中文注释变乱码直接报语法错）。
- **目录规范**：`E:\Midi` 只留 7 个文件夹 + `_attic`，规则与整理脚本见 `E:\Midi\_attic\README.md`。
- **lockfile 必须入库**（根 / `frontend/` / `cloud-sync/worker/`），CI 与发布构建一律 `npm ci`；
  改了 `package.json` 就顺手提交对应的 `package-lock.json`。
- **空白与编码**：遵循根目录 `.editorconfig` 与 `.gitattributes`（仓库里存 LF，`.ps1` 在工作区是 CRLF 且必须带 BOM）。
