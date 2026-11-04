# Tauri 真正外壳（Rust host）—— M1 第一步

> 2026-11-04 用户确认「继续用 Tauri 替换 Electron」，并按「尽量都用 RUST 重写」推进非 ML。
> 本目录是**真正的外壳骨架**（不再是 POC）：Rust host + 现有 Vue renderer + Python 仅推理 sidecar。

## 1. 边界

| 层 | 语言 | 现状 |
|---|---|---|
| 窗口/系统集成/IPC 宿主 | Rust（tauri 2） | 已建骨架：窗口、host_info、python_selfcheck、ping |
| host 业务（文件/设置/曲库/任务/下载/更新） | Rust | **待迁移**（T-117，逐步替换 main/*.js） |
| 非 ML 算法（MIDI/SF2/MusicXML/ustx/UTAU DSP/音频链） | Rust | **待迁移**（R-007/R-008，crates/ 已有 SMF/量化/移调） |
| 模型推理 | Python sidecar | **保留**（ADR-0001/0002）；Rust 只负责启动、健康检查、协议转发（T-118） |
| UI | Vue 3 / WebView2 | 直接加载 `renderer/dist`，沿用 `frontend/src/bridge/tauri.js` |

## 2. 构建与运行

```bash
cd E:/Midi/FuFumidi-Source
npm --prefix frontend run build          # 产出 renderer/dist
cargo build --manifest-path shells/tauri/Cargo.toml --offline
./shells/tauri/target/debug/fufumidi-shell.exe --self-check   # 打印 host/Python/renderer 路径
./shells/tauri/target/debug/fufumidi-shell.exe                 # 开窗加载真实 UI
```

> 首次编译依赖较多；本机可复用 `poc/tauri-poc/target` 作为 CARGO_TARGET_DIR 加速（实测 16.7 s）。
> 正式构建使用本目录自己的 target。

## 3. 已实测（2026-11-04）

- `--self-check`：version 6.5.0-beta.1；python = `resources/python/python.exe`（exists=true）；
  renderer = `renderer/dist`（index.html exists=true）。
- 开窗：**0.66 s**；窗口标题 `FuFumidi`；主进程 RSS 41.4 MB；WebView2 子进程 7 个；
  截图 `shells/tauri/artifacts/window.png`（真实首页 + 新手引导，不是占位页）。
- 与 POC 的区别：POC 只有 `poc_ping/poc_echo`；本壳已带 host_info/python_selfcheck，
  并可作为后续 T-115（IPC 纵切）、T-118（Python sidecar supervisor）的落点。

## 3.1 T-115 IPC 纵切（2026-11-04，已完成 11 条）

| 命令 | 作用 | 验证 |
|---|---|---|
| host_info | 版本/模式/数据目录/Python/renderer 状态 | CDP eval |
| app_version | 6.5.0-beta.1 | CDP eval |
| python_selfcheck | 启动 `resources/python/python.exe` 并取 3.12.10 | CDP eval |
| load_settings / save_settings | `%APPDATA%/FuFumidi/settings.json`（可用 FUFUMIDI_DATA_ROOT 覆盖） | 写 42 → 读回 42 |
| db_kv_get / db_kv_set | `kv.json` 键值存储 | 写 {a:1} → 读回 |
| list_midi_files | 递归扫描 .mid/.midi/.kar/.rmi（≤2000，深度≤8） | 临时目录 1 个 .mid |
| read_binary | `tauri::ipc::Response` 原始字节 | 读出 `MThd` |
| save_binary | 按 opts.path/bytes 落盘 | 写 [1,2,3,4] → 读回长度 4 |
| engine_probe | Rust 启动 Python 执行 `music2midi.py probe`，返回耗时 + probe JSON | 实测 4.9 s，probe.ok=true，engine 路径与 Python 3.12.10 正确 |
| convert | **常驻 Python worker**（`music2midi.py worker`）执行一次真实转录，模型/参数原样转发 | 1 s 440Hz WAV → Basic Pitch **1 个音符**；冷 14.3 s / 暖 **5.5 s**；13 条日志；输出 MIDI 头 MThd |
| engine_worker_status | 常驻 worker 状态（pid/running/seq） | running=true，seq=1，pid 有效 |
| cancel | 置取消标志 + taskkill worker；阻塞读返回 EOF 后识别为 canceled | 120 s WAV 转录中取消：cancelR.canceled=true、convert 返回 {ok:false,canceled:true}、worker running=false；下次请求重新拉起 |
| presets_list / save / delete / last_used | Rust 读写 dataRoot/presets.json；内置表由 engine/presets.py 生成并嵌入（builtin_presets.json） | 9 个内置预设 + 11 个 model_defaults；保存 Smoke Preset → last_used；删除后消失 |
| presets_set_model / reorder / reorder_to / restore | 模型→预设绑定、排序、恢复内置 | 绑定 basic→Smoke Preset、解绑、删除均成功 |
| set_transcribe_pause | 写/删 `dataRoot/engine.pause`，引擎 pause_gate 监听（worker 启动时注入 FUFUMIDI_PAUSE_FILE） | 120 s WAV：暂停后 900 ms 仍未结束（settledEarly=false），继续后完成，pausedConv.ok=true |
| model_list | 13 个核心模型条目（basic/piano/hft/MuScriptor×3/yourmt3/miros/aria/beat_this/audio_tagger/hnsep/HTDemucs4_6stems）；exists 按 models 目录真实大小判断 | smoke 断言 13 条、id 齐全、含 separate 条目 |
| db_status / db_songs_list / db_songs_put / db_songs_delete | JSON 曲库（dataDir/songs.json），按 id upsert/删除 | 写 smoke-song → 列表 1 条 → 删除 → 0 条 |
| db_playlists_list / db_playlists_put | JSON 歌单（dataDir/playlists.json） | 默认歌单 + smoke-pl 出现 |
| soundfont_list | 扫描 renderer/vendor/soundfonts + dataDir/soundfonts（sf2/sf3） | 开发树返回 GeneralUser.sf2 |
| dep_check | Rust 启动 Python `deps.py check`，解析 `###RESULT` 的 groups | 返回 universal/piano/aria/muscriptor/separate/transkun 6 组 |
| diag_export | 写 dataDir/diagnostics-<ts>.json（host/python/models/soundfonts/dataDir） | 文件生成，ok=true |
| notify | 通知插件未接；明确返回 delivered=false | ok=true（不伪造系统通知） |
| open_output / open_external | 校验路径/协议后调 explorer / cmd start | 非法路径/协议返回 ok=false（冒烟只测安全失败） |

### 3.2 T-118 Python 常驻 supervisor（2026-11-04）

- Rust 维护 `Worker { child, stdin, reader, seq }`（`Arc<Mutex<Option<Worker>>>`）：
  首次 `convert` 时拉起 `python music2midi.py worker`，之后请求写 stdin（`_id` 自增）；
- stdout 按行解析：`###LOG` → 转发 Tauri 事件 `engine:log`；`###PROG` → `engine:progress`；
  `###RESULT` 按 `_id` 匹配后返回，附带 `elapsedMs/workerSeq/logLines`；
- **取消**：`cancel` 置 `AtomicBool` 并 taskkill 当前 pid；阻塞中的 `read_line` 返回 EOF，
  `convert` 据此返回 `{ok:false,canceled:true}` 并清空 worker；下一次 `convert` 重新拉起（冷启动）；
- 进程退出/读写失败 → 清空 worker 并返回错误，**下一次请求自动重新拉起**（首请求报错，不静默重跑）；
- 退出（`RunEvent::Exit`）时写 `{"cmd":"exit"}` 并 kill，避免残留 Python；
- **模型/参数契约未改**：req 原样透传，模型路径/格式仍由 Python 侧决定。

实测（smoke）：1 s 440 Hz WAV → Basic Pitch 1 个音符；冷启动 14.3 s、暖 5.5 s；13 条日志；
worker running=true seq=1；输出 MIDI 头 `MThd`。剩余：cancel/pause、UI 队列侧进度绑定、
批量并发、模型列表等 host 通道（T-115 扩面）。

### 3.2.1 关键修复：Tauri 桥注入时序 + 嵌入 renderer 的重建（2026-11-04）

- **桥注入时序**：`api.ts` 原本用 `const bridge = window.fuBridge` 在模块求值时捕获；
  Tauri 的 `__TAURI_INTERNALS__` 可能晚于 store 模块就绪，导致 `api.bridge` 永久 undefined
  （曲库/设置读不到，界面显示 0 首）。修法：`api.bridge` 改为 **live binding** +
  `refreshBridge()`；`bridge/install.ts` 作为 main.ts 第一个 import 先装桥，main.ts 再刷新一次。
- **Tauri 会把 renderer/dist 嵌入 exe**：只跑 `npm run build:ui` 不会更新壳。
  新增 `npm run tauri:build`（build:ui + cargo build），避免"前端改了、Tauri 里还是旧的"。
- 修复后 smoke 实测：`apiBridgeReady=true / apiBridgeKeys=71`、`restoreBridgeKeys=71`、
  `storeSongs=1`、页面出现 `Smoke UI Song`、曲库显示 **1 首**、首页"继续上次的工作"出现该曲。

### 3.3 曲库 JSON store + UI 路由冒烟（2026-11-04）

- **数据根对齐**：默认先找安装目录旁的 `FuFumidiData`（存在即用），否则 `%APPDATA%/FuFumidi/FuFumidiData`；
  `FUFUMIDI_DATA_ROOT` 仍可覆盖（smoke 用临时目录）。模型目录 = 数据根/`models`。
- 新增 `model_list`（21 条命令之一）：13 个核心模型条目 + 真实 `exists/size` 判断；
  完整目录仍以 `main/models.js` 为准，这里是 T-115/T-117 过渡实现（不再让转录/资源页一律空态）。
- 新增 6 条持久化命令（T-117 第一步）：`db_status / db_songs_list / db_songs_put / db_songs_delete /
  db_playlists_list / db_playlists_put`，落在 `FUFUMIDI_DATA_ROOT`（默认 `%APPDATA%/FuFumidi`）
  的 `songs.json / playlists.json`；按 id upsert，原子 rename。
- smoke 增加 **uiRoutes**：依次进入 `#/transcribe → #/resources → #/piano3d → #/music#/home`，
  实测每页 textLen 658–1404、#app 已挂载、无页面崩溃（模型数据仍因 model_list 未迁而为空，
  属于下一步 T-115/T-117 范围，不是显示故障）。

**冒烟命令**：`npm run tauri:smoke`（`scripts/tauri/smoke.mjs`）：

- 启动真实壳 + WebView2 CDP（`--remote-debugging-port`）；
### 3.4 预设（T-115 收尾，2026-11-04）

- 新增 8 条命令：`presets_list/save/delete/last_used/set_model/reorder/reorder_to/restore`；
  数据落 `dataRoot/presets.json`（与 Electron/Python 同一份 schema）；
- 内置 9 套「每模型最优」预设由 `engine/presets.py` 生成后嵌入 `shells/tauri/src/builtin_presets.json`
  （生成命令：`python -c "import sys,json;sys.path.insert(0,'engine');import presets;..."`）；
  **Python 不再是运行时依赖**，但预设表变更时需重新生成该 JSON（T-117 会加漂移检查）；
- 模型绑定：桥补 `presets.setModelPreset` → `presets_set_model`；
- smoke 实测：9 builtins / 11 model_defaults；保存 Smoke Preset → last_used；绑定/解绑 basic；删除后列表消失；
  **23 项**断言全绿。

- 断言 **24 项全绿**：host / engineProbe / convert / worker / **pause** / cancel / presets / dbSongs / dbPlaylists /
  soundfonts / depCheck / diagExport / safeShellOps / modelList / version / python / settings / kv /
  listMidi / readBinary / saveBinary / ui / uiRoutes / uiLibrary；
  `uiLibrary` = 写入曲库 → 真刷新 → 侧栏/首页出现该曲（storeSongs=1，曲库 1 首）；
- UI 断言：title、#app 已挂载、`window.fuBridge` 与 `window.__TAURI__` 均为 object、正文 >200 字；
- 实测输出：version 6.5.0-beta.1、Python 3.12.10、settings 42 往返、MIDI 头 `MThd`、字节 4 往返；
- 截图：`shells/tauri/artifacts/smoke.png`（真实 UI）。

## 4. 当前命令清单（37 条）

host_info, app_version, ping, python_selfcheck, engine_probe, convert, engine_worker_status,
load_settings, save_settings, db_kv_get, db_kv_set, db_status, db_songs_list, db_songs_put,
db_songs_delete, db_playlists_list, db_playlists_put, model_list, list_midi_files, read_binary,
save_binary, soundfont_list, dep_check, diag_export, notify, open_output, open_external, cancel,
presets_list, presets_save, presets_delete, presets_last_used, presets_set_model,
presets_reorder, presets_reorder_to, presets_restore, set_transcribe_pause。

## 4.1 下一步

1. **T-115 IPC 纵切**：从 ipc.schema.json 生成 10 条真实 command + 桥映射（含事件退订），
   替换 `frontend/src/bridge/tauri.js` 中的手写映射。
2. **T-118 Python sidecar supervisor**：Rust 启动/监控 Python，转发 `convert/separate` 等推理请求；
   模型路径/参数契约不变。
3. **T-117 host 业务迁移**：文件/设置/曲库/任务队列先迁，保持 IPC 语义与双跑回归。
4. T-118 剩余：cancel/pause、批量并发、UI 队列侧进度绑定、崩溃重启策略（当前是"下次请求重新拉起"）；
5. T-119 双构建 + Electron 回退；T-114 品牌一致性校验（图标复用 build/icon.ico）。

## 5. 风险与约束

- 现有 172 条 IPC 缺口仍在本壳上存在：UI 能渲染 ≠ 所有操作可用；必须逐条迁移并以 E2E 覆盖。
- 更新链仍要自研（官方插件无增量、验签不兼容）。
- Python 保留意味着包体不会降到 ≤250 MiB；本阶段只追求「Electron 被 Tauri 替代 + 非 ML Rust 化」。
- **模型兼容是硬约束**：不得改模型格式/ID/路径/下载源；迁移只换宿主，不换推理。
