// 音符瀑布渲染的纯逻辑单测：块构建的不变量、每帧窗口裁剪、能量度量。
// 绘制用假 ctx 记录调用 —— 只要不碰 roundRect 补丁与 getComputedStyle（都有环境守卫），
// viz.js 可以在 node 里直接跑。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVizBlocks, visibleRange, drawVizWaterfall, rmsAt, rmsFromBytes, smoothEnergy } from '../src/core/viz.js';

const TPS = 1000; // baseSec：1000 tick = 1 秒

function makeSong(tracks) {
  return {
    initialBpm: 120,
    tempoMap: [{ sec: 0, us: 500000 }],
    sigMap: [{ tick: 0, num: 4, den: 4 }],
    tracks: tracks.map((notes, i) => ({ index: i, notes })),
    baseSec: (tk) => tk / TPS,
  };
}

// 假 2D 上下文：只记录 roundRect（音符块与琴键都用它画），并记下调用时的填充色
function fakeCtx() {
  const rects = [];
  const gradient = { addColorStop() {} };
  const ctx = {
    fillStyle: null, strokeStyle: null, lineWidth: 1, font: '', textAlign: '', textBaseline: '',
    globalAlpha: 1, shadowBlur: 0, shadowColor: null,
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, arc() {}, fillText() {},
    roundRect(x, y, w, h) { rects.push({ x, y, w, h, fill: ctx.fillStyle, alpha: ctx.globalAlpha }); },
  };
  return { ctx, rects };
}

/* ---------------- buildVizBlocks ---------------- */

test('buildVizBlocks 把同音高首尾相接的音符合并，力度取组内最大', () => {
  const song = makeSong([[
    { midi: 60, start: 0, end: 1000, vel: 80 },
    { midi: 60, start: 1000, end: 2000, vel: 110 },
    { midi: 60, start: 5000, end: 6000, vel: 70 },
    { midi: 64, start: 0, end: 1000, vel: 90 },
  ]]);
  const { byPitch, centerPitch, total } = buildVizBlocks(song);
  assert.equal(total, 4);
  assert.equal(centerPitch, 61); // (60+60+60+64)/4
  const p60 = byPitch.get(60);
  assert.equal(p60.length, 2, '前两个音符相接应合成一块');
  assert.equal(p60[0].start, 0);
  assert.equal(p60[0].end, 2);
  assert.equal(p60[0].vel, 110, '合并后保留组内最大力度');
  assert.deepEqual([p60[1].start, p60[1].end], [5, 6], '隔开的音符仍是独立块');
  assert.equal(byPitch.get(64).length, 1);
});

test('buildVizBlocks 维持「按 start 升序、互不重叠、end 单调」这一二分依赖的不变量', () => {
  // 确定性伪随机铺音符，专门制造大量重叠/嵌套，验证不变量在乱序输入下仍成立
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const notes = [];
  for (let i = 0; i < 400; i++) {
    const start = Math.round(rnd() * 20000);
    notes.push({ midi: 55 + (i % 13), start, end: start + Math.round(rnd() * 900) + 1, vel: 60 + (i % 60) });
  }
  const { byPitch } = buildVizBlocks(makeSong([notes]));
  let checked = 0;
  for (const arr of byPitch.values()) {
    for (let i = 1; i < arr.length; i++) {
      assert.ok(arr[i].start >= arr[i - 1].start, 'start 必须升序');
      assert.ok(arr[i].end >= arr[i - 1].end, 'end 必须单调 —— 否则二分裁剪会漏块');
      assert.ok(arr[i].start > arr[i - 1].end, '块之间不能重叠');
      checked++;
    }
  }
  assert.ok(checked > 100, '样本量太小，起不到回归护栏作用');
});

/* ---------------- visibleRange ---------------- */

test('visibleRange 只取一屏之内、且不丢跨屏长音', () => {
  const arr = [
    { start: 0, end: 0.5 },
    { start: 10, end: 10.5 },
    { start: 20, end: 20.5 },
  ];
  assert.deepEqual(visibleRange(arr, 0, 5.33), { from: 0, to: 1 });
  assert.deepEqual(visibleRange(arr, 10, 5.33), { from: 1, to: 2 });
  assert.deepEqual(visibleRange(arr, 30, 5.33), { from: 3, to: 3 }, '全部已结束 → 空区间');
  assert.deepEqual(visibleRange(arr, -1, 5.33), { from: 0, to: 1 }, '起点之前只取屏内那块');
  // 长音起点远在窗口之前，但只要还没结束就必须留着（按 start 剪裁会把它剪掉）
  assert.deepEqual(visibleRange([{ start: 0, end: 100 }], 50, 5.33), { from: 0, to: 1 });
});

