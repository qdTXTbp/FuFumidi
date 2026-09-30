@echo off
REM ============================================================
REM FuFumidi 未打包版启动脚本（开发/测试用）
REM ------------------------------------------------------------
REM 直接以源码方式启动 Electron 应用，不生成安装包，
REM 便于快速验证改动（含最新的 DiffSinger 声库目录板块）。
REM
REM 用法：双击本文件，或在命令行执行 run-dev.cmd
REM ============================================================
setlocal
cd /d "%~dp0"

REM 关键：清掉 ELECTRON_RUN_AS_NODE，否则 Electron 会退化成纯 Node，
REM 导致 app 为 undefined（报 setAppUserModelId 读取失败）。
set "ELECTRON_RUN_AS_NODE="

echo [FuFumidi] 检查前端构建产物 ...
if not exist "renderer\dist\index.html" (
  echo [FuFumidi] renderer/dist 缺失，正在构建前端 ...
  call npm --prefix frontend run build
  if errorlevel 1 (
    echo [FuFumidi] 前端构建失败，已中止。
    pause
    exit /b 1
  )
)

echo [FuFumidi] 启动 Electron（未打包模式）...
"node_modules\electron\dist\electron.exe" .
set CODE=%errorlevel%
echo [FuFumidi] 已退出，代码 %CODE%
pause
endlocal
