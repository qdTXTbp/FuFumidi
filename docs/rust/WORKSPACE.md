# Rust Workspace（crates/ · M0/M1 运行时轨道）

- 状态：M1 骨架完成（2026-11-03）
- workspace 版本：0.3.0
- 范围：只新增 crates/**、scripts/rust/**、docs/rust/**；未改 main/、frontend/、engine/，未删除任何现有文件，未执行 git commit。
- 旧 rust-core/ 原样保留，仍可用 scripts/build-rust.ps1 独立构建。

## 1. 为什么 workspace 根在 crates/

本阶段允许改动的目录只有 crates/**、scripts/rust/**、docs/rust/**，因此没有在仓库根新增 Cargo.toml，而是把
Cargo workspace 的虚拟清单放在 crates/Cargo.toml：

- 仓库根不被碰，根目录也没有既有 Cargo.toml 需要合并；
- 既有 rust-core/ 保持独立包，旧构建脚本与 npm run build:rust-core 不被打断；
- 与整合方案「新目录 crates/（workspace）」的落点一致；
- 将来若要把 workspace 上移到仓库根，只需新增根 Cargo.toml 并保留两个 members，crate 内部无需改动。

crates/Cargo.lock 已生成并保留（仓库约定 lockfile 入库）。crates/.gitignore 只忽略本 workspace 的 target/。

## 2. crate 划分与目录

```text
crates/
  Cargo.toml                     # 虚拟 workspace（members + 统一版本/依赖/发布配置）
  Cargo.lock
  .gitignore
  fufumidi-core/                 # 领域核心（lib，零第三方依赖）
    src/lib.rs                   #   公共导出
    src/error.rs                 #   Error / Result（可匹配的枚举）
    src/vlq.rs                   #   read_vlq / write_vlq
    src/smf.rs                   #   SmfFile / SmfTrack / Event / EventKind / encode_smf
    src/parse.rs                 #   parse_smf（含 running status）
    src/stats.rs                 #   analyze_smf / analyze_file / MidiStats
    src/transform.rs             #   quantize / transpose 写回
    tests/                       #   代码生成 SMF 字节的集成测试
  fufumidi-engine/               # sidecar 二进制 + 命令层（bin + lib）
    src/lib.rs                   #   常量：SERVICE / ENGINE / VERSION / CAPABILITIES
    src/main.rs                  #   进程入口（ExitCode）
    src/cli.rs                   #   旧 CLI 分派 + --json-lines 选择
    src/commands.rs              #   七条命令的实现（返回 serde_json::Value）
    src/batch.rs                 #   目录遍历、SHA-256、批量写回
    src/protocol.rs              #   JSON 行协议：解析、###RESULT、exit、ready
    tests/                       #   CLI 与协议端到端测试
```

| crate | 职责 | 依赖 |
|---|---|---|
| fufumidi-core | SMF 数据模型、解析/编码、统计、量化/移调；纯字节进、字节出，不碰文件系统 | 无 |
| fufumidi-engine | 与旧 rust-core 兼容的一次性 CLI；JSON 行 sidecar 协议骨架；批量命令 | fufumidi-core、serde_json、sha2 |

任务允许的 fufumidi-cli 没有单列：命令分派、参数默认值与输出格式都并入 fufumidi-engine，减少一个需要打包的二进制。

## 3. 核心库 API

| API | 说明 |
|---|---|
| `parse_smf(&[u8]) -> Result<SmfFile>` | 解析 SMF，支持 format 0/1/2、多轨、running status、meta、SysEx、1 字节通道事件 |
| `encode_smf(&SmfFile) -> Vec<u8>` / `SmfFile::to_bytes()` | 写回 SMF；事件按当前顺序写出，delta 由绝对 tick 计算 |
| `read_vlq(&[u8], &mut usize) -> Result<u32>` / `write_vlq(&mut Vec<u8>, u32)` | VLQ 读写；读写都覆盖 u32 全范围，读取拒绝 6 字节序列与溢出 |
| `analyze_smf(&[u8]) -> Result<MidiStats>` / `analyze_file(&SmfFile)` | 轨道数、成对音符数、BPM、音域、平均力度、平均时值 |
| `quantize_smf(&[u8], u32) -> Result<Vec<u8>>` | 量化后写回字节 |
| `transpose_smf(&[u8], i32) -> Result<Vec<u8>>` | 移调后写回字节 |
| `transform_smf(&[u8], Transform)` / `apply_transform(&mut SmfFile, Transform)` | 统一变换入口（就地或字节级） |
| `quantize_tick(u32, u32) -> u32` / `Transform::grid_ticks(u16)` | 网格计算 |
| `SmfFile / SmfTrack / Event / EventKind / SysExKind / MidiStats / Transform / Error` | 公共数据模型与错误枚举 |

行为约定（与旧 rust-core 对齐）：

- running status 在解析阶段展开成完整状态；写出时不生成 running status。
- 0xC0 / 0xD0 按 1 个数据字节解析，其余通道事件 2 个数据字节。
- 元事件与 SysEx 保留负载；写出时长度前缀使用实际负载长度。
- 旧实现遇到损坏事件可能继续读或 panic；新实现返回 Error（Truncated / UnexpectedStatus / InvalidVlq 等），只影响非法文件。
- 统计：note-on 起音；note-off 或 velocity=0 的 note-on 收尾；未配对的 note-off 忽略；tempo 取遍历到的最后一个 0x51 事件。
- 量化：网格 = ticks_per_beat * 4 / divisions（divisions 至少 1）；只移动 note-on 起点，note-off 保持相对时值。
- 移调：note-on / note-off 同时移调，音高钳制 0-127；其他事件不变。
- 两种变换结束后每条轨道按 tick 稳定排序。

## 4. 构建

前置：Rust 1.74+（本机实测 1.97.1）。Windows 下推荐 x86_64-pc-windows-gnu（与旧 rust-core 构建方式一致，不依赖 MSVC linker）：

```powershell
cd E:\Midi\FuFumidi-Source
$env:CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = 'gcc'
cargo build --manifest-path crates/Cargo.toml --release --target x86_64-pc-windows-gnu
```

使用脚本（默认自动探测：有 gcc 时走 GNU target，否则走宿主默认 target）：

```powershell
# 构建 release，并安装到 resources/rust-core/（默认）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/rust/build.ps1

# 只构建，不复制到 resources/（验证 / CI 用）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/rust/build.ps1 -NoInstall

# 其它配置
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/rust/build.ps1 -Profile debug
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/rust/build.ps1 -Target x86_64-pc-windows-msvc
```

build.ps1 行为：

- 解析仓库根为 scripts/rust/../..，只操作 crates/ workspace；不会碰旧 rust-core/。
- GNU target 自动设置 `CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=gcc`；设 `FUFUMIDI_RUST_GNU=0` 可回退宿主默认 target。
- 构建成功后打印产物绝对路径与 KB 大小。
- 未加 -NoInstall 时，把同一份字节复制成两个文件名（见第 8 节）：
  resources/rust-core/fufumidi-engine.exe（正式 sidecar 名）与
  resources/rust-core/fufumidi-core.exe（main/rust.js 兼容别名）。
- 两个 .ps1 都是 UTF-8 with BOM + CRLF（Windows PowerShell 5.1 读中文注释所必需）。

## 5. 测试

```powershell
cd E:\Midi\FuFumidi-Source
$env:CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = 'gcc'
cargo test --manifest-path crates/Cargo.toml --target x86_64-pc-windows-gnu

# 全量门禁：test -> fmt --check -> clippy（clippy 只拦错误，警告可容忍）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/rust/test.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/rust/test.ps1 -SkipFmt -SkipClippy
```

test.ps1 在未安装 rustfmt / clippy 时只给警告并跳过对应步骤；本次验收已用
`rustup component add rustfmt clippy` 安装组件。

当前测试套件共 64 个测试，全部通过：

| 目标 | 数量 | 覆盖 |
|---|---:|---|
| fufumidi-core / smf_parse.rs | 16 | 最小文件、format 1 多轨、running status、1/2 字节事件、编码往返、扩展头、非 MIDI、SMPTE、division=0、无轨、缺状态、非法状态、截断、VLQ 边界/溢出 |
| fufumidi-core / smf_contract.rs | 8 | 对外 API 契约与 round-trip 稳定性 |
| fufumidi-core / stats.rs | 6 | 多轨统计、BPM、音域、平均力度/时值、vel=0、无配对音符、孤儿 note-off |
| fufumidi-core / transform.rs | 8 | 量化起点/时值、取整、running status、移调、钳制、meta/SysEx 保留、错误输入、divisions=0 |
| fufumidi-engine / cli_tests.rs | 19 | 七条命令、默认参数、目录批处理、SHA-256、单行 JSON、进程级 CLI/协议 |
| fufumidi-engine / protocol_contract.rs | 7 | ###RESULT 分帧、id 回填、argv 形式、错误与 exit |
| 单元测试 / doc tests | 0 | 逻辑集中在库与集成测试 |

测试里的 SMF 字节全部由代码现场构造（tests/common/mod.rs 与 cli_tests.rs 内置构造器），
不依赖二进制 fixture；覆盖 running status、format 1 多轨、tempo、note on/off、program change、
pitch bend、SysEx 与各类错误输入。

## 6. CLI（与旧 rust-core 兼容）

| 命令 | 参数 | 默认值 | 输出 |
|---|---|---|---|
| `ping` | — | — | `{"ok":true,"service":"fufumidi-core","version":"0.3.0"}` |
| `version` | — | — | `{"ok":true,"version":"0.3.0"}` |
| `midi-stats` | `<file>` | 空路径（报错） | format / tracks / notes / bpm / min_midi / max_midi / avg_vel / avg_dur_ticks |
| `batch-stats` | `<dir>` | 空目录 | `{"ok":true,"count":N,"files":[...]}` |
| `hash-batch` | `<dir>` | 空目录 | 每文件 SHA-256 小写 hex + size |
| `quantize-batch` | `<dir> <out-dir> [divisions]` | divisions=8 | mode/arg/count/files；逐文件 ok/out 或 error |
| `transpose-batch` | `<dir> <out-dir> [semitones]` | semitones=12 | 同上 |
| `help` / `--help` / `-h` | — | — | 用法 JSON |
| `--version` / `-V` | — | — | 同 version |

实际输出示例：

```text
> fufumidi-engine.exe ping
{"ok":true,"service":"fufumidi-core","version":"0.3.0"}

> fufumidi-engine.exe version
{"ok":true,"version":"0.3.0"}

> fufumidi-engine.exe midi-stats E:\tmp\a.mid
{"ok":true,"format":1,"tracks":2,"notes":2,"bpm":120.0,"min_midi":60,"max_midi":64,"avg_vel":90.0,"avg_dur_ticks":360.0}

> fufumidi-engine.exe nope
{"error":"unknown command","ok":false}
```

兼容细节：

- batch-stats 成功行不带 ok 字段（main/library.js 用 `f.ok !== false` 判断），失败行带 `ok:false,error,size`；
  与旧 CLI 一致，读不出来的文件也会出现在结果里。
- hash-batch 与 JS 侧 crypto.createHash('sha256') 一致（小写 64 位 hex），去重分组不受 Rust 是否可用影响。
- 目录扫描只收 .mid/.midi（batch-stats / 批量变换）或 .mid/.midi/.sf2/.sf3/.wav/.mp3/.flac（hash-batch），
  递归、扩展名大小写不敏感、按小写路径排序，均沿用旧实现。
- 命令级失败（文件不存在、格式错误、未知命令）仍输出合法 JSON 并以 0 退出（旧 CLI 行为）；只有 stdout 写入失败返回 1。

## 7. JSON 行 sidecar 协议（骨架）

启动方式（四个别名等价）：`--json-lines`、`--stdin`、`json-lines`、`serve`。

请求：stdin 每行一个 JSON 对象。

```json
{"id":1,"cmd":"midi-stats","args":["E:/tmp/a.mid"]}
```

也接受旧 engine_server 风格：

```json
{"id":2,"argv":["version"]}
```

响应：每行以 `###RESULT ` 开头，后接一个 JSON 对象；id 原样回填。

```text
###RESULT {"id":1,"ok":true,"format":1,"tracks":2,"notes":2,...}
###RESULT {"id":2,"ok":true,"version":"0.3.0"}
```

规则：

- 空行忽略；每行独立处理；每条响应后立即 flush（长驻会话不会攒批）。
- `id` 可省略或为任意 JSON 值；省略时回填 null。
- `args` 必须是数组；元素可为 string / number / bool / null，数字保留十进制文本。`argv` 形式等价。
- 坏 JSON 返回 `{"id":null,"ok":false,"error":"invalid json: ..."}`，不退出进程。
- 缺 cmd 返回 `missing cmd`；未知命令返回 `{"id":N,"ok":false,"error":"unknown command","cmd":"..."}`。
- `{"cmd":"exit"}` 先回一条 `{"exiting":true}`，再退出进程（返回码 0）。
- `{"cmd":"ready"}` 返回 `service=fufumidi-engine`、`version`、`capabilities` 与 `compatible_service=fufumidi-core`，
  供后续主进程做握手/健康检查。
- 目前只发 ###RESULT；###PROG / ###LOG / 主动 ###READY 属于后续阶段，槽位已按主进程现有解析器保留。
- 当前为单线程顺序处理，没有 job 注册表、取消、暂停与进度节流。

实际会话示例：

```text
$ printf '%s\n' '{"id":1,"cmd":"ping","args":[]}' '{"id":2,"cmd":"ready"}' '{"id":3,"cmd":"exit"}' | fufumidi-engine.exe --json-lines
###RESULT {"id":1,"ok":true,"service":"fufumidi-core","version":"0.3.0"}
###RESULT {"capabilities":["ping","version","ready","midi-stats","batch-stats","hash-batch","quantize-batch","transpose-batch"],"compatible_service":"fufumidi-core","id":2,"ok":true,"service":"fufumidi-engine","version":"0.3.0"}
###RESULT {"exiting":true,"id":3,"ok":true}
```

## 8. 与主进程 main/rust.js 的兼容

main/rust.js 的现状（未改动）：

- 二进制名固定为 fufumidi-core.exe（非 Windows 为 fufumidi-core），按以下候选顺序查找：
  resources/rust-core/、resources/bin/、app/rust-core/、../resources/rust-core/、<main>/../resources/rust-core/。
- `invoke(args)` 以 `[cmd, ...args]` spawn 子进程，把 stdout 整体 JSON.parse；`probe()` 用 ping 的 `ok/service/version` 缓存结果。
- `library:verify` 消费 batch-stats 的 file/format/tracks/notes/bpm/min_midi/max_midi/avg_vel/size
  与 ok/error；`library:dupes` 消费 hash-batch 的 file/hash/size。

因此本 workspace 的兼容策略是：

- ping 的 `service` 仍为 `fufumidi-core`（不是 fufumidi-engine），version 升级为 0.3.0；
  探测逻辑只要求 ok=true，不比较版本，UI 无需改。
- 七条命令的名称、参数顺序、默认值、字段名与扫描规则保持旧 CLI 不变。
- build.ps1 安装时写两个文件名，字节完全相同：
  - resources/rust-core/fufumidi-engine.exe：后续 sidecar 的正式名；
  - resources/rust-core/fufumidi-core.exe：旧 main/rust.js 自动发现的兼容名。
  这样不修改 main/ 即可无缝替换旧二进制；是否启用 fufumidi-engine.exe 由后续主进程改造决定。
- 回滚：resources/rust-core/ 下的旧 fufumidi-core.exe 在首次不带 -NoInstall 运行 build.ps1 时会被覆盖；
  需要保留时先备份，或继续用旧的 scripts/build-rust.ps1 重建旧 rust-core/。

已知差异（均不影响现有调用方）：

- JSON 键按 serde_json 的 BTreeMap 字母序输出，旧实现是手写顺序；数值由固定小数位变成 JSON 规范形式（120.0 而非 120.00）。
- 错误文案更具体（unexpected status 0xNN、truncated ...）；旧实现是笼统字符串。
- 非法 meta/SysEx 的声明长度会被规范成实际负载长度（合法文件字节不变）。
- 旧 CLI 的 `write_vlq` 允许的 4 字节 delta 上限不变；新读取器额外拒绝 6 字节 VLQ 与溢出。

尚未接线（下一步）：

- package.json 的 `build:rust-core` 仍指向旧 scripts/build-rust.ps1 与 rust-core/；本阶段未改。
- electron-builder 的 extraResources 仍只打包 resources/rust-core/ 里已有文件；安装后两个文件名都会在。
- 常驻会话（main/engine.js 的 createEngineSession）、job 注册表、取消/暂停、probe/deps 尚未接 Rust。

## 9. 产物与大小

| 配置 | 路径 | 大小 |
|---|---|---:|
| release（LTO + strip + opt-level=s） | crates/target/x86_64-pc-windows-gnu/release/fufumidi-engine.exe | 400,384 字节（391 KB） |
| debug（仅测试用） | crates/target/x86_64-pc-windows-gnu/debug/fufumidi-engine.exe | 10,255,615 字节（约 9.8 MiB） |

- release 大小与旧 rust-core 的 351,232 字节同一量级，满足「sidecar 随包分发」的预算。
- 本任务验收只执行了 build.ps1 -NoInstall，未覆盖 resources/rust-core/ 的旧二进制（遵守只改白名单目录的约束）。
- 正式安装后：resources/rust-core/fufumidi-engine.exe 与 fufumidi-core.exe 各约 391 KB。

## 10. 验收记录

- `cargo test --manifest-path crates/Cargo.toml --target x86_64-pc-windows-gnu`：64 passed，0 failed。
- `cargo fmt --all -- --check`：clean。
- `cargo clippy --all-targets -- -D warnings`：clean（本会话安装了 rustfmt/clippy 组件）。
- scripts/rust/build.ps1 -NoInstall：release 构建成功。
- scripts/rust/test.ps1：test + fmt + clippy 全过。
- 变更范围：git status 只显示 crates/、scripts/rust/、docs/rust/ 三个新增目录，未触碰其它目录。

## 11. 已知限制与后续工作

- 这是 M1 骨架：只有一次性 CLI 与同步 JSON 行协议；没有 job 注册表、取消/暂停、进度、`###PROG`/`###LOG`、主动 `###READY`、probe/deps/bench。
- 协议逐行同步处理，没有并发与单行长度上限；stdout 只写 ###RESULT，日志暂未接入 stderr。
- 领域层只覆盖 SMF；MusicXML/MXL→MIDI、SF2/SF3 合并、ustx 互转、MIDI 编辑/合并/人性化尚未开始。
- SMPTE 时间基准与旧实现一样不支持（报错）。
- 没有 tempo map：统计只取最后一个 tempo 事件；量化/移调不感知调号/拍号。
- 音符配对按轨道内 (channel, note) 先进先出；跨轨配对与同音重叠的复杂语义沿用旧实现。
- 写出会规范化 running status（展开）、meta/SysEx 声明长度与 pitch bend 的 14 位掩码；只对非法文件产生字节差异。
- CLI 命令级失败仍退出 0（旧兼容行为），需要脚本按 JSON 的 ok 字段判断。
- 本机只验证了 x86_64-pc-windows-gnu；MSVC target 的脚本路径存在但未实测（本机无 MSVC linker 环境）。
- 新 crate 尚未接入 npm/electron-builder/主进程会话；下一步是把 build.ps1 接进 build:rust-core，并在 main/engine.js 增加 sidecar 会话。

## 12. 新增文件清单

```text
crates/Cargo.toml
crates/Cargo.lock
crates/.gitignore
crates/fufumidi-core/Cargo.toml
crates/fufumidi-core/src/lib.rs
crates/fufumidi-core/src/error.rs
crates/fufumidi-core/src/vlq.rs
crates/fufumidi-core/src/smf.rs
crates/fufumidi-core/src/parse.rs
crates/fufumidi-core/src/stats.rs
crates/fufumidi-core/src/transform.rs
crates/fufumidi-core/tests/common/mod.rs
crates/fufumidi-core/tests/smf_parse.rs
crates/fufumidi-core/tests/smf_contract.rs
crates/fufumidi-core/tests/stats.rs
crates/fufumidi-core/tests/transform.rs
crates/fufumidi-engine/Cargo.toml
crates/fufumidi-engine/src/lib.rs
crates/fufumidi-engine/src/main.rs
crates/fufumidi-engine/src/cli.rs
crates/fufumidi-engine/src/commands.rs
crates/fufumidi-engine/src/batch.rs
crates/fufumidi-engine/src/protocol.rs
crates/fufumidi-engine/tests/cli_tests.rs
crates/fufumidi-engine/tests/protocol_contract.rs
scripts/rust/build.ps1
scripts/rust/test.ps1
docs/rust/WORKSPACE.md
```