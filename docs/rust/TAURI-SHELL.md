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
| pick_file / pick_directory / pick_audio / pick_audio_files / pick_image / pick_music_xml | 原生文件/目录对话框（tauri-plugin-dialog 2.8.4，Rust 直接调用） | 实弹验收：打开 pick_file 后 PowerShell 发 Esc，Promise 解析为 null（dialog-check.mjs）；选文件仍可人工复验 |
| model_list | 13 个核心模型条目（basic/piano/hft/MuScriptor×3/yourmt3/miros/aria/beat_this/audio_tagger/hnsep/HTDemucs4_6stems）；exists 按 models 目录真实大小判断 | smoke 断言 13 条、id 齐全、含 separate 条目 |
| db_status / db_songs_list / db_songs_put / db_songs_delete | **共享 Electron SQLite**（legacy `fufumidi.sqlite`；测试态用 dataRoot 独立库），按 id upsert/删除 | smoke 往返通过；真实库只读验收读到 **1972 首** |
| db_playlists_list / db_playlists_put / db_playlists_delete | 同一 SQLite 的 playlists 表 | smoke 默认歌单 + smoke-pl；Rust 单测 put/list/delete 往返 |
| db_kv_get / db_kv_set | 同一 SQLite 的 kv 表 | smoke 写 {a:1} → 读回 |
| check_midi | 与 Electron library:checkMidi 同语义：只认数据根 midi/ 内、非空文件，返回 missing | Rust 单测：根内文件保留、缺失/根外文件进 missing |
| wallpaper_defaults | 扫描桌面 mp4/webm/mov，最多 4 个、按名排序 | Rust 单测：排序/截断/扩展名过滤 |
| delete_midi / rename_midi | 曲库文件删除/改名（限数据根 midi/，非法字符清洗、重名加 (2)、扩展名保留） | Rust 单测：根外拒绝、改名落盘、同名不重命名、删除消失 |
| list_audio_files | 递归扫描音频/视频扩展（≤2000、深度≤8），排序 | Rust 单测：只收音频、递归、忽略 txt |
| library_stats | 曲库目录文件数与字节数 | Rust 单测：只统计顶层文件 |
| read_soundfont | 读取 SF2 原始字节（≤512MB；SF3 转换仍未迁） | Rust 读取路径/大小保护 |
| data_root / open_data_root / clean_temp | 数据根概览（9 个目录大小）、打开数据根、清理 temp | Rust 单测：9 条目、temp 大小 = 文件总和、清理后消失（打开目录不测） |
| has_midi / verify_midi / dupe_midi | 单文件存在校验；Rust core 解析曲库（轨道/音符/BPM/损坏）；FNV 哈希查重 | Rust 单测：合法 SMF 2 音符、坏文件计入 bad、重复文件 1 组 2 个 |
| get_zoom_factor / set_zoom_factor / set_full_screen | WebView 缩放（50%–300%，状态记忆）与全屏 | Rust 单测：缩放夹取/NaN 回退 1.0/两位小数；真实窗口行为未在无头会话验证 |
| autosave_write / list / read / clear | 崩溃恢复草稿（dataRoot/temp/autosave，≤32MB，原子 rename，安全 docId） | Rust 单测：写/列/读/清、非法 docId 文件名安全化 |
| read_sidecar_lyrics | 读取同名 .lrc/.LRC，返回 base64 + 字节数 | Rust 单测：base64 编码、命中 .lrc、缺失返回 not found |
| reveal_midi | 在资源管理器中定位曲库文件；根外/缺失回退 midi 目录 | Rust 单测：空路径回退；实际打开资源管理器不在无头会话触发 |
| copy_asset | 复制分轨导出资产（自动建父目录） | Rust 单测：复制字节一致、源缺失报错 |
| project_save / project_open | .fufumidi ZIP（project.json + files/），对话框/指定路径；开包校验条目数/总大小/路径穿越/资产白名单 | Rust 单测：写包→读包、资产字节一致、非法资产 id 计入 missing；缓存目录隔离；恶意包 ../evil.txt 不产生 resolved |
| storage_report / storage_cleanup | 存储治理：10 类占用（曲库 protected、资产显式 includeAssets、日志保留 5 份） | Rust 单测：分类/总字节、默认只清 safe、资产需显式、midi 永不清 |
| audio_duration | 读文件头取时长：WAV RIFF/fmt/data、FLAC STREAMINFO、MP3 逐帧扫描、M4A/MP4 mvhd、OGG Vorbis/Opus 页 granule、AIFF/AIFC COMM；其他格式 unsupported | Rust 单测：1s WAV/FLAC/M4A/OGG/AIFF、100 帧 MP3（约 2.61s）、坏文件 false |
| export_audio | 渲染端字节落盘：文件名清洗、原子写、sidecar manifest（SHA-256/格式/采样率/时长/ISO createdAt），支持 targetPath 或保存对话框 | Rust 单测：字节落盘、manifest sha256/采样率/ISO 时间、非法名清洗、空字节拒绝 |
| export_stems_zip | 分轨 ZIP 打包（≤100 轨、总 ≤2GB、文件名清洗、targetPath 或保存对话框） | Rust 单测：两轨 ZIP 条目/字节、非法名清洗、空列表拒绝 |
| pick_cover | 选图片→data URL（png/jpeg/webp/bmp，≤6MB） | Rust 单测：jpeg MIME/base64、gif 拒绝、>6MB 拒绝；真实对话框不在无头会话触发 |
| export_dawproject | DAWproject ZIP（project.xml/metadata.xml，≤200 文件，拒绝路径穿越，对话框或 filePath） | Rust 单测：两文件 ZIP 内容、../ 条目跳过、空列表拒绝 |
| autostart_get / autostart_set | 通过 HKCU Run 注册项查询/设置开机自启 | Rust 单测：当前 exe 值加引号、查询返回布尔；**设置会写注册表，测试不调用** |
| diag_health | 调用 engine/health.py --json，解析脱敏体检报告（兼容 ###RESULT 信封） | Rust 单测：###RESULT/纯 JSON/噪声尾行/空输出；另有 ignored 真机冒烟（实测 5.64s 通过） |
| pick_model_archive / model_import_local | 选本地模型 ZIP→安全解压→识别 MuScriptor/Aria-AMT/钢琴模型→复制到 models/<dest>；7z/tar 明确报错 | Rust 单测：ZIP 导入落盘、识别 muscriptor/small、7z 拒绝 |
| clear_user_data | 按 scope 清除 models/soundfonts/deps（GPU/缓存）/playdata；**MIDI、设置、歌单永不清** | Rust 单测（临时目录）：单 scope/多 scope、needRestart、MIDI/settings 保留 |
| check_integrity / repair_integrity | 检查 settings 缺失/损坏；修复前备份并写回默认（presets/asar 校验不适用 Tauri） | Rust 单测：缺失/损坏/修复/备份/恢复后 ok；并修正桥参数从 {req:{ids}} 为 {ids} |
| write_midi / write_binary | 曲库真实 .mid 落盘（同名复用/重名 (2)/prev 路径安全）；任意二进制写盘 | Rust 单测：落盘/相同内容复用/不同内容重名、二进制写盘；修复曲目自检写不了文件的问题 |
| usermeta_list / set / remove / reorder / pin | 资源中心用户元数据（name/author/source/category/tags/order/pinned），dataRoot/usermeta.json，损坏先另存 .corrupt-* | Rust 单测：合并/标签去重/排序/取消 pin/删除/损坏备份 |
| save_binary（修复） | 原先只认 `{path,bytes}`，前端实际传 `{name,data}` → 保存 MIDI/壁纸导出失败；现支持原生保存对话框 + data/bytes 两种字节 | Rust 单测：data/bytes/空值解析；真实对话框不在无头触发 |
| wallpaper_list / add_local / remove_local / scan_folder | 本地动态壁纸（Electron legacy wallpapers/，.ok 标记、mp4/webm/mov、删除校验 basename）；扫描文件夹（图片/视频，深度 3、≤600） | Rust 单测：添加/列表/删除、../ 拒绝、扫描过滤 txt/空文件 |
| file_assoc | MIDI 文件关联开关：HKCU .mid/.midi → FuFumidi.MIDI，图标用 build/icon.ico（开发）或 exe | Rust 单测：开/关注册表命令计划；**测试不写注册表** |
| gpu_status / gpu_uninstall | 读取 dataRoot/gpu-enhancements 下 cuda/rocm/xpu；返回当前 Python、rocm 是否需 3.12；卸载删除对应目录 | Rust 单测（临时目录）：识别 cuda、卸载删除、非法类型拒绝；真实 Python 版本读取在测试中执行 |
| wallpaper_set_desktop | 静态图片设为桌面：HKCU Desktop Wallpaper/WallpaperStyle/TileWallpaper + `rundll32 user32.dll,UpdatePerUserSystemParameters` | Rust 单测：注册表命令计划/路径；**测试不改真实桌面** |
| plugins_list / rescan / set_enabled / open_dir | 调 engine/plugin_render.py list（--dir 来自 settings/env），按 settings.plugins_enabled 标 enabled；开关写 settings；打开插件目录 | Rust 单测：输出解析/启用映射、设置写入；真实 Python 插件列表未在测试中跑（手工无窗口跑过返回空列表） |
| utau_list_voicebanks / voicebank_unified | 只读扫描 dataRoot/voicebanks（一层、三标记、character.yaml/txt 显示名）与 diffsinger-voicebanks（dsconfig 根/下一层、递归 size）；两侧独立容错 | Rust 单测：名称优先级/BOM/UTF-8 lossy/一层/缺根/dsconfig 根与一层/size/counts；dir_size 不再跟随 symlink（全仓生效） |
| utau_export_voicebank | 把 files[{name,data(base64)}] 写入用户选择的已有目录；文件名清洗、空名跳过、总量 512MB 上限 | Rust 单测：写入/空名/traversal 清洗/目录不存在 |
| utau_import_voicebank_zip | 原生选 zip → 临时解压（拒绝 ../绝对路径/entries>20000/解压>4GB）→ 找声库根（character/oto）→ 移到 voicebanks/<zip名>，重名加 _2；裸 oto 包补 character 文件 | Rust 单测：嵌套/重名/traversal/裸 oto/无 bank；不测原生对话框 |
| utau_read_oto / utau_save_oto | 读/写 voicebanks/<声库>/oto.ini：原始字节 base64、size/mtime；写前复制到同一个 oto.ini.bak（只保留上一代）、8MB 上限、空内容拒绝；限制在 dataRoot/voicebanks 内 | Rust 单测：base64 宽容/往返、CJK、缺目录/缺 oto、.bak 依次更新、空/超大/根外拒绝 |
| utau_delete_voicebank | 删除 dataRoot/voicebanks 下的声库目录：canonicalize 前缀校验；拒绝根目录本身/根外/不存在 | Rust 单测：子目录删除、根/根外/空参数拒绝 |
| sf_workshop_list / import / delete / open_dir | 从 main/soundfonts.js 生成 20 条静态注册表；核对 bundled/downloaded 体积、扫描自定义 SF2/SF3；导入/删除/打开目录 | Rust 单测：20 条注册表、bundled GeneralUser builtin、自定义扫描、导入/删除；下载仍未实现 |
| probe | 复用 engine_probe 的 music2midi.py probe（桥此前调 probe 缺失命令） | 与 engine_probe 共用实现；无独立单测 |
| model_delete | 按模型 id 删除 models/<dest>（目录/文件 + .oudep/.parts/.tmp/.part 残留）；RVC 删除暂未迁移 | Rust 单测：muscriptor/small 删除、未知 id/RVC 拒绝 |
| open_edit_guide / plugins_open_docs | 把 plugins/plugin-dev.html、renderer/edit-guide.html 复制到 dataRoot/temp/FuFumidi-doc 并用默认浏览器打开；打包时 stage 到 resources/docs | Rust 单测：两个 dev 源存在；不在测试中打开浏览器 |
| refine | 调 engine/smart_midi.py refine（audio/midi/out/mode/stemBalance/窗口参数），逐行 emit engine:refine:log，解析 ###RESULT，stderr 尾部并入错误 | Rust 单测：参数拼装；真机引擎冒烟：合成 2s WAV + 2 音符 MIDI，2.32s 输出 76 字节 ###RESULT ok |
| open_folder | 打开目录（仅目录） | 实际打开资源管理器不在无头会话触发 |
| soundfont_list | 扫描 renderer/vendor/soundfonts + dataDir/soundfonts（sf2/sf3） | 开发树返回 GeneralUser.sf2 |
| dep_check | Rust 启动 Python `deps.py check`，解析 `###RESULT` 的 groups | 返回 universal/piano/aria/muscriptor/separate/transkun 6 组 |
| diag_export | 写 dataDir/diagnostics-<ts>.json（host/python/models/soundfonts/dataDir） | 文件生成，ok=true |
| notify | 通知插件未接；明确返回 delivered=false | ok=true（不伪造系统通知） |
| open_output / open_external | 校验路径/协议后调 explorer / cmd start | 非法路径/协议返回 ok=false（冒烟只测安全失败） |

