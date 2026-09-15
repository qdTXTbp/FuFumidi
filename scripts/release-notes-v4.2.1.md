# FuFumidi v4.2.1

本次修的是 4.2.0 在**干净 Windows** 上暴露的问题 —— 最大的一条是「装完转录直接用不了」。

## 修复

### 转录引擎在干净系统上完全不可用（重要）
- **根因**：内置 Python 运行时依赖 VC++ 2015-2022 x64 运行库，而干净 Windows 不自带、安装包也没带。
  表现为 `torch` / `onnxruntime` 直接报 `WinError 126 找不到指定的模块`，
  「资源管理 → 模型运行时」自检里 `universal` / `piano` / `muscriptor` 三组全部 **broken**
- 现在 11 个运行库 DLL 随包分发（`resources/python` + `resources/vcredist`），
  并在启动后首次用到引擎时自动补齐
- 走增量更新的老用户也会被修好：更新器的 `ignoreFolderPath` 会跳过 `resources/python`，
  所以另存了一份在 `resources/vcredist`（不在忽略列表里）

### Aria-AMT / Transkun 推理依赖缺失
- 「模型运行时」自检报 `aria: missing amt / ariautils / orjson`、`transkun: missing transkun`，
  下载了模型也跑不起来
- 内置运行时已补齐这两组；`aria` 组的 `amt` / `ariautils` 不在 PyPI，只能从 GitHub 取，
  现由 `scripts/bundle-python.js` 统一装配并自检（任一组不完整就构建失败）

### 「一键补全缺失依赖」不再要求系统装 git
- 原先 `aria` 组走 `git+https://…`，而干净 Windows 没有 git，补全**必然失败**
- 现在检测不到 git 时自动回退到源码 zip（pip 支持 archive URL，只需 HTTPS）

### 卸载不再静默删除用户数据
- 原来卸载会连 `FuFumidiData`（模型 / 声库 / 音色库 / 曲库，动辄几个 GB）一起删掉
- 现在卸载前会询问：选「否」（默认）保留在安装目录，重装到同一目录即可继续使用；
  选「是」才连同数据一起清除；静默卸载 `/S` 一律保留

## 升级说明
- 增量更新：设置 → 更新 → 检查更新（走 ghfast 镜像，仅下载改动部分）
- 全新安装：运行 `FuFumidi Setup 4.2.1.exe`
- 从 4.2.0 升上来的用户：若之前「模型运行时」自检有 broken，升级后重启应用即可自动补齐运行库
