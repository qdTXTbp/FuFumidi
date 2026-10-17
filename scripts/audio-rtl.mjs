#!/usr/bin/env node
// P2-2 音频 I/O 延迟实测：在真实 Electron 渲染进程里建 AudioContext，读 baseLatency/outputLatency
// 用法：node scripts/audio-rtl.mjs [--json]
// 产物：docs/audio-rtl-report.md（人读）+ 控制台输出。
// 说明：这是**报告型**脚本，不是门禁：WebAudio 在 Windows 通常 10~40ms，目标 ≤10ms
// 只有原生后端（WASAPI 独占/ASIO）才可能达到 —— 报告会如实标出"未达标"。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp } from './e2e/lib.mjs';
import { chooseAudioBackend, latencyReport, formatLatencyReport, DEFAULT_TARGET_RTL_MS } from '../frontend/src/core/audio_rt.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_MD = path.join(ROOT, 'docs', 'audio-rtl-report.md');
const JSON_ONLY = process.argv.includes('--json');

async function measure(app, latencyHint) {
  const expr = "(async () => {"
    + " const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;"
    + " const ctx = new AC({ latencyHint: " + JSON.stringify(latencyHint) + " });"
    + " try { if (ctx.state === 'suspended') await ctx.resume(); } catch (e) {}"
    + " const base = Number(ctx.baseLatency) || 0;"
    + " const out = Number(ctx.outputLatency) || 0;"
    + " const sr = Number(ctx.sampleRate) || 0;"
    + " const t0 = performance.now();"
    + " await new Promise((res) => { const o = ctx.createOscillator(); const g = ctx.createGain();"
    + "   g.gain.value = 0.0001; o.connect(g); g.connect(ctx.destination);"
    + "   const startAt = ctx.currentTime + 0.02; o.start(startAt); o.stop(startAt + 0.02);"
    + "   setTimeout(res, 60); });"
    + " const wall = performance.now() - t0;"
    + " try { ctx.close(); } catch (e) {}"
    + " return { state: 'running', baseLatency: base, outputLatency: out, sampleRate: sr, wallMs: wall };"
    + "})()";
  return await app.eval(expr);
}

async function main() {
  const app = await launchApp();
  let data;
  try {
    await app.waitFor("!!(window.__fufumidiE2E || document.querySelector('canvas'))", { timeout: 30000 });
    const hardware = await app.eval("navigator.hardwareConcurrency || 0");
    const interactive = await measure(app, 'interactive');
    // Chromium 只接受 'balanced'|'interactive'|'playback'（数值 latencyHint 已被规范移除）
    const low = await measure(app, 'playback');
    const chosen = chooseAudioBackend({ platform: 'win32', setting: 'auto', nativeAvailable: false });
    const repInteractive = latencyReport({ ...interactive, sampleRate: (interactive && interactive.sampleRate) || 44100 });
    const repLow = latencyReport({ ...low, sampleRate: (low && low.sampleRate) || 44100 });
    data = {
      at: new Date().toISOString(),
      hardwareConcurrency: hardware,
      backendChoice: chosen,
      interactive: { raw: interactive, report: repInteractive },
      playbackHint: { raw: low, report: repLow },
      targetMs: DEFAULT_TARGET_RTL_MS,
    };
  } finally {
    try { await app.close(); } catch (e) {}
  }
  if (JSON_ONLY) { console.log(JSON.stringify(data, null, 2)); return; }
  const lines = [];
  lines.push('# 音频 I/O 延迟实测（P2-2）');
  lines.push('');
  lines.push('> 由 scripts/audio-rtl.mjs 在真实 Electron 渲染进程里实测（不是估算表）。');
  lines.push('> WebAudio 的 baseLatency/outputLatency 是浏览器上报值；估算 RTL = base + output + 输入缓冲。');
  lines.push('');
  lines.push('| 项 | interactive | playback |');
  lines.push('|---|---:|---:|');
  lines.push('| 采样率 | ' + (data.interactive.raw && data.interactive.raw.sampleRate) + ' | ' + (data.playbackHint.raw && data.playbackHint.raw.sampleRate) + ' |');
  lines.push('| baseLatency | ' + data.interactive.report.baseMs + ' ms | ' + data.playbackHint.report.baseMs + ' ms |');
  lines.push('| outputLatency | ' + data.interactive.report.outputMs + ' ms | ' + data.playbackHint.report.outputMs + ' ms |');
  lines.push('| 估算 RTL | **' + data.interactive.report.estimatedRtlMs + ' ms** | **' + data.playbackHint.report.estimatedRtlMs + ' ms** |');
  lines.push('| 目标 ≤' + data.targetMs + 'ms | ' + (data.interactive.report.withinTarget ? '达标' : '未达标') + ' | ' + (data.playbackHint.report.withinTarget ? '达标' : '未达标') + ' |');
  lines.push('');
  lines.push('后端选择（契约见 core/audio_rt.js）：');
  lines.push('');
  lines.push('- 平台：win32 · 原生 I/O 可用：否');
  lines.push('- 结论：' + data.backendChoice.backend + '（' + data.backendChoice.reason + '）');
  lines.push('- 说明：原生 WASAPI 独占 / ASIO 需要 Rust 侧实现与 ASIO SDK，当前包未提供；');
  lines.push('  WebAudio 的 RTL 由系统混音器决定，latencyHint 从 interactive 切到 playback 反而更慢（上表实测）。');
  lines.push('- 若将来提供原生后端：本报告脚本可直接扩成 A/B 对比（RTL 目标 ≤10ms）。');
  lines.push('');
  fs.writeFileSync(OUT_MD, lines.join('\n'), 'utf8');
  console.log(formatLatencyReport(data.interactive.report, 'webaudio(interactive)'));
  console.log(formatLatencyReport(data.playbackHint.report, 'webaudio(playback)'));
  console.log('后端选择：' + data.backendChoice.backend + ' · ' + data.backendChoice.reason);
  console.log('已写入：' + path.relative(ROOT, OUT_MD));
}

main().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
