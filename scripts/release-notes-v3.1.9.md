# FuFumidi v3.1.9

## UTAU 歌声合成工作台（新板块）
- **声库制作**：上传音频自动切分（可调静音阈值/最短音节时长）或直接录音；可视化 oto.ini 标注界面（offset/overlap/preutterance/consonant/blank 五标记拖拽）；桌面版选目录导出 oto.ini + WAV，网页版下载
- **曲谱（钢琴卷帘编辑器）**：画笔/选择工具、网格吸附（1/1·1/2·1/4 拍）、缩放、播放走带与试听；框选多选、Shift 加选；撤销/重做（Ctrl+Z/Y）；复制/剪切/粘贴/重复（Ctrl+C/X/V/D）、全选（Ctrl+A）；拖拽画音、左右缘调整时长、Alt+拖拽复制；方向键微调（Shift 跨八度/调时长）；双击或右键编辑歌词；右键上下文菜单
- **导入现成声库**：支持导入 .zip 格式 UTAU 声库（自动定位 oto.ini）
- **调声/渲染**：音符参数（力度/音量/颤音）面板 + 渲染合成

## 修复
- 修复右键菜单导致钢琴卷帘整体消失的渲染崩溃
- 修复 muscriptor：模型下载后仍报 `No module named 'muscriptor'`——运行时包现随安装包内置
- 修复 MuScriptor 缺模型时报晦涩 HF 错误，改为清晰提示并列已就绪规格
- 修复模型切换失效（worker 路径未透传 model/model_size）
- 修复网页版参数预设「应用无效」（预设列表静默留空）

## 更新方式
- 3.1.x 用户：应用内自动更新（或下载 `FuFumidi.Install.exe` 离线包覆盖安装）
- 新用户：下载 `FuFumidi-Setup-3.1.9.exe` 完整安装（含 muscriptor 运行时与 Python 环境）
