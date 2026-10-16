worldline 原生库（随包分发）
===========================

来源
----
OpenUTAU 项目自带的 `cpp/worldline/`（MIT，Copyright (c) 2014 StAkira），
预编译产物取自上游仓库的 `runtimes/<rid>/native/`。

OpenUTAU 仓库：https://github.com/stakira/OpenUtau
本目录文件与上游路径的对应：

| 本目录 | 上游路径 |
|---|---|
| `win-x64/worldline.dll`    | `runtimes/win-x64/native/worldline.dll` |
| `win-arm64/worldline.dll`  | `runtimes/win-arm64/native/worldline.dll` |
| `win-x86/worldline.dll`    | `runtimes/win-x86/native/worldline.dll` |
| `linux-x64/libworldline.so`   | `runtimes/linux-x64/native/libworldline.so` |
| `linux-arm64/libworldline.so` | `runtimes/linux-arm64/native/libworldline.so` |
| `osx/libworldline.dylib`   | `runtimes/osx/native/libworldline.dylib` |

RID（Runtime Identifier）命名沿用 .NET / OpenUTAU 的约定，`native_lib.platform_rid()`
按当前解释器所在的平台与架构推导出同一个名字。

上游版本（2026-10-13 确定）
--------------------------
上述 **6 个二进制全部取自上游 commit `04c4e61005`**（2026-09-27，PR #2468 Rebuild Worldline）。

确定方法：`git clone --filter=blob:none --no-checkout` 拉上游，对每个文件算 `git hash-object`，
再遍历改动过该路径的 commit 取 `git rev-parse <sha>:<path>`；**blob 哈希相同即字节相同**。
6 个文件**各自只有唯一一个 commit 命中**，所以这不是推断，是精确解。

由此也得到本移植的**基线日期：2026-09-27** —— 判断「上游改了我们没跟」时以此为准。

为什么必须随包分发
------------------
C# 侧是 `[DllImport("worldline")]`，CLR 会照 `runtimes/<rid>/native/` 去解析，
应用目录里天然可用。Python 的 `ctypes.CDLL('worldline')` 只搜系统路径，
打包（asar）之后**必然找不到** —— 变调链路在真机上直接不可用。
所以这里放一份，并交给 `openutau/native_lib.py` 解析绝对路径。

许可证
------
MIT，全文见同目录 `LICENSE-OpenUtau.txt`。分发时该文件必须随二进制一起保留。
