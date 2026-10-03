// 同步传输器的测试（Node 环境，用 Web Audio 的最小替身）。
//
// ★ 要验的三件事（都是"两个音频不同步"的常见成因）：
//   1. **同一个 when/offset 起播** —— 两条源必须拿到相同的调度参数
//   2. **暂停后从原位继续** —— pause 记位置、play 恢复到同一位置
//   3. **seek 要重建 source** —— AudioBufferSourceNode 是一次性的，
//      不能对已 start 的节点再 start
//
// 用一个假的 AudioContext 记录所有 source 的 start/stop 调用，
// 这样能直接断言"两条源拿到了同一个 when"。
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** 最小 AudioContext 替身：可手动推进 currentTime */
function makeFakeCtx() {
  const started = [];
  let now = 0;
  const mkBuf = (seconds, sr = 44100) => ({
    duration: seconds, sampleRate: sr, length: seconds * sr, numberOfChannels: 1,
    getChannelData: () => new Float32Array(seconds * sr),
  });
  const ctx = {
    get currentTime() { return now; },
    advance(s) { now += s; },
    _started: started,
    createBufferSource() {
      const node = {
        buffer: null, onended: null,
        _t: null,
        connect(n) { return n; },
        disconnect() {},
        start(when, offset, dur) { started.push({ node, when, offset, dur }); },
        stop() { node._stopped = true; },
      };
      return node;
    },
    createGain() {
      return {
        gain: {
          value: 1,
          setValueCurveAtTime(curve, when, dur) { ctx._curves.push({ kind: 'gain', curve, when, dur }); },
        },
        connect(n) { return n; },
        disconnect() {},
      };
    },
    createStereoPanner() {
      return {
        pan: {
          value: 0,
          setValueCurveAtTime(curve, when, dur) { ctx._curves.push({ kind: 'pan', curve, when, dur }); },
        },
        connect(n) { return n; },
        disconnect() {},
      };
    },
    _curves: [],                      // 记录所有 setValueCurveAtTime（自动化）
    _queue: [],                       // 按调用顺序给出时长（slice 会丢自定义属性）
    decodeAudioData() {
      const sec = ctx._queue.shift();
      return sec === 'bad'
        ? Promise.reject(new Error('unsupported codec'))
        : Promise.resolve(mkBuf(sec == null ? 10 : sec));
    },
    destination: {},
  };
  return ctx;
}

// 注入替身：sing_transport 从 '../audio.js' 取 ctx，这里直接改模块的 getCtx
import { SingTransport } from '../src/core/sing_transport.js';

function newTransport(ctx) { return new SingTransport(ctx); }

/** 造一段 wav 字节；时长通过 `ctx._queue` 按顺序喂给替身（见 makeFakeCtx） */
function fakeBytes(seconds) { void seconds; return new Uint8Array(4); }

/** 排好这一批的时长（与 items 顺序一一对应） */
function queue(ctx, ...secs) { ctx._queue.push(...secs); }

test('★ 两条源拿到**同一个 when / offset**（采样级同步的前提）', async () => {
  const ctx = makeFakeCtx();
  const t = newTransport(ctx);
  queue(ctx, 30, 20);
  await t.load([
    { label: '伴奏', bytes: fakeBytes(30) },
    { label: '人声', bytes: fakeBytes(20) },
  ]);
  assert.equal(t.lanes.length, 2, '两条 lane 都要装上');

  ctx._started.length = 0;
  t.play();

  assert.equal(ctx._started.length, 2, '两条源都要起播');
  const [a, b] = ctx._started;
  assert.equal(a.when, b.when, '★ when 必须完全相同（否则起播就不同步）');
  assert.equal(a.offset, b.offset, '★ offset 也要相同');
});

