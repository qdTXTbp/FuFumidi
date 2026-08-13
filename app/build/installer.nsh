; ==========================================================================
; 显式引入 NSIS 扩展库（自带 include guard，重复包含无害）
; LogicLib：${If}/${Else}/${EndIf} 条件指令
; nsDialogs：${NSD_CreateLabel}/${NSD_CreateCheckBox}/${NSD_SetState}/${NSD_GetState}
!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "WinMessages.nsh"   ; ${WM_SETTEXT} 等窗口消息常量

; ==========================================================================
; FuFumidi — NSIS 安装程序主题定制
; 现代化 · 扁平化 · 与应用界面同源（深色基底 + teal 强调 #00C9B1）
; 依赖 build/ 目录下的位图（由 gen-bitmaps.js 生成）：
;   installer-header.bmp / installer-welcome.bmp / installer-finish.bmp
; 以及卸载挽留表情包位图（白底，24-bit BMP）：
;   uninstall-1.bmp / uninstall-2.bmp / uninstall-3.bmp
;
; 通过 electron-builder 的 nsis.include 注入；提供 customWelcomePage /
; customFinishPage 钩子接管引导页，MUI2 文案随 installerLanguages 自动中英双语。
; ==========================================================================

; ---- 全局 MUI2 主题定义（在首个 MUI 页面插入前生效）----
; 全局字体：汉仪文黑 85W（内嵌 TTF，安装/卸载 init 时 AddFontResource 加载后生效，
; 加载失败则自动回退系统默认字体）。字体族名以 TTF 内部 nameID1 为准 = "HYWenHei-85W"
!ifndef MUI_FONTNAME
  !define MUI_FONTNAME "HYWenHei-85W"
!endif
!ifndef MUI_BGCOLOR
  !define MUI_BGCOLOR "0c1320"
!endif
!ifndef MUI_TEXTCOLOR
  !define MUI_TEXTCOLOR "e8f1fa"
!endif
!ifndef MUI_HEADERIMAGE
  !define MUI_HEADERIMAGE
!endif
!ifndef MUI_HEADERIMAGE_BITMAP
  !define MUI_HEADERIMAGE_BITMAP "${BUILD_RESOURCES_DIR}\installer-header.bmp"
!endif
!ifndef MUI_HEADERIMAGE_RIGHT
  !define MUI_HEADERIMAGE_RIGHT
!endif
!ifndef MUI_WELCOMEPAGE_IMAGE
  !define MUI_WELCOMEPAGE_IMAGE "${BUILD_RESOURCES_DIR}\installer-welcome.bmp"
!endif
!ifndef MUI_FINISHPAGE_IMAGE
  !define MUI_FINISHPAGE_IMAGE "${BUILD_RESOURCES_DIR}\installer-finish.bmp"
!endif
!ifndef MUI_LANGDLL_ALWAYSSHOW
  !define MUI_LANGDLL_ALWAYSSHOW
!endif

; ---- 欢迎页标题（中英双语）----
LangString FF_WELCOME_TITLE 2052 "欢迎使用 FuFumidi"
LangString FF_WELCOME_TITLE 1033 "Welcome to FuFumidi"
!define MUI_WELCOMEPAGE_TITLE "$(FF_WELCOME_TITLE)"

; ---- 完成页标题与正文（中英双语）----
LangString FF_FINISH_TITLE 2052 "安装完成"
LangString FF_FINISH_TITLE 1033 "Installation Complete"
LangString FF_FINISH_TEXT 2052 "FuFumidi 已成功安装到你的电脑。转录、修正、编辑、播放一条龙，全部在本机完成。"
LangString FF_FINISH_TEXT 1033 "FuFumidi has been installed successfully. Transcribe, refine, edit and play — all local."
!define MUI_FINISHPAGE_TITLE "$(FF_FINISH_TITLE)"
!define MUI_FINISHPAGE_TEXT "$(FF_FINISH_TEXT)"

