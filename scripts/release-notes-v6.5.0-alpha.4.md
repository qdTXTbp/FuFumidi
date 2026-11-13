# FuFumidi 6.5.0-alpha.4

- 修复点击「自动更新」后应用直接退出：更新器识别 Tauri 宿主模式，检查/安装完成后等待旧进程退出并自行重启应用。
- Windows 更新器不再依赖外部 PowerShell 守护进程。
- 更新检查仍保留 CNB 优先、GitHub 回退。
