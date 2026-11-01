# 3D 互动钢琴 / 音游 / 外接电钢琴方案

> 目标：把现有“可视化”的钢琴从 2D 瀑布升级为可交互的 3D 钢琴；可当音游，也可外接电钢琴直接演奏、录制。
> 不新增独立应用；作为“可视化”里的新模式，复用现有播放、合成、录音和 MIDI 输入能力。

## 1. 现有基础（不重复造）

- 2D 瀑布：`ViewViz.vue` + `core/viz/`，已有沉浸、背景、后处理、导出。
- 合成与播放：`audio.js` / player，已有 SoundFont 与走带。
- 外接 MIDI：`frontend/src/core/midiin.js` 已支持 Web MIDI 枚举/监听/时间戳/CC。
- 录音：`frontend/src/core/recorder.js` + `RecordPanel.vue` 已有预备拍、量化、overdub、延迟校准、take 采用/丢弃。
- MIDI 编码：`frontend/src/core/midi.js` 的 `encodeMidi`。

结论：**3D 只补渲染和游戏层；输入/录音复用现有模块。**

## 2. 玩法形态

在“可视化”里增加一个模式 chip：

```text
仪表盘 | 瀑布流 | 3D 钢琴
```

3D 钢琴包含四个子模式：

1. **自由演奏**
   - 外接电钢琴按键，3D 琴键下沉、发声；
   - 不评分，可随时录制。
2. **跟弹练习**
   - 音符落在键前，可按“等待模式”停住等你弹对再继续；
   - 分手/分段/循环。
3. **音游模式**
   - 3D 下落音符 + 判定线 + Perfect/Great/Good/Miss + Combo/准确率；
   - 速度、延迟校准、镜像、左手/右手模式。
4. **录制**
   - 直接录成新轨/新曲；
   - 复用现有 RecordPanel 的预备拍、量化、叠加、延迟补偿。

## 3. 3D 场景设计

### 3.1 钢琴模型

- **程序化几何**优先：88 键尺寸按真实比例生成，白键/黑键、琴体、琴盖、谱架、踏板、琴腿；
- PBR 材质：黑色亮面漆、木纹、毛毡、黄铜踏板；
- 环境反射 + 柔和阴影 + ACES tone mapping；
- 可选“剖视模式”展示琴槌/琴弦（P1）；
- 不依赖外部大模型，避免授权和包体膨胀；后续允许导入用户 glTF。

### 3.2 镜头

| 镜头 | 用途 |
|---|---|
| Player | 演奏者视角，看键与下落音符 |
| Audience | 观众视角，展示钢琴整体 |
| Top | 俯视，适合教学/录像 |
| Cinematic | 缓慢环绕，适合展示/导出视频 |

镜头切换用弹簧平滑，不做硬切。

### 3.3 音符表现

- 3D 下落条/粒子，按轨道颜色；
- 键盘上方有命中线和光晕；
- 长音用连续光带，踏板音有延音尾迹；
- 当前按键的 3D 琴键同步下沉，力度决定下沉深度与高光；
- 背景保留现有主题/壁纸，3D 场景作为前景层。

### 3.4 性能

- Three.js 的 `InstancedMesh` 渲染音符与琴键；
- 限制 DPR 2，低端 GPU 自适应降级；
- 只渲染可见时间段音符；
- HUD 用 DOM/Canvas 覆盖，不用 Vue 响应式逐音符更新；
- 目标 1080p 60fps，低端 30fps 可接受。

## 4. 输入与延迟

### 4.1 外接电钢琴

复用 `midiin.js`：

- 枚举 USB/蓝牙 MIDI 设备；
- 选择设备、热插拔、断线重连；
- note on/off、velocity、CC64 延音、pitch bend（P1）；
- 通道过滤、移调、键盘分割；
- 设备选择持久化。

Web MIDI 在 Electron 里直接放行（现有代码已注释确认）；普通网页才需要首次权限。

### 4.2 延迟校准

- 复用 `recorder.calibrateLatency` 的点击校准结果，写入 `midiInputOffsetMs`；
- 音游判定使用“音频时钟 + 输入延迟补偿”，不用帧时间；
- 提供手动滑杆微调；
- 低延迟音频：复用现有 WebAudio/SoundFont 通道，避免额外原生依赖。

### 4.3 判定

参考 osu!mania 等音游的判定思路：

```text
Perfect: ±25 ms
Great:   ±50 ms
Good:    ±90 ms
Miss:    超过 130 ms（可配置）
```

