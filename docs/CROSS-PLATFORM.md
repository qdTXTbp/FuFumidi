# 跨平台支持（P2-4）

> 现状：**Windows 是正式发布平台**；macOS / Linux 目前只承诺「可运行 dev 包」——
> 未签名、未公证、未做原生依赖打包，且没在本仓库 CI 里真机构建过。

## 构建入口

```bash
# 看目标平台要求 + 冒烟清单（任何平台都能跑）
node scripts/build-platform.mjs --target darwin --dry-run
node scripts/build-platform.mjs --target linux --dry-run

# 在目标平台上真正构建（electron-builder 原生依赖只能本机构建）
node scripts/build-platform.mjs --target darwin
node scripts/build-platform.mjs --target linux
```

| 项 | Windows | macOS | Linux |
|---|---|---|---|
| 安装包 | NSIS `.exe` + kachina 更新器 | `.dmg`（dev，未签名） | `AppImage`（dev） |
| Python 运行时 | `resources/python/python.exe`（随包） | `resources/python/bin/python3`（需自备） | 同 macOS |
| 数据根 | 工具目录旁 `FuFumidiData` | `~/Library/Application Support/FuFumidiData` | `~/.local/share/FuFumidiData` |
| 签名 / 公证 | Authenticode 待证书 | 需 Apple Developer 账号 | 无 |

运行时路径的单一来源是 `main/platform.js`：`pythonRuntimeRelative` / `venvPythonRelative` /
`defaultDataRoot` / `installerExt` / `smokeChecklist`。新增平台相关代码请先加到那里并补测试
（`npm run test:platform`），不要再在业务模块里写 `python.exe`。

## macOS / Linux dev 包前置条件

1. **Python 3.11+ 运行时**：本仓库只随 Windows 打包 Python；mac/linux 需要把目标平台的
   Python 放到 `resources/python/bin/python3`（或用系统 python3），并保证 numpy/mido/scipy/Pillow 可导入。
2. **ffmpeg**：分离/转码依赖它；Linux 走系统 ffmpeg，macOS 可用 `brew install ffmpeg`。
3. **模型**：不随包分发，首次使用时按资源中心下载（路径逻辑与平台无关）。
4. **不支持的 Windows 专有功能**：注册表文件关联、`taskkill` 清理、MSI 解包安装器（Audiveris）
   在非 Windows 上会明确报「不支持」而不是崩溃（`main/settings-ipc.js`、`main/omr.js` 已有守卫）。

## 冒烟清单（构建后逐条验证）

```bash
node scripts/build-platform.mjs --target darwin --skip-build   # 打印清单
```

- 启动到首页（无白屏 / 渲染进程无未捕获异常）
- 导入 MIDI → 播放/暂停/跳转/循环正常
- 编辑页画音符 + 撤销
- 转换页离线渲染导出 WAV（可播放，含 BWF 元数据）
- 设置页打开/关闭、主题/语言切换不崩
- 非 Windows 额外要求：不触碰 Windows 专有 API；WebAudio 起播不报错

## 已知缺口（与 P2 计划的对应关系）

- **P2-4 余下**：macOS 签名+公证、Linux Flatpak、真机构建验证（需要 Apple 账号 / Linux CI runner / 真机）。
- **P2-2 原生音频 I/O**：WASAPI 独占 / ASIO / CoreAudio 的 Rust 实现尚未提供，当前始终回退 WebAudio，
  延迟实测见 `docs/audio-rtl-report.md`。
- **P2-1 Phase B（实时插件宿主）**：按计划不做。
