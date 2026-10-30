# Electron 升级评估（6.4）

## 现状

- 版本：electron@33.4.11（已 EOL）
- 原生依赖：webwallgl（WE 背景）；BASS 由 Python 侧持有
- 渲染进程：Vue 3 + Vite 6，未使用 Electron 33 专属 API

## 可选目标

| 方案 | 版本 | 风险 | 结论 |
|---|---|---|---|
| 保守 | 33.x 最后补丁 | 已 EOL，仅短期 | 不推荐 |
| 稳定线 | 37.x | 原生模块需重新编译；webwallgl 需验证 | 推荐先做 |
| 最新 | 45.x | Chromium/Node ABI 跨代，风险最高 | 二期 |

## 升级门槛

1. npm ci 后 webwallgl 能 load；
2. 主进程 app.whenReady、protocol、printToPDF、desktopCapturer 正常；
3. 安装版冒烟（首屏/preload/无未捕获异常）通过；
4. WE Scene/Web/Video 背景可渲染；
5. 打包体积变化记录。

## 当前决定

本轮不冒险切 Electron：先把 6.3.1 的编辑/转录/乐谱功能收口。升级按 37.x 单独分支验证，避免把 UI 回归和运行时升级混在一起。
