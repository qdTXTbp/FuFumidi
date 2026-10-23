#!/usr/bin/env node
// P1-10 性能基线：启动 / 视图切换 / 帧时间 / 堆内存（CDP 实测，不是估算）
// 用法：
//   node scripts/perf-baseline.mjs                 # 跑一次并对比 docs/perf-baseline.json（超预算失败）
//   node scripts/perf-baseline.mjs --update-baseline  # 记录/更新基线（换机器或大改后手动跑）
//   node scripts/perf-baseline.mjs --json          # 只打印 JSON（脚本消费）
//
// 预算口径（相对基线留 25% 抖动；绝对值兜底）：
//   startupMs      冷启动到测试钩子可用的毫秒数
//   switchColdMs   首次进入各视图的毫秒数（懒加载分包在这里）
//   switchWarmMs   已加载后再进入的毫秒数（预算 p95 < 100ms 的原口径）
//   frameP95Ms     60k 音符曲目播放时的 rAF 帧间隔 p95（60fps ≈ 16.7ms）
//   heapGrowthPct  首屏→加载 60k 曲目后的 JS 堆增长
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { launchApp } from './e2e/lib.mjs';
import { encodeMidi } from '../frontend/src/core/midi.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BASELINE_FILE = path.join(ROOT, 'docs', 'perf-baseline.json');
const REPORT_FILE = path.join(ROOT, 'docs', 'perf-report.md');
const argv = process.argv.slice(2);
const UPDATE = argv.includes('--update-baseline');
const JSON_ONLY = argv.includes('--json');

const BIG_NOTES = 60000;
const SAMPLE_FRAMES = 180;

function log(...a) { if (!JSON_ONLY) console.log(...a); }

/** 生成 60k 音符曲目（4 轨；纯数据，不读磁盘） */
function buildBigMidi() {
  const tracks = [];
  const perTrack = Math.floor(BIG_NOTES / 4);
  for (let t = 0; t < 4; t++) {
    const notes = [];
    for (let i = 0; i < perTrack; i++) {
      notes.push({ start: i * 60, end: i * 60 + 45, midi: 48 + ((i * 7 + t * 5) % 36), vel: 80, ch: t });
    }
    tracks.push({ name: 'perf-' + (t + 1), ch: t, program: t === 0 ? 0 : 33, notes, ccs: [], events: [] });
  }
  return Array.from(encodeMidi(tracks, { division: 480 }));
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.round((p / 100) * (a.length - 1))))];
}
function round(v, d = 1) { return Math.round(v * Math.pow(10, d)) / Math.pow(10, d); }

const SWITCHES = [
  { hash: '#/home', marker: '导入到曲库' },
  { hash: '#/music', marker: 'MIDI 歌单' },
  { hash: '#/views', marker: '可视化' },
  { hash: '#/resources', marker: '模型管理' },
];

async function measureSwitch(app, item) {
  const t = Date.now();
  await app.navigate(item.hash);
  // 等 hash 到位 + 目标视图特征文本出现，再等两帧真正画完（避免量到上一页残留 DOM）
  await app.waitFor('location.hash.indexOf(' + JSON.stringify(item.hash) + ') >= 0'
    + ' && document.body.innerText.indexOf(' + JSON.stringify(item.marker) + ') >= 0', { timeout: 30000 });
  await app.eval('new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res(true))))');
  return Date.now() - t;
}

async function sampleFrames(app) {
  const out = await app.eval('(async () => { const arr = []; let last = performance.now();'
    + ' await new Promise((res) => { const tick = (now) => { arr.push(now - last); last = now;'
    + ' if (arr.length < ' + SAMPLE_FRAMES + ') requestAnimationFrame(tick); else res(); }; requestAnimationFrame(tick); });'
    + ' return arr; })()');
  return Array.isArray(out) ? out : [];
}

async function heapMB(app) {
  const v = await app.eval('(performance.memory ? performance.memory.usedJSHeapSize : 0)');
  return round(Number(v || 0) / (1024 * 1024), 1);
}

