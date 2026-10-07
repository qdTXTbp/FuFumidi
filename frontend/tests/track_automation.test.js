// 自动化子轨（纯数据逻辑，无需音频环境）。
//
// ★ 要验的四件事：
//   1. **引擎差异** —— DYN/BRE/GEN 只有 UTAU 吃，不能出现在 DiffSinger 轨上
//      （糊过去就是"调了没反应"）
//   2. **插值与两端保持** —— 开头/结尾不能外插飞出去
//   3. **VOL 的 dB→增益换算** —— 直接拿 dB 当增益会把音量顶到天上
//   4. **脏曲线兜底** —— 手改过的工程不该让整条轨崩掉
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CURVE_TARGETS, CURVE_ORDER, targetsFor, defaultFor,
  normalizeCurve, normalizeCurves, curveOf, sampleAt, envelope, envelopeFrom,
  valueForNote, secToBeat, laneViewOf,
} from '../src/core/track_automation.js';

/* ------------------------------------------------------------ 目标 */

test('★ DYN/BRE/GEN 只对 UTAU 轨开放（DiffSinger 引擎吃不到这些参数）', () => {
  assert.deepEqual(targetsFor('utau'), ['PIT', 'VOL', 'PAN', 'DYN', 'BRE', 'GEN']);
  assert.deepEqual(targetsFor('diffsinger'), ['PIT', 'VOL', 'PAN']);
  assert.deepEqual(targetsFor('utau', 'audio'), ['VOL', 'PAN'], '伴奏轨只有音量/声像');
});

test('每个目标都声明了生效时机，UI 才能提示要不要重渲', () => {
  for (const a of CURVE_ORDER) {
    const t = CURVE_TARGETS[a];
    assert.ok(t.mode === 'render' || t.mode === 'playback', a + ' 缺 mode');
  }
  assert.equal(CURVE_TARGETS.PIT.mode, 'render');
  assert.equal(CURVE_TARGETS.DYN.mode, 'render');
  assert.equal(CURVE_TARGETS.VOL.mode, 'playback');
  assert.equal(CURVE_TARGETS.PAN.mode, 'playback');
});

test('注册表顺序与 CURVE_ORDER 一致，且每个都有范围', () => {
  assert.deepEqual(Object.keys(CURVE_TARGETS).sort(), CURVE_ORDER.slice().sort());
  for (const a of CURVE_ORDER) {
    const t = CURVE_TARGETS[a];
    assert.ok(t.min < t.max, a + ' 范围无效');
    assert.ok(t.def >= t.min && t.def <= t.max, a + ' 默认值越界');
  }
  assert.equal(defaultFor('DYN'), 100);
  assert.equal(defaultFor('不存在的目标'), 0);
});

/* ------------------------------------------------------------ 归一化 */

test('★ 归一化会丢掉当前引擎用不了的目标', () => {
  const curves = [
    { abbr: 'PIT', points: [{ beat: 0, value: 0 }] },
    { abbr: 'DYN', points: [{ beat: 0, value: 90 }] },
    { abbr: 'GEN', points: [{ beat: 1, value: -20 }] },
  ];
  const ds = normalizeCurves(curves, 'diffsinger');
  assert.deepEqual(ds.map((c) => c.abbr), ['PIT'], 'DiffSinger 只该留下 PIT');
  const ut = normalizeCurves(curves, 'utau');
  assert.deepEqual(ut.map((c) => c.abbr), ['PIT', 'DYN', 'GEN']);
});

test('值被夹进范围，点按 beat 排序，无效点被丢', () => {
  const out = normalizeCurve({
    abbr: 'VOL',
    points: [
      { beat: 4, value: 999 },
      { beat: 0, value: -999 },
      { beat: 'x', value: 1 },
      { beat: 2, value: 'y' },
      null,
    ],
  });
  assert.deepEqual(out.points.map((p) => p.beat), [0, 4]);
  assert.equal(out.points[0].value, -60);
  assert.equal(out.points[1].value, 6);
});

test('未知 abbr / 重名 / 非对象都被处理', () => {
  assert.equal(normalizeCurve({ abbr: 'NOPE', points: [] }), null);
  assert.equal(normalizeCurve(null), null);
  const dup = normalizeCurves([
    { abbr: 'PIT', points: [{ beat: 0, value: 10 }] },
    { abbr: 'PIT', points: [{ beat: 1, value: 20 }] },
    'junk',
  ], 'utau');
  assert.equal(dup.length, 1, '同一目标只留一条');
  assert.equal(dup[0].points[0].value, 10, '保留先出现的那条');
});

