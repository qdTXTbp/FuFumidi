# FOUNDATION —— 架构与契约宪法（FuFumidi）

> 这份文档回答一件事：**新代码怎么写才像"一直就在那儿"**。
> 过程规范（分支 / PR / 发布 / CI）在 [`.github/CODING_GUIDELINES.md`](../.github/CODING_GUIDELINES.md)；
> 测试清单在 [`TESTING.md`](./TESTING.md)。三份合起来才是完整约定，本文件补的是**架构与契约**这一半。
>
> 维护方式：改架构或改契约**先改这里**，再改代码。规则要写清"谁定的、为什么"，没有出处的规则会被下一个会话删掉。

## 1. 分层与依赖方向

进程/运行时边界（**只允许向下依赖，反向依赖一律视为 bug**）：

| 层 | 位置 | 职责 | 不许做的事 |
| --- | --- | --- | --- |
| L4 引擎 | `engine/*.py` | 推理 / 转换 / 合成。被主进程当**子进程**拉起 | 不许 import Electron、不许读写渲染进程的文件、不许直接弹窗 |
| L3 主进程 | `main.js`、`main/*.js`、`plugin-host.js`、`cloud-sync/` | 文件系统、子进程、数据库、下载、窗口 | 不许 require `frontend/`（渲染进程代码） |
| L2 桥 | `preload.js` | **唯一**的 `contextBridge` 出口 | 不许放业务逻辑（只做转发 + 形状转换） |
| L1 渲染进程 | `frontend/src/**` | Vue 3 SPA（视图 / 组件 / store / core） | 不许直接碰 fs/net/child_process，只能走 `window.fuBridge` |
| L0 构建产物 | `renderer/dist/` | Vite 产物，由主进程加载 | 不许手改（改源码重新 build） |

实测（2026-10）：`frontend/src` 里对 `main/`、`engine/` 的 import **0 处**；`main/` 对 `frontend/`、`renderer/` 的 require **0 处** —— 这条边界今天是干净的，别弄脏。

辅助目录：`rust-core/`（可选 Rust 加速核，`npm run build:rust` / `test:rust`）、`src-tauri/`（Tauri 外壳，非主发布路径）、`plugins/`（插件运行时）、`resources/`（**不入库**的运行时与模型，见 `.gitignore`）。

## 2. 契约（每一层的形状由谁拥有）

1. **`window.fuBridge`（owner: `preload.js`）↔ `ipcMain.handle`（owner: `main/*.js`）**
   - 约 146 个桥成员 ↔ 157 个 `ipcMain.handle`（2026-10 实测）。新增一个能力 = 三处同改：
     `preload.js` 暴露 → `main/<area>.js` 里 `registerXxxIpc` 注册 handler → 在 `frontend/src/types/ipc.ts` 补类型。
   - **事件通道**（`webContents.send` → `onXxx(cb)`）必须返回**退订函数**，组件卸载时要调用（现有代码一律如此，别开例外）。
2. **主进程 ↔ 引擎（owner: `main/engine.js` 的 `spawnEngine`）**
   - 入参是 CLI 参数；出参是 **stdout 上的一段 JSON**（`{ok, ...}`）；进度是 `###PROG` 前缀行。
   - 加字段 = 引擎先吐（`engine/*.py`）、主进程透传、渲染进程可选消费；**删除或改名字段必须同步三处**，否则渲染侧会静默变 `undefined`（见 `contract-drift-audit` skill）。
3. **持久化形状**
   - 工程包 `.fufumidi`（自包含：轨道 + `files/` 伴奏资产 + `meta`）；数据根目录 `<dataRoot>/{midi,omr,models,temp}`；设置对象见 `frontend/src/types/ipc.ts` 的 `Settings`。
   - 持久化字段只增不删；要改名就**同时支持旧名一个版本**，并在 `CHANGES.md` 记一行。
4. **i18n（owner: `frontend/src/core/i18n.js` + `i18n_ja.js`）**
   - 源码里每一句中文 `t('…')` 都要在英文表与日文表同时有条目；繁体由 `core/zhHant.js` 自动转，不手写。
   - 审计脚本可随时跑（见第 5 节），**缺条目 = 未完成**，不是"以后补"。
5. **验收钩子**
   - 需要自动化的界面在 `localStorage.fufumidi_debug === '1'` 时挂 `window.__xxxDebug`，并且只读、不改变默认行为。

