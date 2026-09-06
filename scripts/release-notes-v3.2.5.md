# FuFumidi v3.2.5

## 修复
- 修复应用内增量更新器下载失败的问题：此前更新强制使用单一镜像源（ghfast.top），该镜像不可达或超时时会直接报「释放文件 resources/app.asar 失败：连接下载服务器超时」，更新无法继续。现在启动更新器前会自动 HEAD 探测 ghfast / gh-proxy / ghproxy.net / GitHub 官方四个下载源并选用当前可达的源，检查更新时实际连通过的源会被优先复用，不再因单一镜像故障而卡死。

## 更新方式
- 3.2.x / 3.1.x 用户：应用内自动更新（增量更新器差分下载），或下载 `FuFumidi.Install.exe` 离线包覆盖安装
- 新用户：下载 `FuFumidi-Setup-3.2.5.exe` 完整安装
