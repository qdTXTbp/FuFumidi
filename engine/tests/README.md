# engine tests（FuFumidi 转录引擎测试）

本目录是 FuFumidi Python 转录引擎的可观测、可复现骨架测试。
**只测纯逻辑，不 import 重型 ML 库、不下载模型、不调用 GPU、不做真实转录。**

## 为什么存在

引擎由多个模块组成，其中 `engine_pt.py`、`engine_basic.py`、`engine_msst.py`
等会依赖 torch / basic-pitch / pymss 等重型库。这些库在离线或未安装的机器上
无法导入，也会拖慢测试。因此本测试套件**刻意只覆盖**：

- `presets.py` —— 预设的加载 / 保存 / 删除 / 结构
- `engine.py` / `engine_perf.py` —— 模式、默认参数、性能档位线程数边界
- `midi_post.py` —— MIDI 后处理的纯函数（合并 / 过滤短音 / 力度归一化）
- `audio_io.py` —— 文件类型判定、临时文件清理等

这些模块顶层 import 都很轻（只有 os / sys / json 等），可离线运行。

## 运行方式

先装开发期依赖（仅测试用，不进打包）：

```bash
python -m pip install -r requirements-dev.txt
```

在 engine 目录下运行：

```bash
cd F:\NEW\工具测试\Fu\app\engine
python -m pytest tests/ -q
```

带覆盖率：

```bash
python -m pytest tests/ -q --cov=. --cov-report=term-missing
```

配置位于 `engine/pyproject.toml`：

- `[tool.pytest.ini_options]`：`testpaths=["tests"]`、`addopts="-q"`、`pythonpath=["."]`
- `[tool.ruff]`、`[tool.mypy]`、`[tool.coverage.run]` 见该文件。

## 被 skip 的测试与原因

没有用例被硬编码 skip。“条件性”跳过（依赖未安装时自动 `importorskip`，不算失败）：

- `tests/test_midi_post.py::test_real_pretty_midi_objects` —— `pretty_midi` 未安装时
  通过 `pytest.importorskip("pretty_midi")` 自动跳过，因为真实 MIDI 对象需要
  pretty_midi。其余 midi_post 用例用轻量假对象模拟
  pretty_midi 的 `Note / Instrument / PrettyMIDI` 接口，不依赖 pretty_midi。
- `tests/test_diffsinger_smoke.py`（整模块） —— `onnx` 未安装时通过
  `pytest.importorskip("onnx")` 整体跳过，因为冒烟测试要构造真实 ONNX 模型。

如果将来新增用例不得不触碰重型库，规范是：

1. 顶层不要 `import torch / basic_pitch / demucs / piano_transcription`；
2. 用 `pytest.importorskip("torch")` 或 `try/except + pytest.skip` 包裹，跳过时
   在用例 docstring 里写明原因；
3. 在本 README 的“被 skip 的测试与原因”小节补一行说明。

## 如何扩展

新增测试：在 `tests/` 下加 `test_*.py`，pytest 会自动收集。

约定与约束：

- **不修改任何现有 `engine*.py` / `music2midi.py` / 业务代码**（测试只做观测；要改行为
  就单独提改动，别夹在测试里）。可以 import 引擎模块 —— `engine_pt.py` / `engine_basic.py`
  顶层只有 `os` / `io` / `contextlib` 等轻量导入，torch / basic-pitch / piano_transcription
  都在函数内延迟导入，**假装一个假 forward / 假 inference 模块**就能测它们的循环逻辑
  （见 `test_engine_pt_pause.py` / `test_engine_basic_pause.py`）。
- 需要写临时文件时用 `tmp_path` fixture（pytest 内置），测完自动清理，不要写进
  引擎目录。
- 需要读写 `presets.json` 等真实路径时，用 `monkeypatch` 重定向模块级路径常量到
  `tmp_path`，避免污染引擎目录。
- 保持轻量导入：新测试文件顶层只 import 被测模块 + 标准库 + pytest。
- 断言语义清晰，一个用例只验证一件事，命名用 `test_xxx_期望行为` 风格。
- 保持离线可复现：不下载模型、不访问网络、不调用 GPU。

## 覆盖的模块与测试文件