test('★ 三条以上轨同时起播（多轨混音：每条声部轨 + 伴奏都要发声）', async () => {
  const ctx = makeFakeCtx();
  const t = newTransport(ctx);
  queue(ctx, 40, 30, 25, 35);
  await t.load([
    { label: '伴奏', bytes: fakeBytes(40) },
    { label: '主旋律', bytes: fakeBytes(30), gainDb: 0, muted: false },
    { label: '和声', bytes: fakeBytes(25), gainDb: -6, muted: false },
    { label: '低音', bytes: fakeBytes(35), gainDb: 0, muted: true },
  ]);
  assert.equal(t.lanes.length, 4, '四条 lane 都要装上');

  ctx._started.length = 0;
  t.play();

  // ★ 静音的那条仍会建 source（增益为 0），这样"取消静音"不必重新解码
  assert.equal(ctx._started.length, 4, '四条源都要起播');
  const whens = new Set(ctx._started.map((s) => s.when));
  assert.equal(whens.size, 1, '★ 所有源必须拿到同一个 when');
  const offs = new Set(ctx._started.map((s) => s.offset));
  assert.equal(offs.size, 1, '★ 所有源的 offset 也要一致');
});

test('被静音的轨增益为 0，但仍在 lane 里（取消静音不用重新解码）', async () => {
  const ctx = makeFakeCtx();
  const t = newTransport(ctx);
  queue(ctx, 20, 20);
  await t.load([
    { label: '响的', bytes: fakeBytes(20), muted: false },
    { label: '静音', bytes: fakeBytes(20), muted: true },
  ]);
  assert.equal(t.lanes[0].muted, false);
  assert.equal(t.lanes[1].muted, true);
  assert.equal(SingTransport._gain(0), 1);
  assert.ok(SingTransport._gain(-6) < 1 && SingTransport._gain(-6) > 0);
});

test('★ 暂停后从**原位**继续（不是从 0）', async () => {
  const ctx = makeFakeCtx();
  const t = newTransport(ctx);
  queue(ctx, 30);
  await t.load([{ label: '伴奏', bytes: fakeBytes(30) }]);

  t.play(0);
  ctx.advance(3.0);                    // 播了 3 秒
  const before = t.positionMs;
  t.pause();
  assert.ok(before > 2900 && before < 3100, `暂停位置应≈3000ms，实际 ${before}`);

  ctx._started.length = 0;
  t.play();                            // 不传 fromMs → 从当前位置
  assert.ok(ctx._started.length >= 1, '要重新起播');
  const off = ctx._started[0].offset;
  assert.ok(off > 2.9 && off < 3.1, `★ 应从中断处 ≈3s 继续，实际 ${off}s`);
});

test('★ seek 必须**重建** source（AudioBufferSourceNode 一次性）', async () => {
  const ctx = makeFakeCtx();
  const t = newTransport(ctx);
  queue(ctx, 30);
  await t.load([{ label: '伴奏', bytes: fakeBytes(30) }]);

  t.play(0);
  const firstNodes = ctx._started.map(s => s.node);
  assert.equal(firstNodes.length, 1);

  ctx._started.length = 0;
  t.seek(8000);
  assert.equal(ctx._started.length, 1, 'seek 时要新建一条源');
  assert.notEqual(ctx._started[0].node, firstNodes[0], '★ 不能复用已 start 的节点');
  assert.ok(ctx._started[0].offset > 7.9, `应从 8s 起播，实际 ${ctx._started[0].offset}`);
});

test('seek 到暂停态不自动起播', async () => {
  const ctx = makeFakeCtx();
  const t = newTransport(ctx);
  queue(ctx, 30);
  await t.load([{ label: '伴奏', bytes: fakeBytes(30) }]);
  t.seek(5000);                         // 从未 play 过
  assert.equal(t.playing, false, 'seek 后仍应是暂停态');
  assert.equal(ctx._started.length, 0, '不该起播');
  assert.ok(t.positionMs > 4900 && t.positionMs < 5100, t.positionMs);
});

test('时长取各轨最大值；短轨播完后不再调度', async () => {
  const ctx = makeFakeCtx();
  const t = newTransport(ctx);
  queue(ctx, 5, 30);
  await t.load([
    { label: '短', bytes: fakeBytes(5) },
    { label: '长', bytes: fakeBytes(30) },
  ]);
  assert.ok(Math.abs(t.durationMs - 30000) < 5, `应取 30s，实际 ${t.durationMs}`);

  ctx._started.length = 0;
  t.play(10000);                        // 短轨已过 5s 末尾
  assert.equal(ctx._started.length, 1, '★ 只有长轨该被调度，短轨跳过');
});

