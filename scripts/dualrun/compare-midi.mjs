#!/usr/bin/env node
// ============================================================
// 双跑对拍器 · MIDI（S-003 / M0）
// ============================================================
// 目的：给 Rust 引擎（crates/fufumidi-core）与 JS 解析器（frontend/src/core/midi.js）
// 建立可执行的一致性门禁。任何一方改解析/统计逻辑，这里会先红。
//
// 用法：
//   node scripts/dualrun/compare-midi.mjs            # 对拍真实 fixture（engine/tests/quality）
//   node scripts/dualrun/compare-midi.mjs --gen     # 额外生成 12 个合成 MIDI 再对拍
//   node scripts/dualrun/compare-midi.mjs --require-rust  # 找不到 Rust 二进制时失败（CI 用）
//   node scripts/dualrun/compare-midi.mjs --rust-bin path/to/exe
//
// 对比字段：format / tracks / notes / min_midi / max_midi / avg_vel / avg_dur_ticks
// （BPM 暂不比：Rust 取首条 tempo，JS parseMidi 不展开 tempoMap。）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseMidi, encodeMidi } from '../../frontend/src/core/midi.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const GEN = argv.includes('--gen');
const REQUIRE = argv.includes('--require-rust');
const binArgIdx = argv.indexOf('--rust-bin');
const explicitBin = binArgIdx >= 0 ? argv[binArgIdx + 1] : null;

function findRustBin() {
  if (explicitBin) return path.resolve(ROOT, explicitBin);
  const cands = [
    'crates/target/release/fufumidi-engine.exe',
    'crates/target/debug/fufumidi-engine.exe',
    'crates/target/release/fufumidi-core.exe',
    'crates/target/debug/fufumidi-core.exe',
    'resources/rust-core/fufumidi-core.exe',
  ].map((p) => path.join(ROOT, p));
  for (const p of cands) { try { if (fs.statSync(p).isFile()) return p; } catch (e) { /* next */ } }
  return null;
}

function jsStats(file) {
  const bytes = fs.readFileSync(file);
  const mid = parseMidi(new Uint8Array(bytes));
  const notes = [];
  for (const tr of mid.tracks) for (const n of (tr.notes || [])) notes.push(n);
  const sum = (f) => notes.reduce((a, n) => a + f(n), 0);
  return {
    format: mid.format,
    tracks: mid.tracks.length,
    notes: notes.length,
    min_midi: notes.length ? Math.min(...notes.map((n) => n.midi)) : 0,
    max_midi: notes.length ? Math.max(...notes.map((n) => n.midi)) : 0,
    avg_vel: notes.length ? sum((n) => n.vel) / notes.length : 0,
    avg_dur_ticks: notes.length ? sum((n) => n.end - n.start) / notes.length : 0,
  };
}

// 合成 fixture：覆盖多轨/多通道/CC/bend/不同 division/空轨；不写进仓库（临时目录）。
function genFixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fufumidi-dualrun-'));
  let seed = 0x9e3779b9 >>> 0;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
  for (let i = 0; i < 12; i++) {
    const nTracks = 1 + Math.floor(rnd() * 4);
    const tracks = [];
    for (let t = 0; t < nTracks; t++) {
      const notes = [];
      const n = 4 + Math.floor(rnd() * 24);
      for (let k = 0; k < n; k++) {
        const start = Math.floor(rnd() * 1920) + k * 60;
        // 同轨同音高不重复：pitch 用 17 步长模 60（与 60 互素），避免 Rust/JS 对
        // 「同音高 note-on 叠在一起」的关闭策略不同而制造伪差异；真实重叠留给事件级对拍。
        const pitch = 36 + ((k * 17 + t * 11) % 60);
        notes.push({ start, end: start + 30 + Math.floor(rnd() * 240), midi: pitch, vel: 1 + Math.floor(rnd() * 126), ch: t });
      }
      tracks.push({
        name: 't' + t, ch: t, program: t % 8,
        notes,
        ccs: t % 2 ? [{ tick: 0, cc: 7, cv: 100, ch: t }, { tick: 480, cc: 11, cv: 64, ch: t }] : [],
        events: t % 3 === 0 ? [{ tick: 0, type: 'bend', val: 8192, ch: t }] : [],
      });
    }
    const bytes = encodeMidi(tracks, { division: [96, 240, 480, 960][i % 4], tempoMap: [{ tick: 0, bpm: 90 + (i % 5) * 10 }], sigMap: [{ tick: 0, num: [3, 4, 6, 7][i % 4], den: 4 }] });
    fs.writeFileSync(path.join(dir, 'gen-' + String(i).padStart(2, '0') + '.mid'), Buffer.from(bytes));
  }
  return dir;
}