### 3.2 T-118 Python 常驻 supervisor（2026-11-04）

- **P1（2026-11-04）生产路径已切到 `worker_pool::WorkerPool::with_reuse(1)`**：`WorkerState { pool, seq }`，
  `run_convert` 用池 `Lease` 取/还 worker；cap 固定 1（不接 `__slots` 并发）；
- 真实 `ChildWorker`：stdin/stdout piped、stderr=null、Windows `CREATE_NO_WINDOW`、kill 幂等收尸、Drop 兜底；
  暖 worker 跨请求复用，EOF/读写失败 `mark_broken` 不进暖池；
- stdout 按行解析：`###LOG` → 转发 Tauri 事件 `engine:log`；`###PROG` → `engine:progress`；
  `###RESULT` 按 `_id` 匹配后返回，附带 `elapsedMs/workerSeq/logLines`；
- **取消**：`cancel(id)` 数字 id 命中池内 job 时精确取消，其余（batchN/sepN/smoke-cancel/过期数字）
  在 cap=1 下回退取消唯一在途；先置 per-job 标志再锁外 `taskkill /T /F`，阻塞读立即返回 EOF；
  没有在途任务时返回 `no running worker`，不再误杀空闲暖 worker；
- 进程退出/读写失败 → 丢弃 worker 并返回错误，**下一次请求自动重新拉起**（首请求报错，不静默重跑）；
- 退出（`RunEvent::Exit`）调 `pool.shutdown()`，取消在途并 kill 暖 worker，避免残留 Python；
- **模型/参数契约未改**：req 原样透传，模型路径/格式仍由 Python 侧决定。