function loadBaseline() {
  try { return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')); } catch (e) { return null; }
}

async function main() {
  const tSpawn = Date.now();
  // precise-memory：Chromium 默认把 performance.memory 量化到 ~10MB 粒度，堆增长会失真
  const app = await launchApp({ args: ['--enable-precise-memory-info'] });
  let result = null;
  try {
    await app.waitFor('!!(window.__fufumidiE2E)', { timeout: 90000 });
    const startupMs = Date.now() - tSpawn;
    const heapStartMB = await heapMB(app);

    // 首屏（home）已就绪；先冷切一轮
    const switchCold = [];
    for (const item of SWITCHES) switchCold.push({ view: item.hash, ms: await measureSwitch(app, item) });
    // 再热切一轮
    const switchWarm = [];
    for (const item of SWITCHES) switchWarm.push({ view: item.hash, ms: await measureSwitch(app, item) });

    // 导入 60k 音符 → 进入编辑页 → 播放采样帧间隔
    const bigMidi = buildBigMidi();
    await app.eval('window.__fufumidiE2E.importMidi("perf-60k.mid", ' + JSON.stringify(bigMidi) + ')');
    await app.waitFor('!!window.__fufumidiE2E.hasSong()', { timeout: 60000 });
    await app.waitFor('(() => { const s = window.__fufumidiE2E.song(); if (!s) return false;'
      + ' let n = 0; for (const t of (s.tracks || [])) n += (t.notes ? t.notes.length : 0);'
      + ' window.__perfNotes = n; return n >= ' + Math.floor(BIG_NOTES * 0.9) + '; })()',
      { timeout: 60000, message: '60k 音符装载完成' });
    const notesLoaded = Number(await app.eval('window.__perfNotes || 0'));
    const tEdit = Date.now();
    await app.navigate('#/edit');
    await app.waitFor('!!document.querySelector("canvas")', { timeout: 60000 });
    const editColdMs = Date.now() - tEdit;
    await new Promise((r) => setTimeout(r, 800));
    const heapBigMB = await heapMB(app);

    // 播放时采样 rAF：点底部播放栏的播放键；确认真的播起来再采样
    try { await app.click('.tp-play'); } catch (e) {}
    await app.waitFor('(() => { const b = document.querySelector(".tp-play"); return !!b && b.classList.contains("playing"); })()', { timeout: 8000, message: '播放状态' });
    await new Promise((r) => setTimeout(r, 400));   // 跳过起播缓冲
    const frames = await sampleFrames(app);
    try { await app.click('.tp-play'); } catch (e) {}

    const frameP50 = pct(frames, 50);
    const frameP95 = pct(frames, 95);
    const coldP95 = pct(switchCold.map((x) => x.ms), 95);
    const warmP95 = pct(switchWarm.map((x) => x.ms), 95);
    const heapGrowthPct = heapStartMB > 0 ? round(((heapBigMB - heapStartMB) / heapStartMB) * 100, 1) : 0;

    result = {
      format: 'fufumidi-perf-baseline',
      notesLoaded,
      version: 1,
      updatedAt: new Date().toISOString(),
      env: {
        platform: process.platform + ' ' + os.release(),
        cpus: os.cpus().length,
        totalMemGB: round(os.totalmem() / (1024 ** 3), 1),
        node: process.version,
      },
      song: { notes: BIG_NOTES, tracks: 4 },
      startupMs: Math.max(0, startupMs),
      switches: { cold: switchCold, warm: switchWarm, coldP95: round(coldP95), warmP95: round(warmP95) },
      editColdMs,
      frames: { samples: frames.length, p50: round(frameP50), p95: round(frameP95) },
      heap: { startMB: heapStartMB, bigSongMB: heapBigMB, growthPct: heapGrowthPct },
    };
  } finally {
    try { await app.close(); } catch (e) {}
  }

  if (JSON_ONLY) { console.log(JSON.stringify(result, null, 2)); return; }

  log('性能基线 ' + result.updatedAt);
  log('  启动            ' + result.startupMs + ' ms');
  log('  视图切换 cold   p95 ' + result.switches.coldP95 + ' ms  (' + result.switches.cold.map((x) => x.ms).join('/') + ')');
  log('  视图切换 warm   p95 ' + result.switches.warmP95 + ' ms');
  log('  编辑页(60k)     ' + result.editColdMs + ' ms');
  log('  播放帧间隔      p50 ' + result.frames.p50 + ' ms · p95 ' + result.frames.p95 + ' ms（' + result.frames.samples + ' 帧）');
  log('  JS 堆           ' + result.heap.startMB + ' MB → ' + result.heap.bigSongMB + ' MB（+' + result.heap.growthPct + '%）');

  if (UPDATE) {
    fs.mkdirSync(path.dirname(BASELINE_FILE), { recursive: true });
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(result, null, 2) + '\n', 'utf8');
    const b = (v, floor) => Math.max(floor, Math.round(v * 1.25));
    const md = [
      '# 性能基线（P1-10）',
      '',
      '> 由 scripts/perf-baseline.mjs 实测生成（CDP 驱动真实应用，非估算）。机器不同数值会变；',
      '> 门禁按「基线 +25% 抖动」比较，换机器时用 --update-baseline 重记。',
      '',
      '| 指标 | 实测 | 预算（门禁） |',
      '|---|---:|---:|',
      '| 启动到可交互 | ' + result.startupMs + ' ms | ≤ ' + b(result.startupMs, 4000) + ' ms |',
      '| 视图切换 cold p95 | ' + result.switches.coldP95 + ' ms | ≤ ' + b(result.switches.coldP95, 1200) + ' ms |',
      '| 视图切换 warm p95 | ' + result.switches.warmP95 + ' ms | ≤ ' + b(result.switches.warmP95, 100) + ' ms |',
      '| 编辑页 60k 首次进入 | ' + result.editColdMs + ' ms | ≤ ' + b(result.editColdMs, 3000) + ' ms |',
      '| 播放帧间隔 p95 | ' + result.frames.p95 + ' ms | ≤ ' + b(result.frames.p95, 20) + ' ms |',
      '| JS 堆增长（首屏→60k） | +' + result.heap.growthPct + '%（≈ +' + round(result.heap.bigSongMB - result.heap.startMB, 1) + ' MB） | ≤ +' + b(result.heap.growthPct, 25) + '% |',
      '',
      '说明：',
      '- 帧间隔受显示器刷新率影响（120/144/240Hz 屏会显著低于 16.7ms）；「p95 ≤ 16.7ms（60fps）」只在 60Hz 屏成立，所以门禁取基线相对值。',
      '- JS 堆增长按同一场景相对比较；60k 音符 ≈ +34MB 属正常（音符对象 + 画布缓存）。',
      '- 冷切换含路由懒加载分包（首次进入资源中心最贵）；热切换反映纯渲染/挂载成本。',
      '',
      '环境：' + result.env.platform + ' · ' + result.env.cpus + ' 核 · ' + result.env.totalMemGB + ' GB · Node ' + result.env.node,
      '',
    ].join('\n');
    fs.writeFileSync(REPORT_FILE, md, 'utf8');
    log('已写入基线：' + path.relative(ROOT, BASELINE_FILE) + ' / ' + path.relative(ROOT, REPORT_FILE));
    return;
  }

  const base = loadBaseline();
  if (!base) {
    log('还没有 docs/perf-baseline.json；先跑 --update-baseline 记录一次基线。');
    process.exit(0);
  }
  const fails = [];
  const check = (name, cur, limit) => {
    const ok = cur <= limit;
    if (!ok) fails.push(name + ' ' + cur + ' > ' + limit);
    log('  ' + (ok ? '✓' : '✗') + ' ' + name + '：' + cur + '（预算 ' + limit + '）');
  };
  log('对比基线（' + base.updatedAt + '）');
  check('启动 ms', result.startupMs, Math.max(4000, Math.round(base.startupMs * 1.25)));
  check('视图切换 cold p95 ms', result.switches.coldP95, Math.max(1200, Math.round(base.switches.coldP95 * 1.25)));
  check('视图切换 warm p95 ms', result.switches.warmP95, Math.max(100, Math.round(base.switches.warmP95 * 1.25)));
  check('编辑页 60k ms', result.editColdMs, Math.max(3000, Math.round(base.editColdMs * 1.25)));
  check('播放帧间隔 p95 ms', result.frames.p95, Math.max(20, round(base.frames.p95 * 1.25)));
  check('堆增长 %', result.heap.growthPct, Math.max(25, round(base.heap.growthPct * 1.25)));
  if (fails.length) {
    console.error('性能门禁未通过：' + fails.join('；'));
    process.exit(1);
  }
  log('性能门禁通过');
}

main().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
