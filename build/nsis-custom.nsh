; ============================================================
; nsis-custom.nsh —— FuFumidi 安装 / 卸载自定义脚本
;
; 1) preInit            安装前清理历史作用域残留的卸载注册表项
; 2) customUnInstall    卸载前询问是否保留用户数据
; 3) customRemoveFiles  删程序文件时跳过 FuFumidiData
;
; 为什么需要 2)3)：
;   数据目录就在安装目录里（<安装目录>\FuFumidiData，含模型 / 声库 /
;   音色库 / 曲库，动辄几个 GB），而卸载器默认会 RMDir /r $INSTDIR 一锅端，
;   用户卸载即等于把这些数据全删了。更新路径不受影响（走 isUpdated 分支）。
; ============================================================

; ---------- 1) 安装前清理残留卸载项 ----------
; Root cause (electron-builder assistedInstaller.nsh):
;   The installer checks BOTH HKCU and HKLM uninstall keys to detect
;   a previous installation. If the same app was installed at different
;   privilege scopes over time (per-user -> HKCU, admin -> HKLM), a stale
;   entry remains in the OTHER scope. The installer then thinks BOTH a
;   per-user and a per-machine installation exist -> ambiguous state ->
;   prompts "overwrite / reinstall" on every install.
;
; Fix:
;   preInit is the earliest hook in .onInit (installer.nsi line 56),
;   running before electron-builder's install-mode detection.
;   Delete the FuFumidi uninstall key from every scope, so the installer
;   always starts from a clean "no previous install" state.
;
; Note: the GUID is deterministically derived from appId (com.fufumidi.app)
; by electron-builder and stays identical across versions.
!macro preInit
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ee90ae64-4313-5a31-857b-d4c295bf71e7"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ee90ae64-4313-5a31-857b-d4c295bf71e7"
  DeleteRegKey HKLM "Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\ee90ae64-4313-5a31-857b-d4c295bf71e7"
!macroend

; ---------- 2) 已有 E 盘安装时，更新继续装回 E 盘 ----------
; 背景：6.2.4 的 NSIS 安装器默认安装到 Program Files；用户原本的
; E:\Midi\FuFumidi 便携安装被当成“另一份程序”，更新后数据根也跟着
; 切到 %APPDATA%，看起来模型/音色全丢。
; customInit 在 electron-builder 判定完安装模式之后、页面显示之前执行，
; 这里强制沿用已有的 E 盘安装目录并切回 current-user，避免更新再生成
; 一份 Program Files 副本，也避免触发管理员提权。
; 只有 E:\Midi\FuFumidi\FuFumidi.exe 已存在时才生效，不影响全新机器。
!macro customInit
  IfFileExists "E:\Midi\FuFumidi\FuFumidi.exe" 0 fu_keep_default_install
    StrCpy $INSTDIR "E:\Midi\FuFumidi"
    StrCpy $installMode "CurrentUser"
    StrCpy $hasPerMachineInstallation "0"
    StrCpy $hasPerUserInstallation "1"
    SetShellVarContext current
  fu_keep_default_install:
!macroend

; ---------- 2) 卸载首页：把「是否保留数据」做成一个**页面** ----------
; 这一步替换 electron-builder 默认的卸载欢迎页（assistedInstaller.nsh:67-71：
; 定义了 customUnWelcomePage 就不再插 MUI_UNPAGE_WELCOME）。
;
; 为什么不再用 MessageBox（原来的做法）：
;   · 用户看不到自己的数据在哪、多大、删了意味着什么，只有一个是/否；
;   · 只在"数据目录存在"时才弹，等于把最重要的选择藏在一个条件分支后面。
; 现在：默认选中「保留」，写明路径，并把选择交给卸载流程。
;
; ★ 为什么用 $PLUGINSDIR 里的 ini 传值、而不是全局变量：
;   nsis-custom.nsh 在**安装器**那一遍也会被 include，顶层 `Var` 会因为没人引用
;   触发 warning 6001，而 electron-builder 把警告当错误。两个宏各自声明变量、
;   用文件传递，就都避开了。（这也是原文件里 FU_KEEP_DATA 声明在宏内的原因。）
!macro customUnWelcomePage
  UninstPage custom un.fuUnWelcomeCreate un.fuUnWelcomeLeave
!macroend

