# 双端执行报告（2026-10-30）

## 结论

两套方案已按确认决策实现，产物已生成并验证到本机可执行层。**未上传 GitHub Release，等待你审查后再发布。**

## FuFumidi 6.3.0

- 版本四源：根/frontend package、changelog、version.js、licenses 均为 6.3.0。
- 外观新增六档材质：原生 / 玻璃 / 亚克力 / 云母 / 磨砂 / 天鹅绒；保存到 settings.ui_material。
- 关于页顶部新增第三方资源免责声明（中/英/日/繁文案）。
- 首页新增 FuMiVoice 手机版卡片，直达 GitHub Releases。
- 质量门禁：typecheck 通过；test:ui 546/546；check:i18n EN/JA 0 新增缺失；check:version 四源一致；build-release 成功；部署安装版冒烟通过（首屏有内容 / preload 正常 / 0 未捕获异常 / 0 console.error）。
- 本机安装版已更新到 6.3.0（关于页显示 6.3.0）。
- 产物：
  - E:/Midi/安装包/FuFumidi/6.3.0/FuFumidi Setup 6.3.0.exe
  - E:/Midi/安装包/FuFumidi/6.3.0/FuFumidi.Install.6.3.0.exe
  - release-notes-v6.3.0.md
- 源码：feat/audio-tagger-auto-probe，提交 6fd2bea（已推送）。

## FuMiVoice 1.1.0

- 版本 1.1.0 / versionCode 13；Gradle wrapper 固定 8.9；JDK17 + SDK36 构建。
- 材质六档（原生/玻璃/亚克力/云母/磨砂/天鹅绒），默认玻璃 + 极光；7 个壁纸项含纯色。
- 图标：由 FuFumidi logo 的图形/配色重绘的抽象版；legacy 5 档、圆形 5 档、自适应前景、Android 13 单色层。
- 音符瀑布视觉升级：立体高光、投影、发声键纵向光柱、落点扩散环、击键涟漪、深靛星空舞台、键盘高亮、柔和落点光。
- 设置入口移到顶栏齿轮；新增 BackHandler；MIDI 解析移到 Default 线程；音色库与 FuFumidi 同源。
- 构建：assembleRelease + bundleRelease 成功；APK 39MB，AAB 38MB。
- 签名：与现有证书一致
  - DN: CN=LiZeSen, OU=Teyvat Fontaine Music Co.,Ltd, ...
  - SHA-256: 92475b10a19728ba37acf2cf0dbe6b63b36b8114650c03f72f2fb15d4118480d
  - versionCode 13 / versionName 1.1.0 已用 apksigner/aapt2 核对。
- 产物：
  - E:/Midi/安装包/FuMiVoice/FuMiVoice-1.1.0-release.apk
  - E:/Midi/安装包/FuMiVoice/FuMiVoice-1.1.0-release.aab
  - RELEASE-NOTES-1.1.0.md
- 源码：feat/1.1.0-appearance-waterfall，提交 3d7d045（已推送）。

## 已知验证边界

- FuMiVoice 无可用真机/模拟器（本机 Android Emulator 无硬件加速，未完成截图与帧率实测）。APK 已通过 Gradle 构建、签名校验、资源校验；瀑布/外观的运行时截图需你安装 APK 后确认。
- 未做 GitHub Release 上传；需你审查后再发。
- FuMiVoice 云同步 token 加密、音频焦点、导出取消等 P1 项未在本轮实现，保留在审计方案 Phase 1/3。

## 审查建议

1. 安装 FuFumidi Setup 6.3.0 / APK，检查外观六档、首页 FuMiVoice 入口、关于页免责声明。
2. FuMiVoice 装 1.1.0，检查默认玻璃+极光、六材质、抽象图标、瀑布新视效、顶栏齿轮、返回键。
3. 确认后我再上传 Releases/打 tag；如果视觉或默认值要改，先改再发。
