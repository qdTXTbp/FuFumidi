; ============================================================
; installer.nsh 语法验证脚本（非交付物）—— 双上下文模拟
; 用法（配合 -WX 模拟 electron-builder 的“警告即错误”）：
;   makensis -WX -DBUILD_RESOURCES_DIR=F:\...\build _syntax_check.nsi      → 安装器上下文
;   makensis -WX -DBUILD_RESOURCES_DIR=F:\...\build -DBUILD_UNINSTALLER _syntax_check.nsi → 卸载器上下文
;
; 目的：捕获 installer.nsh 在“安装器编译”与“卸载器编译”两种场景下的
; 语法 / 警告错误（-WX 会把 6001 未引用变量、7025 未定义语言常量等当致命）。
; 仅做语法干跑，不产出安装包。验证后可删除。
; ============================================================
!include "MUI2.nsh"

!define APP_EXECUTABLE_FILENAME "FuFumidi.exe"

!include "installer.nsh"

!ifdef BUILD_UNINSTALLER
  ; ---- 卸载器上下文：BUILD_UNINSTALLER 已定义 → Var 声明生效 ----
  Function un.onInit
    !insertmacro customUnInit
  FunctionEnd
  !insertmacro customUnWelcomePage
  !insertmacro MUI_UNPAGE_INSTFILES

  Section "dummy"
    ; 至少一个 File 让 section 可执行，避免 -WX 下 6020 "no sections could be executed"
    File "${BUILD_RESOURCES_DIR}\installer-header.bmp"
    !insertmacro customRemoveFiles
    ; 卸载器上下文必须有 WriteUninstaller，否则 6020 "no uninstaller will be created"
    WriteUninstaller "$PLUGINSDIR\_syntax_uninstaller.exe"
  SectionEnd
!else
  ; ---- 安装器上下文：无 BUILD_UNINSTALLER → Var 声明被跳过 ----
  !insertmacro customWelcomePage
  !insertmacro MUI_PAGE_INSTFILES
  !insertmacro customFinishPage

  Section "dummy"
    File "${BUILD_RESOURCES_DIR}\installer-header.bmp"
  SectionEnd
!endif

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"