; 页面本体只在卸载器那一遍里生成（BUILD_UNINSTALLER 由 electron-builder 定义）
!ifdef BUILD_UNINSTALLER
  !include nsDialogs.nsh
  !include LogicLib.nsh

  Var fuKeepRadioKeep
  Var fuKeepRadioDel

  Function un.fuUnWelcomeCreate
    ; ★ 这里**不能**用 !insertmacro MUI_HEADER_TEXT：electron-builder 把本文件
    ;   放在 MUI2.nsh **之前** include，卸载器那一遍走到这里时该宏还不存在 ——
    ;   实测报 "macro named MUI_HEADER_TEXT not found!"，整个 NSIS 装配直接失败。
    ;   所以标题由本页自己的 label 承担，不依赖 MUI2 的宏。
    InitPluginsDir
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ; ★ 布局（2026-10-14 修 KI-1）：nsDialogs 的静态控件**不会自适应高度**，
    ;   而 100% 宽度下中文每行约 17~19 字 —— 长句必然折行。所以每段按**行数**给高度：
    ;   单行 12u、两行 26u，段间留 4~8u，总高约 116u（对话框可用高度之内）。
    ;   教训：makensis 只查语法，排版必须目视（见 docs/known-issues.md KI-1）。
    ${NSD_CreateLabel} 0 0 100% 12u "卸载 FuFumidi —— 先决定已下载的数据怎么办"
    Pop $1
    ${NSD_CreateLabel} 0 16u 100% 26u "卸载会移除程序文件；下面这些是你自己的数据，删掉不可恢复："
    Pop $R0
    ${NSD_CreateLabel} 0 46u 100% 26u "数据位置（模型 / 声库 / 音色库 / 曲库 / 设置）：$\r$\n$INSTDIR\FuFumidiData"
    Pop $2

    ${NSD_CreateRadioButton} 0 78u 100% 12u "保留我的数据（推荐）—— 重装到同一目录后可继续使用"
    Pop $fuKeepRadioKeep
    ${NSD_CreateRadioButton} 0 94u 100% 12u "一并删除 —— 彻底清空，不可恢复"
    Pop $fuKeepRadioDel
    ${NSD_Check} $fuKeepRadioKeep

    ${IfNot} ${FileExists} "$INSTDIR\FuFumidiData\*.*"
      ${NSD_CreateLabel} 0 110u 100% 12u "（当前安装目录下没有 FuFumidiData，本页选择不会影响任何数据）"
      Pop $3
    ${EndIf}

    nsDialogs::Show
  FunctionEnd

  Function un.fuUnWelcomeLeave
    ; 单选按钮没勾上时默认按「保留」处理 —— 删数据是不可逆的那一侧，
    ; 默认值必须落在可恢复的一侧。
    StrCpy $0 "1"
    ${NSD_GetState} $fuKeepRadioDel $1
    ${If} $1 == ${BST_CHECKED}
      StrCpy $0 "0"
    ${EndIf}
    WriteINIStr "$PLUGINSDIR\fu-uninstall.ini" "uninstall" "keep" "$0"
  FunctionEnd
!endif

; 卸载流程读回页面上的选择。静默卸载（/S）不显示页面 → 文件不存在 → 按「保留」处理。
!macro customUnInstall
  Var /GLOBAL FU_KEEP_DATA
  StrCpy $FU_KEEP_DATA "1"
  ReadINIStr $0 "$PLUGINSDIR\fu-uninstall.ini" "uninstall" "keep"
  ${If} $0 == "0"
    StrCpy $FU_KEEP_DATA "0"
  ${EndIf}
  ${If} $FU_KEEP_DATA == "1"
    DetailPrint "已保留用户数据：$INSTDIR\FuFumidiData"
  ${Else}
    DetailPrint "将连同用户数据一起删除：$INSTDIR\FuFumidiData"
  ${EndIf}
!macroend

!macro customRemoveFiles
  ${if} ${isUpdated}
    ; 覆盖安装 / 应用内更新：保持 electron-builder 原行为
    ; （整体改名到 $PLUGINSDIR，失败可回滚，数据不会丢）
    CreateDirectory "$PLUGINSDIR\old-install"

    Push ""
    Call un.atomicRMDir
    Pop $R0

    ${if} $R0 != 0
      DetailPrint "File is busy, aborting: $R0"

      Push ""
      Call un.restoreFiles
      Pop $R0

      Abort `Can't rename "$INSTDIR" to "$PLUGINSDIR\old-install".`
    ${endif}
  ${else}
    ; Move out of $INSTDIR so it can be removed
    SetOutPath $TEMP
    ${if} $FU_KEEP_DATA == "1"
      ; 只删 FuFumidiData 之外的内容。
      ; 分两遍是官方 DeleteDir 的做法：边删目录边枚举会漏项。
      Push ""
      FindFirst $0 $1 "$INSTDIR\*.*"
    fu_scan:
      StrCmp $1 "" fu_scan_done
      StrCmp $1 "." fu_scan_next
      StrCmp $1 ".." fu_scan_next
      StrCmp $1 "FuFumidiData" fu_scan_next
      IfFileExists "$INSTDIR\$1\*.*" 0 fu_scan_file
        Push "$1"
        Goto fu_scan_next
    fu_scan_file:
      Delete "$INSTDIR\$1"
    fu_scan_next:
      FindNext $0 $1
      Goto fu_scan
    fu_scan_done:
      FindClose $0
    fu_purge:
      Pop $1
      StrCmp $1 "" fu_purge_done
      RMDir /r "$INSTDIR\$1"
      Goto fu_purge
    fu_purge_done:
      DetailPrint "已保留用户数据：$INSTDIR\FuFumidiData"
    ${else}
      RMDir /r $INSTDIR
    ${endif}
  ${endif}
!macroend
