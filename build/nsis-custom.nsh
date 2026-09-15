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

; ---------- 2)3) 卸载时保留用户数据 ----------
; 默认「保留」：删掉不可恢复，保留最多只是占空间。
; 静默卸载（/S，如脚本化卸载）不弹窗，一律按保留处理。
;
; 变量必须声明在宏里（与 electron-builder 的 isDeleteAppData 同理）：
; 安装器那一遍不插入这两个宏，声明放在文件顶层会报
; warning 6001「Variable not referenced」，而 electron-builder 把警告当错误。
!macro customUnInstall
  Var /GLOBAL FU_KEEP_DATA
  StrCpy $FU_KEEP_DATA "1"
  IfFileExists "$INSTDIR\FuFumidiData\*.*" 0 fu_keep_done
    ${if} ${Silent}
      Goto fu_keep_done
    ${endif}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
      "是否同时删除已下载的模型 / 声库 / 音色库 / 曲库？$\r$\n$\r$\n选择「否」将保留在 $INSTDIR\FuFumidiData，重装到同一目录后可继续使用。" \
      IDYES fu_keep_delete IDNO fu_keep_done
  fu_keep_delete:
    StrCpy $FU_KEEP_DATA "0"
  fu_keep_done:
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