实测（smoke）：1 s 440 Hz WAV → Basic Pitch 1 个音符；冷启动 14.3 s、暖 5.5 s；13 条日志；
worker running=true seq=1；输出 MIDI 头 `MThd`。**P1 实测**：cargo test **78/78 + 1 ignored**（含真实
Python 子进程 echo/取消/EOF/暖复用测试）、cargo build release 通过、`--self-check` 通过；未开窗。
**P3 子集已做**：`_id` / `engine:log` / `engine:progress` 改用前端 `cfg.id`（无 id 时 `job-<seq>`），
结果 id 同时接受字符串/数字；桥补 `onEngineProgress`；结果仍带数字 `workerSeq` 供诊断。
**P2 已做**：`WorkerPool::set_cap(1..=4)` 动态并发；`convert` 按 `__slots` 调容，
GPU 环境（未设 `FUFUMIDI_DISABLE_GPU=1`）自动 −1，`FUFUMIDI_MAX_WORKERS` 可压低；
`JobMap` 用前端 id 精确取消，cap>1 未知 id 不误杀；`engine_worker_status` 返回 cap/workers[]；
缩容只回收空闲暖 worker，在途 job 不杀。默认 `__slots` 缺省仍 cap=1（与 P1 等价）。
剩余：P3 进度节流/UI 队列绑定、队列迁移 UI；模型列表等 host 通道（T-115 扩面）。