; ==========================================================================
; 安装器字体：汉仪文黑 85W
; electron-builder 的 installer.nsi 在 .onInit 中调用 customInit（早于任何页面），
; 此时把内嵌 TTF 解到 $PLUGINSDIR 并 AddFontResource，安装界面即整体换用新字体。
; ==========================================================================
!macro customInit
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "${BUILD_RESOURCES_DIR}\HYWenHei.ttf"
  System::Call "gdi32::AddFontResource(t '$PLUGINSDIR\HYWenHei.ttf') i.r0"
  ${If} $0 > 0
    ; WM_FONTCHANGE(0x001D) 广播给所有顶层窗口，令系统刷新字体列表
    ; 用 PostMessage 异步广播：SendMessage 会同步等所有窗口处理，遇无响应窗口会卡死安装
    System::Call "user32::PostMessage(i 0xFFFF, i 0x001D, i 0, i 0)"
  ${EndIf}
!macroend

; ==========================================================================
; 自定义欢迎页：扁平化品牌引导
; ==========================================================================
!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
!macroend

; ==========================================================================
; 自定义完成页：保留“立即运行”勾选（runAfterFinish），样式与欢迎页一致
; ==========================================================================
!macro customFinishPage
  !ifndef HIDE_RUN_AFTER_FINISH
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !endif
  !insertmacro MUI_PAGE_FINISH
  ; 自定义完成页后，electron-builder 不会自动声明 StartApp，需自行提供
  Function StartApp
    ExecShell "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  FunctionEnd
!macroend

; ==========================================================================
; 卸载挽留页
; 卸载时随机出现一段挽留（表情包图片 + 文案）；主题沿用全局深色（MUI_BGCOLOR）。
; 基于 MUI_UNPAGE_WELCOME：原生左侧图片槽（根治自定义页的图片渲染问题）+
; MUI 自动排版标题/正文（根治"对话框尺寸不匹配导致的错位"）。
; 正文 = 随机挽留文案 + 数据保留提示；底部「保留个人数据」复选框（默认勾选）；
; 下一步按钮改名「确认卸载」。
; ==========================================================================

; ---- 卸载页标题（中英双语）----
LangString FF_UN_CONFIRM_TITLE 2052 "卸载 FuFumidi"
LangString FF_UN_CONFIRM_TITLE 1033 "Uninstall FuFumidi"

; ---- 3 套挽留文案（中英双语）----
LangString FF_MSG1_TEXT 2052 "你真的忍心卸载芙芙吗？"
LangString FF_MSG1_TEXT 1033 "Would you really uninstall FuFu?"
LangString FF_MSG2_TEXT 2052 "死刑！必须死刑！不允许你来审判我"
LangString FF_MSG2_TEXT 1033 "Death sentence! You may not judge me!"
LangString FF_MSG3_TEXT 2052 "我宣布，你已经不是我们中的一员了"
LangString FF_MSG3_TEXT 1033 "I hereby declare you are no longer one of us."

; ---- 按钮与复选框文案（中英双语）----
LangString FF_UN_CONFIRM_BTN 2052 "确认卸载"
LangString FF_UN_CONFIRM_BTN 1033 "Uninstall"
LangString FF_UN_KEEP_DATA 2052 "保留我的个人数据"
LangString FF_UN_KEEP_DATA 1033 "Keep my personal data"
LangString FF_UN_KEEP_HINT 2052 "设置 / 资料库 / 转录结果 全部保留"
LangString FF_UN_KEEP_HINT 1033 "Settings, library and transcriptions are all kept"

