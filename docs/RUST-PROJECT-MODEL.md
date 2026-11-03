# 工程模型 v2（Rust 与前端共用契约）

> 状态：**M0 冻结稿**（2026-11-03）
> 归属：本文件是「专业化升级」与「全 Rust 重写」共用的数据模型规范。冻结后只增不删；破坏性变更必须走 ADR + 迁移脚本。
> 关联：[整合总方案](./plans/2026-11-03-master-integrated-plan.md)、[AI 实现规格](./plans/2026-11-03-master-ai-spec.md)、[v3 技术方案](./plans/2026-11-03-rust-fullstack-plan.md)。

## 0. 为什么先冻结

功能升级（6.7 轨道/拍号/命令式撤销、6.8 混音/调音曲线）与 Rust 引擎（core 的 Song/Timeline）
都要读写同一份工程数据。如果两边各定一套字段，后面必然返工。本文件给出：
- 唯一字段名与类型；
- 不变量（谁必须保持有序、什么可以为空）；
- 迁移规则（旧工程怎么读、新工程旧版本怎么读）；
- 所有权（短期 JS 持有、长期 Rust 持有，过渡期如何同步）。

## 1. 顶层结构

    Project
      ├─ format: "fufumidi-project"
      ├─ version: 2
      ├─ meta: { id, name, createdAt, updatedAt, appVersion, templateId? }
      ├─ song: Song
      └─ assets: AssetRef[]        // 伴奏/音频/封面等外部文件引用（不内联字节）

    Song
      ├─ tpb: 480                  // ticks per beat（现状固定 480；保留字段便于将来改）
      ├─ timeSigMap: TimeSig[]     // 拍号分段（v2 新增可编辑）
      ├─ tempoMap: Tempo[]         // 速度分段（v2 新增可编辑；至少 1 条）
      ├─ tracks: Track[]
      ├─ arrange: ArrangeState
      ├─ markers: Marker[]
      ├─ regions: Region[]
      └─ totalTicks / totalSec     // 派生值，只读；写入时重算

## 2. 时间与拍号

    TimeSig { tick: u32, num: u8, den: u8 }      // den ∈ {1,2,4,8,16,32}
    Tempo   { tick: u32, bpm: f64 }              // bpm > 0；tick 升序且首条 tick=0

不变量：
- timeSigMap / tempoMap 按 tick 严格升序，首条 tick=0，不允许重复 tick；
- 任何编辑导致总时长变化时，重算 totalTicks/totalSec 与 bars 数；
- 读取旧工程缺失这两张表时：用单条默认值补齐（4/4、120），并在 meta.migratedFrom 记录来源版本。

## 3. 轨道

    Track
      ├─ id: string                // 稳定 ID；前端对象引用不作为身份
      ├─ type: "midi" | "audio" | "bus"
      ├─ name: string
      ├─ program: u8               // MIDI program（0-127）
      ├─ isDrum: bool
      ├─ channel: u8               // 0-15（MIDI 导出/通道语义）
      ├─ muted / soloed: bool
      ├─ gainDb: f32               // 每轨增益（v2 新增；默认 0）
      ├─ pan: f32                  // -1..1（v2 新增；默认 0）
      ├─ notes: Note[]             // 按 start 严格升序（不变量）
      ├─ ccs: CcEvent[]            // 按 tick 升序
      ├─ events: ChannelEvent[]    // bend/aftertouch 等，按 tick 升序
      ├─ automation: AutomationLane[]  // v2 新增（基础音频轨/混音用；可空）
      └─ clips: Clip[]             // 仅 arrange 视图使用（见 §5）

    Note
      ├─ id: string                // v2 新增稳定 ID（编辑/撤销/跨端引用）
      ├─ start / end: u32          // end > start；tick 单位
      ├─ midi: u8                  // 0-127
      ├─ vel: u8                   // 1-127（0 视作非法，删除）
      ├─ muted: bool
      ├─ bend: f32?                // 每音符弯音（音分/半音，按现有 UI 约定）
      ├─ pitchCurve: PitchPoint[]? // v2 新增：曲线归属音符（调教页迁移用）
      └─ voice: u8?                // v2 预留声部号（0 起）

不变量：
- 同一轨 notes 必须按 start 升序（绘制二分/播放排序依赖）；插入后必须重排；
- 同一 track 上同 (channel,midi) 的 note-on/off 不允许负时长；
- 编辑必须通过命令对象（见 §6），不允许直接改内存后隐藏副作用。