/* ---------------- 大曲目：单帧只处理屏内的少数块 ---------------- */

test('6 万音符的曲目单帧只处理屏内约 1% 的块（旧实现是全量重扫 + 全量绘制）', () => {
  // 6 万音符均匀铺在 600 秒里、轮转 25 个音高：每个音高 2400 块，间隔 0.25s 而时值 0.05s → 不合并
  const notes = [];
  for (let i = 0; i < 60000; i++) {
    const start = Math.round(i * 10); // 0.01s 一个（1000 tick/秒）
    notes.push({ midi: 48 + (i % 25), start, end: start + 50, vel: 90 });
  }
  const { byPitch, total } = buildVizBlocks(makeSong([notes]));
  assert.equal(total, 60000);
  let allBlocks = 0;
  for (const arr of byPitch.values()) allBlocks += arr.length;
  assert.equal(allBlocks, 60000, '时值互不重叠，应保持 1:1');

  const h = 400;
  const visSec = (h - Math.min(120, Math.round(0.2 * h))) / 60; // 320px ÷ 60px/秒 ≈ 5.33s
  let maxPerFrame = 0, sum = 0, frames = 0;
  for (let d = 0; d < 600; d += 0.5) {
    let n = 0;
    for (const arr of byPitch.values()) {
      const { from, to } = visibleRange(arr, d, visSec);
      n += to - from;
    }
    if (n > maxPerFrame) maxPerFrame = n;
    sum += n; frames++;
  }
  const avg = sum / frames;
  assert.ok(maxPerFrame < allBlocks * 0.02, `单帧最多只该碰 2% 的块，实测 ${maxPerFrame}/${allBlocks}`);
  assert.ok(avg > 0 && avg < allBlocks * 0.02, `平均单帧块数应远小于全量，实测 ${avg.toFixed(0)}/${allBlocks}`);
});

/* ---------------- 端到端：只画屏内的块 ---------------- */

test('drawVizWaterfall 每帧只绘制屏内音符块', () => {
  // 三个音高各三块：一块已划过、一块在屏内、一块还在屏外
  const song = makeSong([
    [{ midi: 60, start: 10000, end: 10500 }, { midi: 60, start: 100000, end: 100500 }, { midi: 60, start: 200000, end: 200500 }],
    [{ midi: 64, start: 99000, end: 99500 }, { midi: 64, start: 102000, end: 103000 }, { midi: 64, start: 205000, end: 206000 }],
    [{ midi: 67, start: 50000, end: 51000 }, { midi: 67, start: 104000, end: 105000 }, { midi: 67, start: 300000, end: 301000 }],
  ]);
  const { byPitch } = buildVizBlocks(song);

  const h = 400;
  const wN = h - Math.min(120, Math.round(0.2 * h)); // 320
  const visSec = wN / 60;                            // 120BPM 4/4 → 一小节 2 秒 = 120px
  const d = 100;

  // 期望值由纯函数算出，再与实际绘制调用对照
  let expected = 0;
  for (const arr of byPitch.values()) {
    const { from, to } = visibleRange(arr, d, visSec);
    expected += to - from;
  }
  assert.equal(expected, 3, '三个音高各应只剩屏内那一块');

  const { ctx, rects } = fakeCtx();
  drawVizWaterfall(ctx, 800, h, song, d * TPS, {
    state: {}, zoom: 1, colorScheme: 0, activeNotes: [], energy: 0,
  });

  // 琴键从 y === wN 起画，音符块的底边不会正好落在 wN 上（至少留 5px），
  // 据此把音符块与琴键的 roundRect 分开
  const firstKey = rects.findIndex(r => r.y === wN);
  assert.ok(firstKey > 0, '应当先画音符块、再画琴键');
  const noteRects = rects.slice(0, firstKey);
  assert.equal(noteRects.length, expected, '音符块的绘制次数应等于屏内块数');

  // 三个音高分属三条轨，颜色各不相同 —— 三个颜色都在，说明每档各画了自己那一块
  const colors = noteRects.map(r => r.fill).sort();
  assert.deepEqual(colors, ['#1456f0', '#ea5ec1', '#ff5530'].sort(), '应恰好画出三个音高的屏内块');
});

