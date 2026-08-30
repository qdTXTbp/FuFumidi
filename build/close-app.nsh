; ============================================================
; 安装器自定义脚本：安装前结束 FuFumidi 运行实例及其进程树
;
; 背景：
;   electron-builder 默认 NSIS 用 nsProcess::CloseProcess 软关闭应用，
;   但它只杀主进程(WM_CLOSE)、不杀进程树——引擎的 python worker /
;   update 更新器等子进程仍可能占用 resources/engine 文件，
;   导致覆盖安装时报「进程未关闭 / 文件占用」。
;
; 方案：在 customInit（安装器初始化后、写文件前）用 taskkill /f /t
;   强杀 FuFumidi 完整进程树，并短暂等待文件句柄释放，绕开占用检测。
; ============================================================
!macro customInit
  ; 等待上一版窗口被用户完整关闭后残留句柄释放（兜底）
  Sleep 1000
  ; 强杀主程序及其全部子进程树（含 python 引擎 worker / 更新器）
  nsExec::ExecToLog 'taskkill /f /t /im FuFumidi.exe'
  nsExec::ExecToLog 'taskkill /f /t /im FuFumidi.update.exe'
  ; 等待进程句柄与文件占用全部释放，避免紧接的文件写入失败
  Sleep 2000
!macroend