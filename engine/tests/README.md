# engine tests（FuFumidi 转录引擎测试）

本目录是 FuFumidi Python 转录引擎的可观测、可复现骨架测试。
**只测纯逻辑，不 import 重型 ML 库、不下载模型、不调用 GPU、不做真实转录。**

## 为什么存在

引擎由多个模块组成，其中 `engine_pt.py`、`engine_basic.py`、`engine_separate.py`
等会依赖 torch / basic-pitch / demucs 等重型库。这些库在离线或未安装的机器上
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

当前**没有任何用例被 skip**（`pytest -q` 结果里的 `s` = 0）。

唯一的“条件性”用例是 `tests/test_midi_post.py::test_real_pretty_midi_objects`，
它在 `pretty_midi` 未安装时通过 `pytest.importorskip("pretty_midi")` 自动跳过——
因为真实 MIDI 对象需要 pretty_midi。其余 midi_post 用例用轻量假对象模拟
pretty_midi 的 `Note / Instrument / PrettyMIDI` 接口，不依赖 pretty_midi。

如果将来新增用例不得不触碰重型库，规范是：

1. 顶层不要 `import torch / basic_pitch / demucs / piano_transcription`；
2. 用 `pytest.importorskip("torch")` 或 `try/except + pytest.skip` 包裹，跳过时
   在用例 docstring 里写明原因；
3. 在本 README 的“被 skip 的测试与原因”小节补一行说明。

## 如何扩展

新增测试：在 `tests/` 下加 `test_*.py`，pytest 会自动收集。

约定与约束：

- **不修改任何现有 `engine*.py` / `music2midi.py` / 业务代码**。本套件只新增
  测试文件与配置。`engine_pt.py` 正在被其他改动维护，测试不要 import 它。
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
