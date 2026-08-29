# FuFumidi v3.1.10

## 新功能
- **更新后首启展示更新内容**：升级完成后首次启动自动弹出更新日志（对比上次版本，展示从旧版到当前的全部更新内容）
- **UTAU 钢琴卷帘导入 MIDI 基底旋律**：支持导入 MIDI 文件，或从曲库选一首 MIDI 作为基底旋律（自动跳过鼓轨、读取 BPM），双击音符即可修改唱音
- **资源中心 · 转录模型运行时一键安装**：MuScriptor / Aria-AMT / Transkun 依赖组纳入模型依赖检查，模型文件列表直接显示「缺运行时包 + 一键安装」
- **GPU 加速安装自检**：CUDA 增强包安装后自动验证 torch.cuda 可用性，覆盖 Blackwell（RTX 50 系，CUDA 12.8 / cu128），失败给出驱动更新等明确指引
- **MuScriptor 显式 CUDA 推理**：装好 GPU 增强包后转录自动使用 GPU，日志明确显示 GPU / CPU

## 修复
- 修复 UTAU 钢琴卷帘右键菜单导致整体消失的渲染崩溃
- 修复 MuScriptor 模型下载后仍报 `No module named 'muscriptor'`（运行时随安装包内置）
- 首页板块「即将上线」标注修正（可视化 / MIDI 分析器 / 乐谱 / 转换均已上线）

## 更新方式
- 3.1.x 用户：应用内自动更新（或下载 `FuFumidi.Install.exe` 离线包覆盖安装）
- 新用户：下载 `FuFumidi-Setup-3.1.10.exe` 完整安装（含 muscriptor 运行时与 Python 环境）