test('skip 生效：offset 不早于 skip', async () => {
  const ctx = makeFakeCtx();
  const t = newTransport(ctx);
  queue(ctx, 30);
  await t.load([{ label: '伴奏', bytes: fakeBytes(30), skipMs: 2000 }]);
  ctx._started.length = 0;
  t.play(0);                            // 从 0 播，但 skip=2000ms
  assert.ok(ctx._started[0].offset >= 1.999,
    `★ offset 不能早于 skip（否则跳过头），实际 ${ctx._started[0].offset}`);
});

test('静音轨仍在时间线上，但增益为 0', async () => {
  const ctx = makeFakeCtx();
  const t = newTransport(ctx);
  const gains = [];
  const origGain = ctx.createGain;
  ctx.createGain = () => { const g = origGain(); gains.push(g); return g; };
  queue(ctx, 30, 30);
  await t.load([
    { label: '伴奏', bytes: fakeBytes(30), muted: true },
    { label: '人声', bytes: fakeBytes(30) },
  ]);
  t.play(0);
  assert.equal(gains.length, 2, '静音轨也要建节点（保住时长与时间线）');
  assert.equal(gains[0].gain.value, 0, '静音轨增益为 0');
  assert.ok(gains[1].gain.value > 0, '非静音轨增益应 > 0');
});

test('空装载不炸；load([]) 清空 lane', async () => {
  const ctx = makeFakeCtx();
  const t = newTransport(ctx);
  assert.equal(await t.load([]), 0);
  assert.equal(t.lanes.length, 0);
  assert.equal(t.play(), false, '无 lane 时 play 应返回 false');
  t.pause(); t.stop(); t.seek(1000);    // 都不该抛
});

test('解码失败的单条被跳过，不拖垮整批', async () => {
  const ctx = makeFakeCtx();
  const t = newTransport(ctx);
  queue(ctx, 'bad', 10);               // 第一条解码失败
  const n = await t.load([
    { label: 'bad', bytes: new Uint8Array(4) },
    { label: 'good', bytes: fakeBytes(10) },
  ]);
  assert.equal(n, 1, '★ 应只装上好的一条');
  assert.equal(t.lanes.length, 1);
  assert.equal(t.lanes[0].label, 'good');
});

test('applyFades：够长的 buffer 上首尾淡化、中段保持 1', async () => {
  const ctx = makeFakeCtx();
  const t = newTransport(ctx);
  const N = 44100;                       // 1 秒：100ms 淡入 + 100ms 淡出绰绰有余
  const data = new Float32Array(N).fill(1);
  ctx.decodeAudioData = () => Promise.resolve({
    duration: 1, sampleRate: 44100, length: N, numberOfChannels: 1,
    getChannelData: () => data,
  });
  await t.load([{ label: 'x', bytes: new Uint8Array(4), fadeIn: 100, fadeOut: 100 }]);
  assert.ok(data[0] < 0.01, `淡入起点应接近 0，实际 ${data[0]}`);
  assert.ok(data[22050] > 0.99, `中段应保持 1，实际 ${data[22050]}`);
  assert.ok(data[N - 1] < 0.01, `淡出末尾应接近 0，实际 ${data[N - 1]}`);
  // 淡化段内应是斜坡而不是台阶
  assert.ok(data[2205] > 0.4 && data[2205] < 0.6,
    `100ms 处应≈0.5（斜坡中点），实际 ${data[2205]}`);
});

test('★ 短 buffer 上淡化超过半长时**不重叠**（否则中段被乘两次）', async () => {
  const ctx = makeFakeCtx();
  const t = newTransport(ctx);
  const N = 1000;                        // 22ms 的短音
  const data = new Float32Array(N).fill(1);
  ctx.decodeAudioData = () => Promise.resolve({
    duration: N / 44100, sampleRate: 44100, length: N, numberOfChannels: 1,
    getChannelData: () => data,
  });
  // 要求 200ms 淡入 + 200ms 淡出 —— 远超整段长度
  await t.load([{ label: 'x', bytes: new Uint8Array(4), fadeIn: 200, fadeOut: 200 }]);
  assert.ok(data[0] < 0.01, `起点应为 0，实际 ${data[0]}`);
  assert.ok(data[N - 1] < 0.01, `末尾应为 0，实际 ${data[N - 1]}`);
  // ★ 关键：中段只被"一头"影响过一次 —— 峰值仍在 1 附近，不该塌到 0.25
  const peak = Math.max(...data);
  assert.ok(peak > 0.95, `★ 中段不该被两头重复衰减，峰值实际 ${peak}`);
});