- 和弦必须整组命中；
- 长音按持续时长给分，不因提前松手直接判 Miss；
- 错误音符只扣准确率，不强行中断（练习模式例外）；
- 视觉判定和音频时间解耦，掉帧不改变得分。

## 5. 录音方案

复用现有 `recorder.js`：

- 预备拍 0/1/2 小节；
- 量化 off / 1/4 / 1/8 / 1/16 / 1/32；
- replace / overdub；
- 延迟补偿；
- take 采用/丢弃。

新增：

- 3D 视图内一个紧凑“录制”按钮，不打开完整编辑器；
- 录完直接生成新轨或新曲，走现有 `encodeMidi`；
- P1 再增加 WebAudio 音频录制（MediaRecorder），与 MIDI 同步导出视频/音频。

## 6. 与现有工程集成

```text
frontend/src/views/ViewViz.vue
  └─ 增加 mode = 'piano3d'
frontend/src/components/viz/Piano3D.vue
  └─ Three.js 场景、相机、音符、HUD
frontend/src/core/piano3d/
  ├─ scene.js        场景/灯光/后处理
  ├─ pianoModel.js   程序化钢琴
  ├─ notes3d.js      下落音符/InstancedMesh
  ├─ game.js         判定/准确率/连击
  ├─ camera.js       镜头
  └─ input.js        包装 midiin.js
```

- 依赖：新增 `three`（约 600KB），不引入 React；
- 播放时间：复用 player.currentTick / secToTick；
- 音色：沿用 SoundFont 当前音色，3D 不单独维护一套音源；
- 录音：复用 RecordPanel 的逻辑，不复制一套。

## 7. 参考项目/产品

- Midi-Virtual-Piano：3D MIDI 可视化 + 录制的思路
  https://github.com/MengLinMaker/Midi-Virtual-Piano
- PianoFromAbove：3D 下落音符钢琴可视化
  https://github.com/khang06/PianoFromAbove
- Piano Odyssey：面向 MIDI 键盘的节奏游戏引擎
  https://sourceforge.net/projects/pianoherogl/
- Piano Trainer Studio：MIDI 键盘练习 + 实时反馈
  https://github.com/ztbishop/piano-trainer-studio
- PianoVision：VR/混合现实钢琴学习，音符落键与练习模式参考
  https://www.pianovision.com/learn-piano-in-vr/
- osu!mania 判定系统：判定窗口/准确率参考
  https://osu.ppy.sh/wiki/en/Gameplay/Judgement/osu!mania
- Web MIDI API：浏览器硬件输入
  https://developer.mozilla.org/en-US/docs/Web/API/Web_MIDI_API
- Three.js：WebGL 3D 渲染
  https://threejs.org/

## 8. 分阶段交付

### P0（3–5 天）
- `three` + 3D 钢琴场景（程序化 88 键、基本材质、固定镜头）；
- 瀑布音符 3D 化；
- 外接 MIDI 按键下沉/发声；
- 自由演奏 + 基础录制（复用 recorder）；
- 延迟校准入口。

### P1（5–8 天）
- 音游模式：判定、Combo、准确率、结算；
- 跟弹/等待模式、分手、循环、变速；
- 镜头切换、踏板延音、按键高光；
- 录制 take 应用到轨道/新曲。

### P2（持续）
- 更真实材质/反射/剖视琴槌；
- 音频录制、视频导出；
- 统计、曲目难度、排行榜（本地）；
- 可选导入用户钢琴 glTF。

## 9. 验收标准

- 88 键电钢琴 USB 插入后可枚举、选择、热插拔；
- 按键到发声无可感知延迟，画面琴键同步下沉；
- 录制 2 分钟不丢音符，松手/断连不产生 stuck note；
- 音游判定基于音频时钟，掉帧不改变得分；
- 1080p 中端 GPU 60fps，低端可降到 30fps；
- 3D 模式不破坏原仪表盘/2D 瀑布，切换可回退；
- 现有 MIDI 录音/编辑器录音路径保持不变。

## 10. 风险

- Three.js 与 Electron GPU 兼容：需要 DPR/降级/回退 2D；
- 蓝牙 MIDI 延迟高于 USB：UI 明确提示优先 USB；
- 真实钢琴模型资产版权：默认程序化，glTF 只允许用户自带；
- 低端机 3D + 瀑布同时开可能掉帧：3D 模式默认关闭 2D 叠层；
- 判定窗口不能照搬 osu!mania（钢琴和弦/长音不同），需要实测调参。