test('空 points 的曲线仍然保留（表示"有这条子轨但还没画"）', () => {
  const out = normalizeCurves([{ abbr: 'PIT', points: [] }], 'utau');
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].points, []);
});

test('curveOf 取不到时返回 null（调用方据此判断"没自动化"）', () => {
  const tr = { curves: [{ abbr: 'VOL', points: [{ beat: 0, value: -3 }] }] };
  assert.ok(curveOf(tr, 'VOL'));
  assert.equal(curveOf(tr, 'PIT'), null);
  assert.equal(curveOf({}, 'PIT'), null);
  assert.equal(curveOf(null, 'PIT'), null);
});

/* ------------------------------------------------------------ 采样 */

test('★ 线性插值 + 两端保持（不外插）', () => {
  const pts = [{ beat: 0, value: 0 }, { beat: 4, value: 100 }];
  assert.equal(sampleAt(pts, -10, 0), 0, '首点之前取首值');
  assert.equal(sampleAt(pts, 0, 0), 0);
  assert.equal(sampleAt(pts, 1, 0), 25);
  assert.equal(sampleAt(pts, 2, 0), 50);
  assert.equal(sampleAt(pts, 3, 0), 75);
  assert.equal(sampleAt(pts, 4, 0), 100);
  assert.equal(sampleAt(pts, 99, 0), 100, '末点之后取末值');
});

test('空曲线 / 空拍值 → 回退到默认值', () => {
  assert.equal(sampleAt([], 3, 42), 42);
  assert.equal(sampleAt([{ beat: 0, value: 5 }], NaN, 7), 7);
});

test('重合的拍取后一个（后写覆盖先写，不产生除零）', () => {
  const pts = [{ beat: 1, value: 10 }, { beat: 1, value: 20 }];
  assert.equal(sampleAt(pts, 1, 0), 20);
  assert.ok(Number.isFinite(sampleAt(pts, 0.5, 0)));
});

/* ------------------------------------------------------------ 包络 */

test('★ VOL 的 dB 被转成线性增益（0 dB → 1，-6 dB → 约 0.5）', () => {
  const pts = [{ beat: 0, value: 0 }];
  const env = envelope(pts, 120, 10, 5, 'VOL');
  assert.equal(env.length, 5);
  assert.ok(Math.abs(env[0] - 1) < 1e-6);

  const e2 = envelope([{ beat: 0, value: -6 }], 120, 10, 3, 'VOL');
  assert.ok(Math.abs(e2[0] - 0.501) < 0.01, '-6dB 应约 0.5，实得 ' + e2[0]);
});

test('包络长度至少 2（setValueCurveAtTime 的硬性要求）', () => {
  assert.equal(envelope([], 120, 1, 0, 'PAN').length, 2);
  assert.equal(envelope([], 120, 1, 1, 'PAN').length, 2);
});

test('★ 包络按拍对齐：BPM 变了，同一个拍值落到的时间点也变', () => {
  const pts = [{ beat: 0, value: -60 }, { beat: 4, value: 0 }];
  // 5 点采在 0/2/4/6/8 秒：取第 1 个（2 秒处）——
  // 60 BPM 下 2 秒 = 2 拍（曲线才走一半，-30dB），120 BPM 下 2 秒 = 4 拍（已到 0dB）
  const slow = envelope(pts, 60, 8, 5, 'VOL');
  const fast = envelope(pts, 120, 8, 5, 'VOL');
  assert.ok(slow[1] < fast[1], '慢速下同一时刻的音量应更低（包络还没走完）');
  assert.ok(Math.abs(fast[1] - 1) < 1e-6, '120 BPM 下 2 秒已走到 0dB');
});

test('非 VOL 目标原样输出，不做 dB 换算', () => {
  const env = envelope([{ beat: 0, value: -0.75 }], 120, 4, 3, 'PAN');
  assert.ok(Math.abs(env[0] + 0.75) < 1e-6);
});

/* ------------------------------------------------------------ 渲染取值 */