## 4. 通道事件

    CcEvent      { tick: u32, ch: u8, cc: u8, cv: u8 }
    ChannelEvent { tick: u32, ch: u8, type: "bend"|"aftertouch"|"polyAftertouch", val: i32, note?: u8 }

不变量：
- CC0/CC32（音色库选择）不进入普通 CC 列表，由音色解析层处理；
- 回放侧按 tick 升序二分推进，事件必须有序。

## 5. 编排（clip）

    ArrangeState { tracks: ArrangeTrack[], markers: Marker[], regions: Region[], view: {zoom, scroll} }
    ArrangeTrack { trackId: string, height: u32, muted, soloed, clips: Clip[] }
    Clip
      ├─ id: string
      ├─ trackId: string
      ├─ startTick: u32
      ├─ lenTicks: u32
      ├─ loopCount: u16 = 1
      ├─ fadeInTicks / fadeOutTicks: u32 = 0
      ├─ gainDb: f32 = 0
      └─ source: { kind: "notes", fromTick, toTick } | { kind: "audio", assetId }

规则（v2 的核心变化）：
- **播放/导出的真源是「编排展开后的事件流」**，而不是原始 track notes；
- 展开算法必须与 Rust core 的 expand_arrangement 输出一致（双跑对拍）；
- 没有 clip 的旧工程：迁移时给每条轨生成一个覆盖全曲的 clip（行为不变）。

## 6. 撤销与命令（v2）

    EditCommand {
      id: string, label: string, at: i64,
      undo: <opaque>, redo: <opaque>       // 只存 diff（before/after 音符、CC、轨道属性）
    }

规则：
- 历史是**应用级单栈**（按 tabKey 分段），跨页撤销一致；
- 命令必须可序列化（用于崩溃恢复/诊断），但不得依赖 DOM/对象引用；
- 快照式整轨深拷贝只保留给「导入/宏/批量」这类无法表达 diff 的兜底命令，并带内存上限；
- 撤销必须恢复选区与视口（至少恢复到被修改位置附近）。

## 7. 持久化与迁移

- 文件：.fufumidi 为 zip（project.json + assets/），project.json 是本文件定义的 JSON；
- 只增不删：新字段必须有默认值；旧版本读到未知字段应忽略并原样保留（round-trip safe）；
- 版本升级：version 1→2 迁移脚本（前端 core/song_project.js + 未来 Rust core 各一份，双跑对拍）；
- 数据库（SQLite）只存索引/缓存/会话状态，不是工程真相；工程真相永远在 .fufumidi。

## 8. 所有权与同步（过渡期）

| 阶段 | 工程数据持有者 | 前端角色 | Rust 角色 |
|---|---|---|---|
| M0–M1 | 前端 JS（现有 store） | 全量编辑 | 只读：导入/导出/统计/对拍 |
| M2–M3 | 前端 JS + Rust sidecar | 编辑，命令通过桥发送 | 无状态服务：量化/展开/导出/校验 |
| M4+（7.0） | Rust core | 只保留视图缓存与选择状态 | 权威模型；前端按增量 RPC 读写 |

迁移到 Rust 权威模型前，必须先完成：
1. 命令式撤销（前端）且命令可序列化；
2. 编排展开双跑一致；
3. 稳定 ID 全面落地（Note/Track/Clip）；
4. 工程 JSON round-trip 无字段丢失测试（100 个真实工程 fixture）。

## 9. 与现有代码的映射（迁移参考）

| 本模型 | 现有落点 |
|---|---|
| Song / Track / Note | frontend/src/core/midi.js、stores/app.ts、core/song_project.js |
| TimeSigMap / TempoMap | core/timeline.js（TimelineModel）、ViewEdit 的 sigMap 读写点 |
| ArrangeState / Clip | frontend/src/core/arrange.js、views/ViewArrange.vue |
| 撤销 | components/EditorCanvas.vue 的 undo/redo、core/history_stack.js（编排页） |
| 通道事件 | core/midi.js（bend/aftertouch）、core/player.js（CC 调度） |
| 持久化 | core/song_project.js、main/project.js（.fufumidi 打包） |

> 注意：现有 JS 对象尚无 Note.id；v2 要求新增。落地顺序：先在**新建音符与导入**时分配 id，
> 再做「缺 id 的旧工程加载时补齐」，最后才让命令/撤销依赖 id。不要一次性全仓改对象结构。