### 3.1.1 Release 构建（T-119 第一步，2026-11-04）

- Tauri CLI 锁到 **2.12.4**（devDependency，配合 crate tauri 2.12.5）；
- `npm run tauri:release` = `build:ui` + `tauri build --no-bundle`；
  冷编译 **1m38s**，产物 **12.49 MB**（`poc/tauri-poc/target/release/fufumidi-shell.exe`）；
- **Release 壳冒烟 24/24 全绿**（`node scripts/tauri/smoke.mjs --exe <release>`）：
  真实 UI、Python 3.12.10、worker、真实转录（1 s WAV → 1 音符，7.9 s）、曲库/预设/取消/暂停全通过；
- `npm run tauri:bundle` 已留出入口，但 **bundle 仍未启用**：需要配置
  `bundle.resources`（resources/python、engine、soundfonts、models 随包/按需）并接 NSIS；
  安装版与 Electron 回退属于 T-119 剩余工作。

### 3.2.1 关键修复：Tauri 桥注入时序 + 嵌入 renderer 的重建（2026-11-04）

- **桥注入时序**：`api.ts` 原本用 `const bridge = window.fuBridge` 在模块求值时捕获；
  Tauri 的 `__TAURI_INTERNALS__` 可能晚于 store 模块就绪，导致 `api.bridge` 永久 undefined
  （曲库/设置读不到，界面显示 0 首）。修法：`api.bridge` 改为 **live binding** +
  `refreshBridge()`；`bridge/install.ts` 作为 main.ts 第一个 import 先装桥，main.ts 再刷新一次。
