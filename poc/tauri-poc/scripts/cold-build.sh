#!/usr/bin/env bash
# FuFumidi Tauri POC —— 冷构建计时（只写入 poc/tauri-poc 下的日志）
set -o pipefail
export CARGO_TERM_COLOR=never

cd "$(dirname "$0")/.." || exit 1
LOG=cold-build.log
: > "$LOG"

mark() { echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$LOG"; }

mark "PWD=$(pwd)"
mark "rustc=$(rustc --version)"
mark "cargo=$(cargo --version)"
mark "cpus=$(nproc 2>/dev/null || echo unknown)"

T0=$(date +%s)
mark "FETCH_START"
cargo fetch >> "$LOG" 2>&1
FETCH_RC=$?
T1=$(date +%s)
mark "FETCH_DONE rc=$FETCH_RC seconds=$((T1-T0))"

mark "CHECK_START"
cargo check >> "$LOG" 2>&1
CHECK_RC=$?
T2=$(date +%s)
mark "CHECK_DONE rc=$CHECK_RC seconds=$((T2-T1))"

mark "BUILD_START"
cargo build >> "$LOG" 2>&1
BUILD_RC=$?
T3=$(date +%s)
mark "BUILD_DONE rc=$BUILD_RC seconds=$((T3-T2))"

mark "TOTAL_SECONDS(no fetch)=$((T3-T1))"
mark "TOTAL_SECONDS_ALL=$((T3-T0))"
if [ -f target/debug/tauri-poc.exe ]; then
  mark "EXE_BYTES=$(stat -c %s target/debug/tauri-poc.exe)"
else
  mark "EXE_MISSING"
fi
mark "TARGET_DIR_BYTES=$(du -sb target 2>/dev/null | cut -f1)"
exit 0