/* ---------------------------------------------------- P1：本轨效果链 + 自动化 */

test('★ 本轨效果链进链：源接的是链条输入，不是直接接增益', async () => {
  const ctx = makeFakeCtx();
  const t = newTransport(ctx);
  queue(ctx, 10);
  const chainLenBefore = ctx._curves.length;
  await t.load([{
    label: 'v', bytes: fakeBytes(10),
    fx: [{ id: 'f1', type: 'gain', enabled: true, params: { gainDb: -6 } }],
  }]);
  const lane = t.lanes[0];
  assert.equal(lane.fx.length, 1, 'lane 应带上本轨效果链');
  const ok = t.play();
  assert.ok(ok);
  // 增益链（1 个节点）+ 自动化/总音量增益（1 个）→ 至少 2 个节点要参与
  assert.ok(t._nodes.length >= 2, `播放时应把链条节点登记下来（实际 ${t._nodes.length}）`);
  // 关掉的效果不进链 → 节点数更少
  t.stop();
  assert.equal(t._nodes.length, 0, 'stop() 要断开全部节点（延迟的反馈环否则留尾巴）');
  assert.equal(ctx._curves.length, chainLenBefore, '没有自动化时不该写曲线');
  void lane;
});

test('关掉的效果不进链', async () => {
  const ctx = makeFakeCtx();
  const t = newTransport(ctx);
  queue(ctx, 10);
  await t.load([{
    label: 'v', bytes: fakeBytes(10),
    fx: [{ id: 'f1', type: 'reverb', enabled: false, params: { mix: 0.3, seconds: 2, decay: 2 } }],
  }]);
  t.play();
  // 关掉 → 不建链，只剩总音量增益那一个节点
  assert.equal(t._nodes.length, 1, `关掉的效果不该进链（实际 ${t._nodes.length} 个节点）`);
});

test('★ VOL / PAN 自动化在起播时写成曲线（按工程时间开窗）', async () => {
  const ctx = makeFakeCtx();
  const t = newTransport(ctx);
  queue(ctx, 10);
  await t.load([{
    label: 'v', bytes: fakeBytes(10), bpm: 120,
    volPoints: [{ beat: 0, value: -20 }, { beat: 4, value: 0 }],   // 2s 处到 0dB
    panPoints: [{ beat: 0, value: -1 }, { beat: 8, value: 1 }],
  }]);
  t.play();
  const kinds = ctx._curves.map(c => c.kind);
  assert.ok(kinds.indexOf('gain') >= 0, 'VOL 自动化应写在总音量增益上');
  assert.ok(kinds.indexOf('pan') >= 0, 'PAN 自动化应写在声像节点上');
  const vol = ctx._curves.find(c => c.kind === 'gain');
  assert.equal(vol.curve.length, 256, '曲线按 256 步采样');
  assert.ok(vol.dur > 0 && vol.dur <= 10, `曲线时长应覆盖本次播放窗口，实际 ${vol.dur}`);
  // 起点是 -20dB（0.1 线性）
  assert.ok(Math.abs(vol.curve[0] - Math.pow(10, -20 / 20)) < 1e-6,
    `曲线起点应是 -20dB 对应的线性值，实际 ${vol.curve[0]}`);
});

test('静音轨不写自动化曲线（省得白算）', async () => {
  const ctx = makeFakeCtx();
  const t = newTransport(ctx);
  queue(ctx, 10);
  await t.load([{
    label: 'v', bytes: fakeBytes(10), bpm: 120, muted: true,
    volPoints: [{ beat: 0, value: -20 }, { beat: 4, value: 0 }],
  }]);
  t.play();
  assert.equal(ctx._curves.length, 0, '静音轨不该写自动化曲线');
  assert.equal(t.lanes[0].volPoints.length, 2, '但数据要留着，取消静音后立刻能用');
});