test('valueForNote 取音符中点（长音符上的渐强不会被抹平）', () => {
  const pts = [{ beat: 0, value: 0 }, { beat: 8, value: 80 }];
  assert.equal(valueForNote(pts, 0, 4, 'DYN'), 20, '0→4 拍的中点是 2 拍 = 20');
  assert.equal(valueForNote(pts, 4, 4, 'DYN'), 60, '4→8 拍的中点是 6 拍 = 60');
});

test('没有曲线时取该目标的默认值（DYN 满力度、PIT 不偏移）', () => {
  assert.equal(valueForNote([], 3, 1, 'DYN'), 100);
  assert.equal(valueForNote([], 3, 1, 'PIT'), 0);
});

/* ---------------------------------------------------- 多点变速（sec ⇄ beat） */

test('secToBeat：多点变速沿段换算，无 map 退回恒定 bpm', () => {
  const map = [{ beat: 0, bpm: 120 }, { beat: 8, bpm: 90 }];
  assert.equal(secToBeat(0, map, 120), 0);
  assert.equal(secToBeat(4, map, 120), 8, '4s = 前 8 拍（0.5s/拍）');
  // 5.3333s = 4s + 1.3333s；降速段 1.3333s × 90/60 = 2 拍 → beat 10
  assert.equal(Math.round(secToBeat(4000 / 1000 + (2 * 60 / 90), map, 120) * 1e6) / 1e6, 10);
  assert.equal(secToBeat(2, null, 120), 4, '无 map：2s @120bpm = 4 拍');
  assert.equal(secToBeat(2, [], 96), 3.2, '空 map 退回 fallbackBpm');
  // 超出末点按末段速率外推
  assert.equal(Math.round(secToBeat(10, map, 120) * 1e6) / 1e6, 8 + 6 * 90 / 60);
});

test('secToBeat：脏数据兜底（坏点丢、同拍后写赢、首点强制 0）', () => {
  const map = [
    { beat: -1, bpm: 120 },          // 负拍丢
    { beat: 0, bpm: 60 }, { beat: 0, bpm: 120 },   // 同拍去重（后写赢）
    { beat: 4, bpm: 0 },             // bpm 非法丢
    'x', null,                        // 形状不对丢
    { beat: 2, bpm: 120 },           // 留下的首个非零点
  ];
  // 有效点：{0:120},{2:120} → 恒 120
  assert.equal(secToBeat(1, map, 96), 2);
});

test('envelopeFrom：带 tempoMap 时自动化按变速段对齐拍位', () => {
  const points = [{ beat: 0, value: 0 }, { beat: 8, value: 1 }, { beat: 16, value: 0 }];
  const map = [{ beat: 0, bpm: 120 }, { beat: 8, bpm: 90 }];
  // 窗口 [4s, 6.667s]：4s 处 beat=8（value 峰值 1）
  const env = envelopeFrom(points, 120, 4, 4 + 4 * 60 / 90, 64, 'NONE', map);
  assert.equal(env[0], 1, '窗口起点 beat 8 = 峰值');
  // 末点 6.667s → beat = 8 + 2.667s×90/60 = 12 → value 从 1 线性衰减到 (16-12)/8 = 0.5
  assert.equal(Math.abs(env[63] - 0.5) < 1e-6, true);
  // 不带 tempoMap：恒定 bpm 行为不变（回归）
  const env2 = envelopeFrom(points, 120, 4, 8, 64, 'NONE');
  assert.equal(env2[0], 1);
});

/* ---------------------------------------------------- 曲线泳道显示配置 */

test('laneViewOf：PIT 显示窗口 ±200，其余全域 + 三刻度', () => {
  const pit = laneViewOf('PIT');
  assert.equal(pit.dispMin, -200);
  assert.equal(pit.dispMax, 200);
  assert.deepEqual(pit.ticks, [-200, -100, 0, 100, 200]);
  const dyn = laneViewOf('DYN');
  assert.equal(dyn.dispMin, 0);
  assert.equal(dyn.dispMax, 100);
  assert.deepEqual(dyn.ticks, [0, 50, 100], 'DYN 全域 0..100，中点 50');
  const gen = laneViewOf('GEN');
  assert.deepEqual(gen.ticks, [-100, 0, 100]);
  assert.equal(laneViewOf('VOL'), null, '播放侧目标不给泳道（不进引擎渲染）');
  assert.equal(laneViewOf('XXX'), null, '未知 abbr → null');
});
