# FuFumidi v3.1.21

## 优化
- **转录完成后自动卸载模型、释放显存**：MuScriptor / 钢琴转录 / 人声分离等进程内加载的模型，转录结束即显式卸载并 `torch.cuda.empty_cache()`（钢琴模型为全局缓存，本次也改为转录后置空），不再长期占用 VRAM；连续转录多首时显存可回落

## 修复
- **MuScriptor 转录「state_dict 尺寸不匹配」**：本地权重（small/medium/large）加载时，muscriptor 无法从路径识别规格、默认按 large 架构构建，导致与权重尺寸全不匹配。现在应用在本地权重旁自动补齐 `config.json`（规格架构：dim/层数/card），muscriptor 直接读取正确架构；下载流程合并完成后同样写入
- **GPU 增强后「Could not load libtorchaudio.pyd」**：CUDA 增强包把 torch 换成 2.9.1+cu128 后，基础环境的 torchaudio（2.13）与其不兼容（MuScriptor 节拍检测 / 人声分离会 `import torchaudio`）。CUDA 增强包已补齐 `torchaudio==2.9.1+cu128`（在线安装与预打包分卷均生效）

## 改进
- **资源中心 GPU 加速包在线下载**：CUDA 分卷（torch 2.9.1+cu128 + onnxruntime-gpu + torchaudio，适配 RTX 50 系 Blackwell）已发布到独立仓 `monologue82/FuFumidi-GPU-Packages`，资源中心可直接扫描/下载；主仓历史资产仍兼容

## 更新方式
- 3.1.x 用户：应用内自动更新（增量更新器差分下载，只拉改动部分），或下载 `FuFumidi.Install.exe` 离线包覆盖安装
- 新用户：下载 `FuFumidi-Setup-3.1.21.exe` 完整安装
