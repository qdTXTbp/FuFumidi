#!/usr/bin/env bash
# 冷 check / 冷 build / 增量 build 计时（写入 poc/tauri-poc/build-timing.log）
set -o pipefail
export CARGO_TERM_COLOR=never
cd "$(dirname "$0")/.." || exit 1
LOG=build-timing.log
: > "$LOG"
mark() { echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$LOG"; }

mark "== cargo check (cold = 无 target/) =="
T0=$(date +%s); cargo check >> "$LOG" 2>&1; RC=$?; T1=$(date +%s)
mark "CHECK rc=$RC seconds=$((T1-T0))"

mark "== cargo build (cold, debug) =="
T2=$(date +%s); cargo build >> "$LOG" 2>&1; RC=$?; T3=$(date +%s)
mark "BUILD rc=$RC seconds=$((T3-T2))"

if [ -f target/debug/tauri-poc.exe ]; then
  mark "EXE_BYTES=$(stat -c %s target/debug/tauri-poc.exe)"
  mark "EXE_MB=$(awk "BEGIN{printf \"%.1f\", $(stat -c %s target/debug/tauri-poc.exe)/1048576}")"
else
  mark "EXE_MISSING"
fi
mark "TARGET_BYTES=$(du -sb target 2>/dev/null | cut -f1)"
mark "TARGET_MB=$(du -sm target 2>/dev/null | cut -f1)"
mark "DEPS_ARTIFACTS=$(ls target/debug/deps 2>/dev/null | wc -l)"

mark "== incremental: touch src/main.rs 后 cargo build =="
touch src/main.rs
T4=$(date +%s); cargo build >> "$LOG" 2>&1; RC=$?; T5=$(date +%s)
mark "INCREMENTAL_BUILD rc=$RC seconds=$((T5-T4))"

mark "== incremental: cargo build 空跑（无改动）=="
T6=$(date +%s); cargo build >> "$LOG" 2>&1; RC=$?; T7=$(date +%s)
mark "NOOP_BUILD rc=$RC seconds=$((T7-T6))"

mark "== DONE =="
exit 0
