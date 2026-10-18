# VST3 离线渲染（P2-1 Phase A）

> 真实 VST3 插件需要宿主库。应用不内置宿主/插件：宿主用 **pedalboard**（Python，JUCE 封装），
> 插件由用户自备。找不到宿主时明确返回 backend-missing，不会静默退化成内置节点。

## 组件

| 文件 | 作用 |
|---|---|
| `engine/plugin_render.py` | 离线宿主 CLI：`list` / `fx` / `instrument`，输出单行 JSON |
| `main/plugin-host.js` | IPC：`plugin:status/list/pickDir/pickFile/pickAudio/savePath/renderFile` |
| `frontend/src/views/ViewConvert.vue` | 转换页「VST3 离线渲染（实验）」按钮：选插件 → 选输入 WAV → 选输出 → 渲染 |

## 宿主环境（自备，不随包分发）

```powershell
# 任意 Python 3.12 环境（示例用 uv）
uv venv --python 3.12 E:\Midi\_attic\envs\plugin-uv
uv pip install --python E:\Midi\_attic\envs\plugin-uv\Scripts\python.exe pedalboard numpy soundfile mido
```

- 解释器：设置 `plugin.host_python`，或环境变量 `FUFUMIDI_PLUGIN_PYTHON`；开发机默认回退 `_attic/envs/plugin-uv`。
- 插件目录：设置 `plugin.dirs`（数组）或 `FUFUMIDI_PLUGIN_DIRS`（`;` 分隔）；开发机默认 `_attic/plugins`。
- 插件路径：`.vst3` 包目录或包内 DLL 均可（Windows 上 pedalboard 实际加载包内 `Contents/x86_64-win/*.vst3`）。

## 实测（本机，2026-10-18）

从各项目 GitHub Release 自行获取（均为开源/免费）：

| 插件 | 版本 | 类型 | 加载 | 离线渲染实测 |
|---|---|---|---|---|
| Dexed | 1.0.1 | 乐器 | OK（158 参数） | C4 音符 1.5s：rms −27.6dB，频谱质心 921Hz；**重复渲染频谱最大差 0.0000dB** |
| OB-Xf | 1.0.3 | 乐器 | OK（103 参数） | rms −25.8dB，质心 4.9kHz；插件内部振荡器随机 → 重复渲染有差异（宿主误差已由 Dexed 验证） |
| Surge XT | nightly | 乐器 | OK（599 参数） | rms −21.6dB，质心 4.0kHz；同上（内部随机） |
| Surge XT Effects | nightly | 效果器 | OK（22 参数） | 白噪/音源输入均渲染成功（rms 0.024，1.5s） |

> 验收锚点「3 插件频谱差 <1dB」原指与参考 DAW 的渲染对比；本机没有可脚本化的参考 DAW。
> 已量化的是**宿主自身误差**：确定性插件（Dexed）重复渲染频谱差 0.0000dB；
> 非确定性音源（OB-Xf/Surge XT 的自由振荡器）差异来自插件内部，不能归因于宿主。

## 限制

- **CLAP**：pedalboard 只宿主 VST3（Phase A 只承诺 VST3；CLAP 需要专门宿主）。
- **UI 流程只做效果器**（选输入 WAV → 输出）；乐器渲染已在 CLI 实现（`instrument` 子命令），UI 后续再接。
- **链顺序**：外部 VST3 当前是独立离线流程，尚未与内置 gain/EQ/压缩节点交错插入导出链。
- 插件/宿主目录都在 `_attic`，不随仓库提交；安装包不包含 pedalboard。