; 挽留页变量只属于卸载器上下文：必须用 BUILD_UNINSTALLER 包裹，
; 否则安装器编译也会声明这些 Var，但安装器从不引用 → NSIS 警告 6001
; "not referenced" → electron-builder 的 -WX（警告即错误）致命。
!ifdef BUILD_UNINSTALLER
Var FF_UnKeepData    ; 1 = 保留个人数据（默认）；0 = 彻底删除
Var FF_UnImg         ; 随机选中的挽留图片完整路径（$INSTDIR\resources\uninstall-N.bmp）
Var FF_UnMsg         ; 随机选中的挽留文案
Var FF_UnCheckbox    ; 「保留个人数据」复选框句柄（SHOW 阶段创建）
Var FF_UnPicBmp      ; SHOW 阶段随机替换的表情包位图句柄（DESTROYED 阶段释放）
Var FF_UnBmW         ; 表情包原生宽度（SHOW 阶段读 BITMAP 结构得到）
Var FF_UnBmH         ; 表情包原生高度
Var FF_UnNewX        ; 文本列新起点 X（= 图片宽 + 间距）
!endif

; 卸载器初始化：默认保留数据；随机选中挽留图片/文案；
; 加载卸载界面字体（PostMessage 异步广播，避免 SendMessage 卡死）
!macro customUnInit
  StrCpy $FF_UnKeepData 1
  ; 随机 1..3：GetTickCount 取模，先 +3 再 %3 规避 NSIS 有符号取模的负数结果
  System::Call "kernel32::GetTickCount() i.r0"
  IntOp $0 $0 % 3
  IntOp $0 $0 + 3
  IntOp $0 $0 % 3
  IntOp $0 $0 + 1
  StrCpy $FF_UnImg "$INSTDIR\resources\uninstall-$0.bmp"
  ${Switch} $0
    ${Case} 1
      StrCpy $FF_UnMsg "$(FF_MSG1_TEXT)"
      ${Break}
    ${Case} 2
      StrCpy $FF_UnMsg "$(FF_MSG2_TEXT)"
      ${Break}
    ${Default}
      StrCpy $FF_UnMsg "$(FF_MSG3_TEXT)"
  ${EndSwitch}

  ; 加载卸载界面字体（随包分发到 $INSTDIR\resources\HYWenHei.ttf），
  ; 使卸载挽留页与卸载进度页整体使用汉仪文黑
  System::Call "gdi32::AddFontResource(t '$INSTDIR\resources\HYWenHei.ttf') i.r0"
  ${If} $0 > 0
    ; 与安装器同源卡死：SendMessage HWND_BROADCAST(0xFFFF) 会同步等**所有**顶层窗口处理，
    ; 遇无响应窗口（如 runAfterFinish 启动的应用尚未就绪）即永久阻塞。卸载器在这里广播，
    ; 时机早于任何页面创建 → 卡住即"进程在跑但永远无窗口"。改 PostMessage 异步广播。
    System::Call "user32::PostMessage(i 0xFFFF, i 0x001D, i 0, i 0)"
  ${EndIf}
!macroend