## 3. 命名与落点（新文件放哪）

| 你要加的东西 | 放这里 | 说明 |
| --- | --- | --- |
| 一整页 | `frontend/src/views/ViewXxx.vue` | 路由表在 `frontend/src/router.ts` |
| 复用组件 | `frontend/src/components/…` | 与业务无关的通用件放 `components/` 顶层 |
| 纯逻辑 / 算法 | `frontend/src/core/*.js` | 不依赖 Vue、可单测（如 `midi.js`、`oto.js`、`phrase_render.js`） |
| 状态 | `frontend/src/stores/*.ts` | Pinia；跨页共享的才进 store |
| 主进程能力 | `main/<area>.js` + `registerXxxIpc` | 在 `main.js` 里注册；不要往 `main.js` 里堆逻辑 |
| 引擎能力 | `engine/engine_<area>.py` | 沿用 `--flag` 入参 + stdout JSON + `###PROG` 进度 |
| 一次性验收脚本 | `scripts/cdp/*.cjs`（能长留的）否则放 `E:\Midi\_attic` | 见 `_attic/README.md` 目录规范 |

命名：Vue 组件 `PascalCase.vue`；JS/TS 函数变量 `camelCase`；引擎模块 `snake_case.py`；验证钩子用 `data-guide="区域-用途"`；CSS 变量用 `--token-name`。

## 4. 变更规则（哪些要人拍板，哪些可以自己动）

- **必须人类决策**：新增第三方依赖；改公共契约（桥成员 / IPC 频道 / 引擎 JSON 字段 / 持久化字段）；
  引入新抽象层；动 `main.js` 启动流程、`electron-builder*.yml`、自动更新通道。
- **代理可独立完成（仍需跑完第 5 节的门禁）**：局部重构且行为不变、注释与文档、测试与验收脚本、
  补齐 i18n、界面文案与可发现性、性能优化（不改契约）、把一次性脚本收进 `_attic`。
- **"清理"与"架构演进"分开**：清重复代码 / 死代码用 `clean-code-clean-mode`（一次一处、给人看、可回滚）；
  拆模块 / 换边界属于架构演进，先改本文件再动代码。

## 5. 门禁（每个会话跑同样的命令，别各写一套）

```powershell
# 1) 前端构建（Vite 产物落到 renderer/dist）
npm --prefix frontend run build

# 2) 类型检查 / 前端单测 / 插件沙箱
npm run typecheck
npm run test:ui
npm run test:plugin

# 3) 引擎单测（venv 在 _attic 里，路径按 2026-10 整理后为准）
E:\Midi\_attic\_sing_tmp\venv\Scripts\python.exe -m pytest tests -q -p no:cacheprovider --ignore=tests/test_openutau_core_matches_source.py   # 在 engine/ 下跑

# 4) 覆盖安装版 + 冒烟（CDP 驱动，断言 0 条 console 错误）
node scripts/deploy-installed.cjs
powershell -NoProfile -ExecutionPolicy Bypass -File E:\Midi\_attic\_sing_tmp\relaunch.ps1
node E:\Midi\_attic\_sing_tmp\r33-smoke.cjs

# 5) i18n 覆盖率审计
node E:\Midi\_attic\_sing_tmp\i18n-list.mjs
```

**"构建通过"不等于"能用"**：历史上有三次构建全绿但功能全坏（`Icon.vue` TDZ、`defineExpose` 里放了没定义的函数、漏 import）。
装到 `E:\Midi\FuFumidi` 跑一遍冒烟是底线；界面类改动还要看截图/像素。

## 6. 已知的边界模糊处（诚实清单，动它们前先想清楚）

1. `resources/` 有 1.5 GB 运行时与模型，**不在 git 里**，靠 README 里的准备步骤重建 —— 换机器/进虚拟机时最容易漏。
2. `src-tauri/` 与 Electron 主路径并存，但**发布只走 Electron**；改动前先确认目标外壳。
3. `engine/` 274 个文件里有若干历史模块（`linked_list.py`、`zip_pngs.py` 等）与主链路关系不明 —— 清理前必须先用 `grep` 证明没有调用方。
4. `renderer/dist`、`release/`、`gpu-package*` 都是产物目录，已被 `.gitignore` 排除；不要把产物当源码改。
5. 本地探针 / venv / 历史备份现在统一放在 `E:\Midi\_attic`（见该目录 README）——引用它们时用**绝对路径**，别假设在仓库里。