- **Tauri 会把 renderer/dist 嵌入 exe**：只跑 `npm run build:ui` 不会更新壳。
  新增 `npm run tauri:build`（build:ui + cargo build），避免"前端改了、Tauri 里还是旧的"。
- 修复后 smoke 实测：`apiBridgeReady=true / apiBridgeKeys=71`、`restoreBridgeKeys=71`、
  `storeSongs=1`、页面出现 `Smoke UI Song`、曲库显示 **1 首**、首页"继续上次的工作"出现该曲。

### 3.2.2 真实老用户数据接入（T-117，2026-11-04）

- `rusqlite`（bundled SQLite）直读/写 Electron 的 `%APPDATA%/FuFumidi/fufumidi/fufumidi.sqlite`：
  songs / playlists / kv；无覆盖时自动共享，设置了 `FUFUMIDI_DATA_ROOT` 时改用独立库（测试隔离）；
- 设置文件同样优先 legacy `%APPDATA%/FuFumidi/fufumidi/settings.json`（57 键实测读取）；
- 只读验收脚本 `node scripts/tauri/legacy-data-check.mjs`（不设 data root）：
  真实库 **1972 首**、首曲 `Bad Apple!!.mid`、主题 fufu、侧栏「全部曲目 1972」正常渲染；
  截图 `shells/tauri/artifacts/legacy-library.png`；
- 双构建并存风险：Tauri 与 Electron 同时运行会争用同一 sqlite；当前约定是**同一时间只开一个壳**，
  后续若需并行会加只读副本/文件锁。

### 3.3 曲库 SQLite + UI 路由冒烟（2026-11-04）

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

**原生对话框实弹验收**：`node scripts/tauri/dialog-check.mjs`（打开真实系统对话框 → 发 Esc →
断言 `pick_file` Promise 解析 null；截图 `shells/tauri/artifacts/dialog-cancel.png`）。

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

- 断言 **25 项全绿**：host / engineProbe / convert / worker / pause / cancel / presets / dbSongs / dbPlaylists /
  soundfonts / depCheck / diagExport / safeShellOps / modelList / version / python / settings / kv /
  listMidi / readBinary / saveBinary / ui / uiRoutes / uiLibrary；
  `uiLibrary` = 写入曲库 → 真刷新 → 侧栏/首页出现该曲（storeSongs=1，曲库 1 首）；
- UI 断言：title、#app 已挂载、`window.fuBridge` 与 `window.__TAURI__` 均为 object、正文 >200 字；
- 实测输出：version 6.5.0-beta.1、Python 3.12.10、settings 42 往返、MIDI 头 `MThd`、字节 4 往返；
- 截图：`shells/tauri/artifacts/smoke.png`（真实 UI）。

### 3.4b 更新线路（本地，2026-11-04）

- 新增 `update_sources` / `update_set_preferred_source` 两条命令：
  - stable/beta 通道 id 后缀、国内/全球优先顺序与 Electron `main/update.js` 一致；
  - 首选线路只把该条提到最前，**不硬绑定**；
  - 只读 settings 的 `download_source`/`update_preferred_source`，**绝不写 settings**；
  - 会话首选存 `UpdatePreferredState` 内存，不落盘；
- `build/kachina.config.json` 的 10 个 source id 由 Rust 单测校验；
- **6 项单测全过**；本批不联网、不检查版本、不下载更新包。

### 3.5 NSIS 安装包（T-119，2026-11-04）

- `npm run tauri:bundle` 成功产出 **237.81 MiB** 安装包；安装后 **814 MB**，资源在安装根目录
  （python/engine/soundfonts/models）；
- **安装版 smoke 24/24 全绿**，主程序 **FuFumidi.exe**，host_info 证实 python/engine 来自安装目录，
  renderer 为 `<embedded>`，真实转录 **5.3 s**；详见 `docs/rust/TAURI-BUILD.md`；
- 限制：安装包未签名；Electron 回退基准为 E2E 35/35 + `pack:base` 成功（未重打 Electron 安装包）。

## 3.6 IPC 覆盖（静态统计，2026-11-04）

- `npm run tauri:coverage` / `node scripts/tauri/ipc-coverage.mjs --write`：
  只解析 preload 与 Tauri 桥的方法名，不启动窗口；
- 当前：preload 265 方法 / Tauri **144** 方法 / **122 未映射**；preload invoke 250 / tauri call **138**；
- 缺口分类：设置杂项 28、diffsinger 19、utau/voicebank 18、模型/安装 14、导出/渲染 14、
  资源/音频 13、rvc 12、曲库/数据 11、文件/诊断 11、事件/窗口 10、GPU 8、更新/测速 6、其他 4；
