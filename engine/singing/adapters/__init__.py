# -*- coding: utf-8 -*-
"""引擎适配器：把现有 `engine_*.py` 接进 singing 抽象层。

M1 的硬约束是**行为不变** —— 适配器只做「参数搬运 + 结果包装」，
不复制也不改写任何 DSP / 推理逻辑。每个适配器都配了与原函数逐位一致的对照测试
（`engine/tests/test_singing_adapters.py`）。
"""
