#!/usr/bin/env bash
# 干净的冷构建计时：rm -rf target 后 check → build → noop build
set -o pipefail
export CARGO_TERM_COLOR=never
cd "$(dirname "$0")/.." || exit 1
LOG=cold-timing.log
: > "$LOG"
mark() { echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$LOG"; }

mark "rustc=$(rustc --version) | cargo=$(cargo --version) | cpus=$(nproc)"
mark "crate_count=$(grep -c '^name = ' Cargo.lock)"
mark "CLEAN start (rm -rf target)"
rm -rf target
T0=$(date +%s)
cargo check >> "$LOG" 2>&1; CHECK_RC=$?
T1=$(date +%s)
mark "COLD_CHECK rc=$CHECK_RC seconds=$((T1-T0))"

cargo build >> "$LOG" 2>&1; BUILD_RC=$?
T2=$(date +%s)
mark "COLD_BUILD rc=$BUILD_RC seconds=$((T2-T1))"

if [ -f target/debug/tauri-poc.exe ]; then
  B=$(stat -c %s target/debug/tauri-poc.exe)
  mark "EXE_BYTES=$B EXE_MB=$(awk "BEGIN{printf \"%.2f\", $B/1048576}")"
else
  mark "EXE_MISSING"
fi
mark "TARGET_MB=$(du -sm target | cut -f1) DEPS_FILES=$(ls target/debug/deps | wc -l)"

cargo build >> "$LOG" 2>&1; T3=$(date +%s)
mark "NOOP_BUILD rc=$? seconds=$((T3-T2))"
mark "COLD_TOTAL_SECONDS=$((T2-T0))"
mark "DONE"
exit 0