- 明细见 [IPC-COVERAGE.md](IPC-COVERAGE.md)。
- 前端实际调用审计：`npm run tauri:call-audit`（`docs/rust/BRIDGE-CALLS.md`），
  当前 212 个去重调用 / 104 未找到实现（启发式，含动态调用误报）。
- 参数契约审计：`npm run tauri:arg-audit`（`docs/rust/ARG-AUDIT.md`），当前 122 命令 / 23 不一致
  （主要来自尚未实现的 bridge 命令）；已修正 readSidecarLyrics/modelImportLocal/renameMidi/
  projectOpen/autosaveRead/autosaveClear 的 JS camelCase→Rust snake_case 参数错配。

## 4. 当前命令清单（122 条）

host_info, app_version, ping, python_selfcheck, engine_probe, convert, engine_worker_status,
load_settings, save_settings, update_sources, update_set_preferred_source, utau_list_voicebanks, voicebank_unified, utau_read_oto, utau_save_oto, utau_delete_voicebank, utau_import_voicebank_zip, utau_export_voicebank, db_kv_get, db_kv_set, db_status, db_songs_list, db_songs_put,
db_songs_delete, db_playlists_list, db_playlists_put, model_list, list_midi_files, read_binary,
save_binary, soundfont_list, dep_check, diag_export, notify, open_output, open_external, cancel,
presets_list, presets_save, presets_delete, presets_last_used, presets_set_model,
presets_reorder, presets_reorder_to, presets_restore, set_transcribe_pause,
pick_file, pick_directory, pick_audio, pick_audio_files, pick_image, pick_music_xml, check_midi,
wallpaper_defaults, delete_midi, rename_midi, list_audio_files, library_stats, read_soundfont,
db_playlists_delete, data_root, open_data_root, clean_temp, has_midi, verify_midi, dupe_midi,
get_zoom_factor, set_zoom_factor, set_full_screen, autosave_write, autosave_list, autosave_read, autosave_clear,
read_sidecar_lyrics, reveal_midi, copy_asset, open_folder, project_save, project_open,
storage_report, storage_cleanup, audio_duration, export_audio, export_stems_zip, pick_cover, export_dawproject,
autostart_get, autostart_set, diag_health, pick_model_archive, model_import_local, clear_user_data,
check_integrity, repair_integrity, write_midi, write_binary, usermeta_list, usermeta_set, usermeta_remove, usermeta_reorder, usermeta_pin,
wallpaper_list, wallpaper_add_local, wallpaper_remove_local, wallpaper_scan_folder, file_assoc,
gpu_status, gpu_uninstall, wallpaper_set_desktop, plugins_list, plugins_rescan, plugins_set_enabled, plugins_open_dir,
sf_workshop_list, sf_workshop_import, sf_workshop_delete, sf_workshop_open_dir, probe, model_delete, open_edit_guide, plugins_open_docs, refine。

## 4.1 下一步

1. **T-115 IPC 纵切**：从 ipc.schema.json 生成 10 条真实 command + 桥映射（含事件退订），
   替换 `frontend/src/bridge/tauri.js` 中的手写映射。
2. **T-118 Python sidecar supervisor**：Rust 启动/监控 Python，转发 `convert/separate` 等推理请求；
   模型路径/参数契约不变。
3. **T-117 host 业务迁移**：文件/设置/曲库/任务队列先迁，保持 IPC 语义与双跑回归。
4. T-118 剩余：cancel/pause、批量并发、UI 队列侧进度绑定、崩溃重启策略（当前是"下次请求重新拉起"）；
5. T-119 双构建 + Electron 回退；**T-114 品牌校验（Tauri 部分）已完成**：
   `shells/tauri/icons/icon.ico` 与 `build/icon.ico` 字节一致，`npm run check:brand` 增加 equality 断言。

## 5. 风险与约束

- 现有 172 条 IPC 缺口仍在本壳上存在：UI 能渲染 ≠ 所有操作可用；必须逐条迁移并以 E2E 覆盖。
- 更新链仍要自研（官方插件无增量、验签不兼容）。
- Python 保留意味着包体不会降到 ≤250 MiB；本阶段只追求「Electron 被 Tauri 替代 + 非 ML Rust 化」。
- **模型兼容是硬约束**：不得改模型格式/ID/路径/下载源；迁移只换宿主，不换推理。