/* ---------------- 放大后：横向画布外的音高不再被绘制 ---------------- */

test('放大时落在可视音域之外的高/低音不再产生绘制', () => {
  // 三个音高：很低（21）、中间（60）、很高（108），时间上同处一屏
  const song = makeSong([
    [{ midi: 21, start: 0, end: 500 }],
    [{ midi: 60, start: 0, end: 500 }],
    [{ midi: 108, start: 0, end: 500 }],
  ]);
  const h = 400;
  const wN = h - Math.min(120, Math.round(0.2 * h));

  const draw = (zoom) => {
    const { ctx, rects } = fakeCtx();
    drawVizWaterfall(ctx, 800, h, song, 0, { state: {}, zoom, colorScheme: 0, activeNotes: [], energy: 0 });
    const firstKey = rects.findIndex(r => r.y === wN);
    return rects.slice(0, firstKey);
  };

  // zoom = 1：整个 88 键都在画布上，三个音高都该画
  assert.equal(draw(1).length, 3, 'zoom=1 时应画出全部三个音高');
  // zoom = 3：以全曲平均音高为中心只留 ~17 个白键，极低/极高音横向已在画布外
  const zoomed = draw(3);
  assert.equal(zoomed.length, 1, 'zoom=3 时只剩处于可视音域内那一个');
});

/* ---------------- 能量度量 ---------------- */

function fakeAudioBuf(samples, sampleRate = 1000) {
  return { sampleRate, getChannelData: () => Float32Array.from(samples) };
}

test('rmsAt 静音为 0、满幅接近 1，且随振幅单调', () => {
  const sr = 1000;
  const sec = (amp) => Array.from({ length: sr * 2 }, (_, i) => amp * Math.sin(2 * Math.PI * 10 * i / sr));
  assert.equal(rmsAt(fakeAudioBuf(sec(0), sr), 0.5), 0);
  const low = rmsAt(fakeAudioBuf(sec(0.05), sr), 0.5);
  const mid = rmsAt(fakeAudioBuf(sec(0.15), sr), 0.5);
  const loud = rmsAt(fakeAudioBuf(sec(0.5), sr), 0.5);
  assert.ok(low < mid && mid < loud, '振幅越大能量越大');
  assert.ok(loud > 0.9 && loud <= 1, '满幅应接近上限且不越界');
  assert.equal(rmsAt(null, 1), 0, '无音频缓冲时返回 0');
  assert.equal(rmsAt(fakeAudioBuf(sec(0.5), sr), 99), 0, '越界时刻返回 0');
});

test('rmsFromBytes 与 rmsAt 是同一度量（字节量化，128 为中点）', () => {
  const sr = 1000;
  const data = Float32Array.from({ length: sr * 2 }, (_, i) => 0.4 * Math.sin(2 * Math.PI * 10 * i / sr));
  const td = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    td[i] = Math.max(0, Math.min(255, Math.round(128 + data[i] * 128)));
  }
  const a = rmsAt(fakeAudioBuf(Array.from(data), sr), 0.5);
  const b = rmsFromBytes(td);
  assert.ok(Math.abs(a - b) < 0.05, `两条路径应给出接近的能量（${a} vs ${b}）`);
  assert.equal(rmsFromBytes(new Uint8Array(64).fill(128)), 0, '全 128 = 静音');
  assert.equal(rmsFromBytes(null), 0);
});

test('smoothEnergy 起音快、收音慢，并容忍未初始化的初值', () => {
  const up = smoothEnergy(0, 1);
  assert.ok(up > 0.4 && up < 1, '起音一步走完约一半');
  const down = smoothEnergy(1, 0);
  assert.ok(down < 1 && down > 0.9, '收音要慢得多');
  assert.equal(smoothEnergy(undefined, 0), 0);
  assert.equal(smoothEnergy(0.3, 1, 1, 1), 1, '系数为 1 时直接到位');
});