function rustStatsForDir(bin, dir) {
  let out;
  try {
    out = execFileSync(bin, ['batch-stats', dir], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  } catch (e) {
    throw new Error('Rust 对拍器执行失败: ' + (e && e.message || e));
  }
  const j = JSON.parse(String(out || '{}'));
  if (!j || j.ok === false) throw new Error('Rust 返回非 ok: ' + String(out).slice(0, 200));
  const map = new Map();
  for (const f of (j.files || [])) map.set(path.basename(String(f.file || '')), f);
  return map;
}

function closeEnough(a, b, tol) { return Math.abs(Number(a) - Number(b)) <= tol; }

function compareMap(label, rustMap, dir) {
  const files = fs.readdirSync(dir).filter((f) => /\.midi?$/i.test(f)).sort();
  let checked = 0, failed = 0;
  for (const f of files) {
    const full = path.join(dir, f);
    const js = jsStats(full);
    const rs = rustMap.get(f);
    if (!rs) { console.error('[dualrun] MISSING rust stat: ' + f); failed += 1; continue; }
    const diffs = [];
    if (Number(rs.format) !== js.format) diffs.push('format ' + rs.format + '!=' + js.format);
    if (Number(rs.tracks) !== js.tracks) diffs.push('tracks ' + rs.tracks + '!=' + js.tracks);
    if (Number(rs.notes) !== js.notes) diffs.push('notes ' + rs.notes + '!=' + js.notes);
    if (Number(rs.min_midi) !== js.min_midi) diffs.push('min_midi ' + rs.min_midi + '!=' + js.min_midi);
    if (Number(rs.max_midi) !== js.max_midi) diffs.push('max_midi ' + rs.max_midi + '!=' + js.max_midi);
    // Rust 的 avg_vel 用 1 位小数打印（100.0/93.3），容差按打印精度取 0.06；
    // avg_dur_ticks 是旧 rust-core 没有的字段：没有就不比，等新 engine 补上后自动生效。
    if (!closeEnough(rs.avg_vel, js.avg_vel, 0.06)) diffs.push('avg_vel ' + rs.avg_vel + '!=' + js.avg_vel.toFixed(2));
    if (rs.avg_dur_ticks != null && !closeEnough(rs.avg_dur_ticks, js.avg_dur_ticks, 0.06)) diffs.push('avg_dur ' + rs.avg_dur_ticks + '!=' + js.avg_dur_ticks.toFixed(2));
    checked += 1;
    if (diffs.length) {
      failed += 1;
      console.error('[dualrun] FAIL ' + label + '/' + f + ': ' + diffs.join('; '));
    }
  }
  console.log('[dualrun] ' + label + ': ' + checked + ' files, ' + failed + ' failed');
  return failed;
}

const bin = findRustBin();
if (!bin) {
  const msg = '[dualrun] SKIP: 找不到 Rust 二进制（先跑 scripts/rust/build.ps1 或 cargo build）';
  if (REQUIRE) { console.error(msg + '（--require-rust）'); process.exit(1); }
  console.warn(msg);
  process.exit(0);
}
console.log('[dualrun] rust bin: ' + path.relative(ROOT, bin));

let failed = 0, total = 0;
const qualityDir = path.join(ROOT, 'engine/tests/quality');
if (fs.existsSync(qualityDir)) { failed += compareMap('engine/tests/quality', rustStatsForDir(bin, qualityDir), qualityDir); total += 1; }
if (GEN) {
  const dir = genFixtures();
  failed += compareMap('generated', rustStatsForDir(bin, dir), dir);
  total += 1;
}

if (failed) { console.error('[dualrun] FAILED: ' + failed + ' mismatches'); process.exit(1); }
console.log('[dualrun] OK: ' + total + ' directories，全部一致');
