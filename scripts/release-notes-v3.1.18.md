# FuFumidi v3.1.18

## 修复
- **完整性检查 core-corrupt 误报（根治）**：3.1.17 虽已修复「文件写入中误判」，但 Electron 运行环境下 `fs.statSync(app.asar).size` 会被其内置的 asar 虚拟化拦截篡改为恒返回 `0`，导致「文件过小（<1MB）」判断每次启动都误报 `core-corrupt`。本版改用 Electron 提供的未补丁 `original-fs` 读取 app.asar 真实文件大小（开发模式自动回退普通 fs），再配合「落盘稳定」等待逻辑，彻底消除误报——正常安装不再出现「完整性检查发现以下问题」

## 更新方式
- 3.1.x 用户：应用内自动更新（增量更新器差分下载，只拉改动部分），或下载 `FuFumidi.Install.exe` 离线包覆盖安装
- 新用户：下载 `FuFumidi-Setup-3.1.18.exe` 完整安装