; 卸载挽留确认页 —— 替换 electron-builder 默认卸载欢迎页（customUnWelcomePage
; 位于卸载开始之前、INSTFILES 进度页之前，此刻用户仍可取消卸载）。
; MUI_UNPAGE_WELCOME：位图随包内嵌进卸载器 exe（$PLUGINSDIR\modern-wizard.bmp，
; 无 $INSTDIR 依赖，天然可靠）；SHOW 阶段再随机换图，失败自动回退内嵌默认图。
!macro customUnWelcomePage
  ; 卸载欢迎页标题/文本与安装器同名 define（MUI2 共享），必须先 !undef 再重定义，
  ; 否则重复 !define 触发警告 → electron-builder -WX 致命。
  !ifdef MUI_WELCOMEPAGE_TITLE
    !undef MUI_WELCOMEPAGE_TITLE
  !endif
  !ifdef MUI_WELCOMEPAGE_TEXT
    !undef MUI_WELCOMEPAGE_TEXT
  !endif
  !define MUI_WELCOMEPAGE_TITLE "$(FF_UN_CONFIRM_TITLE)"
  !define MUI_WELCOMEPAGE_TEXT "$(FF_UN_KEEP_HINT)"

  ; 注意：MUI_UNWELCOMEFINISHPAGE_BITMAP 由 electron-builder 自动定义（-D），
  ; 这里**不能**再 !define（会 "already defined" 报错）。位图占位用它的默认图，
  ; SHOW 阶段用 $INSTDIR\resources\uninstall-N.bmp 随机换图（见 un.FF_UnConfShow）。
  ; 位图按原生尺寸绘制：不拉伸不裁切（否则方形 meme 进竖版槽会被拉变形或裁掉）
  !define MUI_UNWELCOMEFINISHPAGE_BITMAP_STRETCH NoStretchNoCrop

  ; ---- 挽留页改用白色背景 ----
  ; 表情包是白底贴纸，白底页面才能让白底与页面融为一体（深底会露出白方块）。
  ; 这里在卸载器编译上下文重定义（安装器页面已按深色编译完毕，不受影响）。
  !ifdef MUI_BGCOLOR
    !undef MUI_BGCOLOR
  !endif
  !define MUI_BGCOLOR "ffffff"
  !ifdef MUI_TEXTCOLOR
    !undef MUI_TEXTCOLOR
  !endif
  !define MUI_TEXTCOLOR "24354a"

  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.FF_UnConfShow
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE un.FF_UnConfLeave
  !define MUI_PAGE_CUSTOMFUNCTION_DESTROYED un.FF_UnConfDestroyed
  !insertmacro MUI_UNPAGE_WELCOME

  ; MUI 在展示前调用 SHOW：控件均已创建，此时换图/改文案/加复选框/改按钮名
  Function un.FF_UnConfShow
    ; 随机表情包：原生尺寸显示（不缩放不裁切）。图片控件精确 resize 到位图尺寸，
    ; 标题/正文/复选框右移避让。加载失败则保留内嵌默认图，绝不因缺图报错。
    StrCpy $FF_UnPicBmp 0
    System::Call "user32::LoadImage(p0, t'$FF_UnImg', i0, i0, i0, i0x10) p.r0"
    ${If} $0 <> 0
      StrCpy $FF_UnPicBmp $0

      ; 读位图原生宽高（BITMAP 结构：bmWidth@4, bmHeight@8）
      System::Alloc 24
      Pop $R1
      System::Call "gdi32::GetObject(p$0, i24, p$R1)"
      System::Call "*$R1(i.R2, i.R3, i.R4)"
      StrCpy $FF_UnBmW $R3
      StrCpy $FF_UnBmH $R4
      System::Free $R1

      ; 图片控件 → 原生尺寸（子窗口 SetWindowPos 用父客户区坐标，(0,0) 左上角）
      System::Call "user32::SetWindowPos(p$mui.WelcomePage.Image, p0, i0, i0, i$FF_UnBmW, i$FF_UnBmH, i0x14)"

      ; 文本列起点 X = 图片宽 + 12px
      IntOp $FF_UnNewX $FF_UnBmW + 12

      ; 标题右移（仅改 X，保持 Y 与尺寸；0x15 = NOSIZE|NOZORDER|NOACTIVATE）
      System::Alloc 16
      Pop $R6
      System::Call "user32::GetWindowRect(p$mui.WelcomePage.Title, p$R6)"
      System::Call "user32::MapWindowPoints(p0, p$HWNDPARENT, p$R6, i2)"
      System::Call "*$R6(i.R2, i.R3, i.R4, i.R5)"
      System::Call "user32::SetWindowPos(p$mui.WelcomePage.Title, p0, i$FF_UnNewX, i$R3, i0, i0, i0x15)"
      System::Free $R6

      ; 正文右移
      System::Alloc 16
      Pop $R6
      System::Call "user32::GetWindowRect(p$mui.WelcomePage.Text, p$R6)"
      System::Call "user32::MapWindowPoints(p0, p$HWNDPARENT, p$R6, i2)"
      System::Call "*$R6(i.R2, i.R3, i.R4, i.R5)"
      System::Call "user32::SetWindowPos(p$mui.WelcomePage.Text, p0, i$FF_UnNewX, i$R3, i0, i0, i0x15)"
      System::Free $R6

      ; 换上随机表情包
      SendMessage $mui.WelcomePage.Image ${STM_SETIMAGE} 0 $FF_UnPicBmp
    ${EndIf}

    ; 正文 = 随机挽留文案 + 数据保留提示
    SendMessage $mui.WelcomePage.Text ${WM_SETTEXT} 0 "STR:$FF_UnMsg$\r$\n$\r$\n$(FF_UN_KEEP_HINT)"

    ; 「保留个人数据」复选框（默认勾选）：白底深字；有图时右移到文本列
    ${NSD_CreateCheckBox} 120u 140u 195u 14u "$(FF_UN_KEEP_DATA)"
    Pop $FF_UnCheckbox
    SetCtlColors $FF_UnCheckbox "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"
    ${NSD_SetState} $FF_UnCheckbox ${BST_CHECKED}
    ${If} $FF_UnPicBmp <> 0
      System::Alloc 16
      Pop $R6
      System::Call "user32::GetWindowRect(p$FF_UnCheckbox, p$R6)"
      System::Call "user32::MapWindowPoints(p0, p$HWNDPARENT, p$R6, i2)"
      System::Call "*$R6(i.R2, i.R3, i.R4, i.R5)"
      System::Call "user32::SetWindowPos(p$FF_UnCheckbox, p0, i$FF_UnNewX, i$R3, i0, i0, i0x15)"
      System::Free $R6
    ${EndIf}

    ; 下一步按钮 → 「确认卸载」
    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${WM_SETTEXT} 0 "STR:$(FF_UN_CONFIRM_BTN)"
  FunctionEnd

  Function un.FF_UnConfDestroyed
    ; 释放 SHOW 阶段换上的随机表情包位图（MUI 自带默认图由 MUI 自己释放）
    ${If} $FF_UnPicBmp <> 0
      ${NSD_FreeImage} $FF_UnPicBmp
      StrCpy $FF_UnPicBmp 0
    ${EndIf}
  FunctionEnd

  Function un.FF_UnConfLeave
    ; 读取复选框：勾选=保留数据；读取失败时保守按保留处理（绝不误删用户数据）
    ${NSD_GetState} $FF_UnCheckbox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $FF_UnKeepData 1
    ${ElseIf} $0 == ${BST_UNCHECKED}
      StrCpy $FF_UnKeepData 0
    ${Else}
      StrCpy $FF_UnKeepData 1
    ${EndIf}
  FunctionEnd
!macroend

; electron-builder 的 customRemoveFiles 钩子一旦定义会**完全替换**默认的文件删除逻辑
; （包括 RMDir /r $INSTDIR），因此这里必须先删程序目录，再按勾选状态清理用户数据。
; 勾选“保留数据”（默认）→ 仅卸载程序，个人资料 / 歌单 / 转录结果不动；
; 取消勾选 → 纯净卸载，连同 userData 一并删除。
!macro customRemoveFiles
  ; 卸载器 CWD 默认是 $INSTDIR：Windows 会锁住当前目录，RMDir 只能删内容删不掉目录本身
  ; → 先 SetOutPath 移出，再 RMDir 才能把空目录一并删除（否则卸载后留空文件夹）。
  SetOutPath "$TEMP"
  RMDir /r $INSTDIR
  ${If} $FF_UnKeepData == 0
    RMDir /r "$APPDATA\fufumidi"
    RMDir /r "$APPDATA\FuFumidi"
  ${EndIf}
!macroend