| 文件 | 测什么 |
|------|--------|
| `test_presets.py` | `load_presets` 返回结构、内置预设覆盖全部 mode、每个预设结构合法、save/delete/last_used 往返 |
| `test_engine_config.py` | `MODES`/`DEFAULT_MODE`/`DEFAULTS` 结构、`merge_params`、`PERF_MODES`/`PERF_LABELS`、`resolve_threads` 边界（fast≤2 / balanced≤4 / quality 不限 / 非法回退） |
| `test_midi_post.py` | `merge_overlap`、`remove_micro_notes`、`normalize_velocity`、`apply_post`、`count_notes`（含真实 pretty_midi 集成） |
| `test_audio_io.py` | `AUDIO_EXTENSIONS`/`MIDI_EXTENSIONS` 内容、扩展名判定（大小写）、`remove_temp` 幂等、`find_ffmpeg` 返回类型 |
| `test_utau_engine.py` | `engine_utau.py`（歌声合成）：oto.ini 解析、`note_to_hz`、单音节渲染、多音节拼接（preutterance 对齐 + 等功率 overlap 交叉淡化）、velocity/颤音/包络、静音切分 `split_syllables`、CV 自动标注 `auto_oto_params`、segment/auto-oto/aliases/flags CLI；**v0.2.0 专业化**：`parse_flags`（连写/夹紧/未知项）、TD-PSOLA 变调保共振峰（对比 `--flags N` 线性重采样）、OLA 辅音伸缩保频谱、t/g/B flags 生效、未支持 flag 进 warnings、`--strict` 歌词报错、`render_track` 返回 warnings |
| `test_linked_list.py` | `linked_list.py`（有序链表合并）：`ListNode` 构造默认值、空链/单侧空边界、交错与整体有序合并、链内重复值保序、相等值稳定取左链节点、复用原节点不新建 |
| `test_diffsinger_smoke.py` | `engine_diffsinger.py` 端到端冒烟：构造假声库 + 假 ONNX 模型跑通 render 管线（需 onnx，缺则整模块跳过） |
| `test_pause_gate.py` | `pause_gate` 公共闸门 + `engine_muscriptor._pause_gate` / `_install_pause_wrapper`：无标记文件原样透传、有标记文件当场卡住不产出、删掉后从原处继续、暂停/继续各只打一行日志、**每次转录重绑 log_cb**（第二首的日志不许打到第一首的回调上） |
| `test_engine_pt_guard.py` | `engine_pt._sane_min_note_ms` 碎音护栏：最短音符 <30ms 时抬到 30ms 并说明原因（实测 10ms 等于关掉过滤器：30 秒样例 71→8037 个音符、3 分钟样例 47967 个 / 517 秒），正常值原样透传、缺省用 60ms 不报警、日志回调抛异常也不影响转录 |
| `test_engine_pt_pause.py` | `engine_pt._chunked_forward`（替换 pytorch_utils.forward 的逐批循环）：分批结果与一次大批量逐元素相等、闸门在批次之间被检查、暂停后从原处继续不重算、慢机器按实测耗时把后面的批减半、快机器不受影响 |
| `test_engine_basic_pause.py` | `engine_basic._install_audio_input_gate`（包 basic_pitch 的取窗生成器）：只挂一次不叠加、无标记文件透传、暂停卡在窗与窗之间后接着跑、包装器不捕获 log_cb |
| `test_pitch_evidence.py` | `engine_muscriptor._make_pitch_evidence`：音频证据式收尾的绝对判据（真实长音不许被切、强起音不许被切、稀疏鼓点不许续命、"音频里根本不存在"的音符要删） |
| `test_engine_auto_bpm.py` | `engine._apply_auto_bpm`：改写 set_tempo 时必须同步缩放**绝对 tick**（只改 BPM 会让时间轴和音频对不上），含 0 音符 / 无 tempo / 非法 BPM 边界 |
| `test_singing_adapters.py` | `singing` 抽象层对照（M1）：UTAU 适配器输出与直接调用 `render_track` 逐位一致、音素化器字段取自 oto.ini 原值、注册表解析/未知报错/未接渲染器抛 NotImplementedError、DiffSinger 音素化有真实声库才跑（没有就跳过，不假装通过） |
| `test_ustx_roundtrip.py` | ustx YAML 序列化：键名合法（snake_case）、OmitNull/YamlIgnore 生效、语义往返一致、颤音/表达式夹紧语义、未知键忽略兼容 |
| `conftest.py` | 共享 fixture（非测试文件）：`tmp`（临时工作目录 str 路径）、`vb_dir`（最小 UTAU 音源）。`test_singing_adapters.py` 是脚本/pytest 双模式文件，脚本模式由 `main()` 手动传参，pytest 收集模式靠这两个 fixture 解析同名参数 |
