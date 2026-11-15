// -*- coding: utf-8 -*-
//
// automation clip 数据模型（FLAD-04）单测。
//
// ★ 要验的四件事：
//   1. **脏数据不进模型** —— 认不出的 parameterId / 没有归属轨 / 越界值都要被挡
//   2. **放置与循环** —— 区间外不影响、loop 取模、endBeat 是开区间
//   3. **取值语义** —— 线性插值、两端保持、gain 偏移后仍按参数范围钳制
//   4. **从曲线派生** —— 截取区间两侧补边界点，开头不回落默认值
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_CLIP_BEATS, MAX_CLIPS,
  newClipId, normalizeAutomationClip, normalizeAutomationClips,
  coversBeat, clipValueAt, clipValueAtFaded, fadeFactor, automationValueAt, clipsForTrack,
  createClipFromCurve, shiftClip, cloneClip, trimClip,
  hasClipFor, effectiveValueAt, automationEnvelope, mergedCurvePoints,
} from '../src/core/automation_clip.js';

/** PIT 的数据域是 ±1200，拿 0..100 做插值不会被范围钳制干扰。 */
function pitClip(extra) {
  return normalizeAutomationClip({
    id: 'c1',
    trackId: 't1',
    parameterId: 'curve.PIT',
    points: [{ beat: 0, value: 0 }, { beat: 4, value: 100 }],
    startBeat: 0,
    endBeat: 4,
    ...extra,
  });
}

test('id 稳定可读：前缀 ac_，连续生成不重复', () => {
  const a = newClipId();
  const b = newClipId();
  assert.match(a, /^ac_[a-z0-9]+_[a-z0-9]+$/);
  assert.notEqual(a, b);
});

test('归一化：未知参数 / 缺归属轨 / 非对象一律丢弃', () => {
  assert.equal(normalizeAutomationClip(null), null);
  assert.equal(normalizeAutomationClip({ trackId: 't1', parameterId: 'curve.NOPE' }), null);
  assert.equal(normalizeAutomationClip({ trackId: '', parameterId: 'curve.PIT' }), null);
  assert.equal(normalizeAutomationClip({ parameterId: 'curve.PIT' }), null);
});

test('归一化：点按拍排序、值按参数范围钳制、起止非法时兜底', () => {
  const c = normalizeAutomationClip({
    id: 'c',
    trackId: 't1',
    parameterId: 'curve.VOL',
    points: [{ beat: 3, value: 999 }, { beat: 1, value: -999 }, { beat: 'x', value: 1 }],
    startBeat: 8,
    endBeat: 8,
  });
  assert.deepEqual(c.points, [{ beat: 1, value: -60 }, { beat: 3, value: 6 }]);
  assert.equal(c.endBeat, 8 + MIN_CLIP_BEATS, 'endBeat 不晚于 startBeat 时补到最短长度');
  assert.equal(c.loop, false);
  assert.equal(c.gain, 0);
});

test('放置：区间外不生效，endBeat 为开区间', () => {
  const c = pitClip({ startBeat: 4, endBeat: 8 });
  assert.equal(coversBeat(c, 3.9), false);
  assert.equal(clipValueAt(c, 3.9), null);
  assert.equal(coversBeat(c, 4), true, '起点算在内');
  assert.equal(coversBeat(c, 8), false, '终点不算在内');
  assert.equal(clipValueAt(c, 8), null);
});

test('取值：线性插值 + 两端保持', () => {
  const c = pitClip();
  assert.equal(clipValueAt(c, 0), 0);
  assert.equal(clipValueAt(c, 2), 50);
  assert.ok(Math.abs(clipValueAt(c, 4 - 1e-9) - 100) < 1e-6, '末点之前保持末值');
  assert.equal(clipValueAt(c, 0), 0, '首点之前取首值（这里是起点本身）');
});

test('循环：loop 时按放置长度取模', () => {
  const c = pitClip({ loop: true, startBeat: 10, endBeat: 14 });
  assert.equal(clipValueAt(c, 10), 0);
  assert.equal(clipValueAt(c, 12), 50);
  assert.ok(Math.abs(clipValueAt(c, 14 - 1e-9) - 100) < 1e-6, '循环末点之前取末值');
  assert.equal(clipValueAt(c, 13), 75, 'local=3 → 0..4 的 75%');
});

test('gain：整条曲线按参数单位偏移，偏移后仍受范围钳制', () => {
  const c = pitClip({ gain: -6 });
  assert.equal(clipValueAt(c, 0), -6);
  assert.ok(Math.abs(clipValueAt(c, 4 - 1e-9) - 94) < 1e-6, '100-6=94（PIT 范围 ±1200，不触发钳制）');

  const pit = normalizeAutomationClip({
    id: 'p', trackId: 't1', parameterId: 'curve.PIT',
    points: [{ beat: 0, value: 1200 }], startBeat: 0, endBeat: 1, gain: 30,
  });
  assert.equal(clipValueAt(pit, 0), 1200, '1200+30 钳回上限 1200');
});

test('叠加：同轨同参数取最后一条覆盖的 clip，其他轨/参数不受影响', () => {
  const a = pitClip({ id: 'a', startBeat: 0, endBeat: 8, points: [{ beat: 0, value: 0 }, { beat: 8, value: 80 }] });
  const b = pitClip({ id: 'b', startBeat: 4, endBeat: 8, points: [{ beat: 0, value: -10 }, { beat: 4, value: -10 }] });
  const other = pitClip({ id: 'o', trackId: 't2', startBeat: 0, endBeat: 8 });
  const clips = [a, other, b];

  assert.equal(automationValueAt(clips, { trackId: 't1', parameterId: 'curve.PIT', beat: 5 }), -10);
  assert.equal(automationValueAt(clips, { trackId: 't1', parameterId: 'curve.PIT', beat: 2 }), 20);
  assert.equal(automationValueAt(clips, { trackId: 't2', parameterId: 'curve.PIT', beat: 5 }), 100, '末点之后保持末值');
  assert.equal(automationValueAt(clips, { trackId: 't1', parameterId: 'curve.PAN', beat: 5 }), null);
  assert.equal(automationValueAt(clips, { trackId: 't9', parameterId: 'curve.PIT', beat: 5 }), null);
  assert.deepEqual(clipsForTrack(clips, 't2').map((c) => c.id), ['o']);
});

test('整组归一化：按 id 去重、坏项跳过', () => {
  const a = pitClip({ id: 'dup' });
  const b = pitClip({ id: 'dup', startBeat: 20, endBeat: 24 });
  const out = normalizeAutomationClips([a, b, null, { parameterId: 'curve.NOPE' }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].startBeat, 0, '先出现者胜');
});

test('整组归一化：数量有上限', () => {
  const many = [];
  for (let i = 0; i < MAX_CLIPS + 5; i++) many.push(pitClip({ id: 'c' + i }));
  assert.equal(normalizeAutomationClips(many).length, MAX_CLIPS);
});

test('从曲线派生：截取区间两侧补边界点，开头不回落默认值', () => {
  const curve = {
    abbr: 'PIT',
    points: [
      { beat: 0, value: 0 },
      { beat: 4, value: 0 },
      { beat: 6, value: 100 },
      { beat: 8, value: 0 },
      { beat: 10, value: 0 },
    ],
  };
  const c = createClipFromCurve(curve, { trackId: 't1', startBeat: 4, endBeat: 8, id: 'x' });
  assert.deepEqual(c.points, [
    { beat: 0, value: 0 },
    { beat: 2, value: 100 },
    { beat: 4, value: 0 },
  ]);
  assert.equal(c.parameterId, 'curve.PIT');
  assert.equal(c.startBeat, 4);
  assert.equal(c.endBeat, 8);
});

test('从曲线派生：认不出的 abbr 返回 null', () => {
  assert.equal(createClipFromCurve({ abbr: 'NOPE', points: [] }, { trackId: 't1' }), null);
});

test('裁剪：拉右边只改放置区间，点坐标不动', () => {
  const c = pitClip({});
  const cut = trimClip(c, 'end', 3);
  assert.equal(cut.startBeat, 0);
  assert.equal(cut.endBeat, 3);
  assert.deepEqual(cut.points, c.points);
});

test('裁剪：拉左边同步平移内部点，内容在时间轴上不漂移', () => {
  const c = normalizeAutomationClip({
    id: 'c2', trackId: 't1', parameterId: 'curve.PIT',
    points: [{ beat: 0, value: 0 }, { beat: 2, value: 50 }, { beat: 4, value: 100 }],
    startBeat: 0, endBeat: 4,
  });
  const cut = trimClip(c, 'start', 2);
  assert.equal(cut.startBeat, 2);
  assert.equal(cut.endBeat, 4);
  assert.equal(clipValueAt(c, 3), clipValueAt(cut, 3), '绝对拍上的值保持一致');
  assert.deepEqual(cut.points.map((p) => p.beat), [0, 2]);
});

test('裁剪：最小长度约束，裁过头不会变成零长/反向', () => {
  const c = pitClip({ startBeat: 2, endBeat: 6 });
  assert.equal(trimClip(c, 'end', 0).endBeat, 2 + MIN_CLIP_BEATS);
  assert.equal(trimClip(c, 'start', 99).startBeat, 6 - MIN_CLIP_BEATS);
});

test('淡化：长度钳到 clip 全长，系数两端线性过渡', () => {
  assert.equal(pitClip({ fadeOut: 99 }).fadeOut, 4, '超出全长的淡化被钳制');
  const c = pitClip({ fadeIn: 1, fadeOut: 1 });
  assert.equal(fadeFactor(c, 0), 0);
  assert.equal(fadeFactor(c, 0.5), 0.5);
  assert.equal(fadeFactor(c, 1), 1);
  assert.equal(fadeFactor(c, 3), 1);
  assert.equal(fadeFactor(c, 3.5), 0.5);
});

test('淡化：朝基础值混合，不会把参数拉回 0', () => {
  const c = pitClip({ fadeIn: 2 });
  assert.equal(clipValueAtFaded(c, 0, 100), 100, '淡入起点 = 基础值');
  assert.equal(clipValueAtFaded(c, 1, 100), 62.5, '一半淡入：基础值 + 差值 × 0.5');
  assert.equal(clipValueAtFaded(c, 2, 100), 50, '淡入结束 = 原始 clip 值');
  assert.equal(clipValueAtFaded(c, 3, 100), 75);
});

test('淡化：effectiveValueAt 以基础曲线为混合基准', () => {
  const base = [{ beat: 0, value: 20 }, { beat: 8, value: 20 }];
  const c = pitClip({ fadeIn: 2 });
  assert.equal(effectiveValueAt(base, 'PIT', [c], 't1', 0, 20), 20);
  assert.equal(effectiveValueAt(base, 'PIT', [c], 't1', 1, 20), 22.5);
  assert.equal(effectiveValueAt(base, 'PIT', [c], 't1', 3, 20), 75);
});

test('track.gain clip：常量折线可采样，gain 偏移后仍按参数范围钳制', () => {
  const c = normalizeAutomationClip({
    trackId: 't1', parameterId: 'track.gain',
    points: [{ beat: 0, value: 3 }, { beat: 4, value: 3 }],
    startBeat: 2, endBeat: 6,
  });
  assert.equal(c.parameterId, 'track.gain');
  assert.equal(clipValueAt(c, 2), 3);
  assert.equal(clipValueAt(c, 4), 3);
  assert.equal(clipValueAt(c, 6), null, 'endBeat 是开区间');
  assert.equal(clipValueAt({ ...c, gain: 60 }, 4), 6, '增益偏移后钳到 max=6');
});

test('移动：只改放置区间，点坐标（clip 内部）不动', () => {
  const c = pitClip({ startBeat: 4, endBeat: 8 });
  const moved = shiftClip(c, 8);
  assert.equal(moved.startBeat, 12);
  assert.equal(moved.endBeat, 16);
  assert.deepEqual(moved.points, c.points);
  assert.equal(shiftClip(c, -100).startBeat, 0, '不能移到负拍');
});

test('复制：新 id，放在原 clip 之后一条长度处', () => {
  const c = pitClip({ startBeat: 4, endBeat: 8 });
  const d = cloneClip(c);
  assert.notEqual(d.id, c.id);
  assert.equal(d.startBeat, 8);
  assert.equal(d.endBeat, 12);
  assert.deepEqual(d.points, c.points);
});

/* ---------------- 合并采样：基础曲线 + clip 覆盖 ---------------- */

const BASE_PIT = [{ beat: 0, value: 0 }, { beat: 8, value: 80 }];

test('hasClipFor：只认同轨同参数的 clip', () => {
  const clips = [pitClip({ id: 'a', startBeat: 4, endBeat: 8 })];
  assert.equal(hasClipFor(clips, 't1', 'PIT'), true);
  assert.equal(hasClipFor(clips, 't2', 'PIT'), false);
  assert.equal(hasClipFor(clips, 't1', 'VOL'), false);
  assert.equal(hasClipFor(clips, 't1', 'NOPE'), false);
  assert.equal(hasClipFor(null, 't1', 'PIT'), false);
});

test('effectiveValueAt：区间内 clip 优先，区间外回落基础曲线', () => {
  const clips = [pitClip({ startBeat: 4, endBeat: 8, points: [{ beat: 0, value: 100 }, { beat: 4, value: 100 }] })];
  assert.equal(effectiveValueAt(BASE_PIT, 'PIT', clips, 't1', 6, 0), 100, '被 clip 覆盖');
  assert.equal(effectiveValueAt(BASE_PIT, 'PIT', clips, 't1', 2, 0), 20, '外部走基础曲线');
  assert.equal(effectiveValueAt(BASE_PIT, 'PIT', clips, 't2', 6, 0), 60, '别的轨不受影响');
  assert.equal(effectiveValueAt([], 'VOL', clips, 't1', 6, -3), -3, '没有基础曲线时用兜底值');
  assert.equal(effectiveValueAt([], 'NOPE', clips, 't1', 6, 7), 7, '未知参数不参与覆盖');
  assert.equal(effectiveValueAt(BASE_PIT, 'NOPE', clips, 't1', 6, 7), 60, '未知参数仍走基础曲线');
});

test('automationEnvelope：VOL 的 dB→线性换算与 clip 覆盖共用一条链路', () => {
  // 基础曲线 0 → -20 dB；clip 在 [2,4) 压到 -6 dB
  const base = [{ beat: 0, value: 0 }, { beat: 8, value: -20 }];
  const clips = [normalizeAutomationClip({
    id: 'v', trackId: 't1', parameterId: 'curve.VOL',
    points: [{ beat: 0, value: -6 }, { beat: 2, value: -6 }],
    startBeat: 2, endBeat: 4,
  })];
  // 120 BPM，8 拍 = 4 秒，取 5 个采样点 → beat = 0,2,4,6,8
  const env = automationEnvelope(base, 'VOL', clips, 't1', 120, 0, 4, 5);
  assert.ok(Math.abs(env[0] - 1) < 1e-6, 'beat 0：0 dB → 1');
  assert.ok(Math.abs(env[1] - Math.pow(10, -6 / 20)) < 1e-5, 'beat 2：clip 的 -6 dB');
  assert.ok(Math.abs(env[2] - Math.pow(10, -10 / 20)) < 1e-5, 'beat 4：区间外回落基础曲线');
  assert.ok(Math.abs(env[3] - Math.pow(10, -15 / 20)) < 1e-5, 'beat 6：基础曲线');
});

test('automationEnvelope：没有 clip 时与 envelopeFrom 结果一致', () => {
  const base = [{ beat: 0, value: 0 }, { beat: 4, value: -12 }];
  const a = automationEnvelope(base, 'VOL', [], 't1', 120, 0, 2, 8);
  const b = automationEnvelope(base, 'VOL', null, 't1', 120, 0, 2, 8);
  assert.deepEqual(Array.from(a), Array.from(b));
});

test('mergedCurvePoints：没有相关 clip 时原样返回基础点', () => {
  const out = mergedCurvePoints(BASE_PIT, 'PIT', [], 't1');
  assert.deepEqual(out, BASE_PIT);
  assert.notEqual(out, BASE_PIT, '返回副本，调用方改它不会污染基础曲线');
});

test('mergedCurvePoints：把 clip 覆盖烘焙进折线，起止处是跳变而非跨区间斜坡', () => {
  const clips = [pitClip({ id: 'm', startBeat: 4, endBeat: 8, points: [{ beat: 0, value: 100 }, { beat: 4, value: 100 }] })];
  const out = mergedCurvePoints(BASE_PIT, 'PIT', clips, 't1');
  const at = (b) => out.find((p) => Math.abs(p.beat - b) < 1e-9);
  const justBefore = (b) => out.find((p) => Math.abs(p.beat - (b - 1e-4)) < 1e-9);

  assert.ok(Math.abs(justBefore(4).value - 40) < 0.01, 'start 之前的极小偏移点取基础曲线值');
  assert.equal(at(4).value, 100, 'start 起由 clip 接管');
  assert.ok(Math.abs(justBefore(8).value - 100) < 0.01, 'end 之前保持 clip 值');
  assert.equal(at(8).value, 80, 'end 之后回到基础曲线');
  assert.equal(out.length, 5, '基础 2 点 + 边界 4 点（end 与基础末点重合去重）');
});

test('mergedCurvePoints：区间外仍能在折线上按基础曲线插值', () => {
  const clips = [pitClip({ id: 'm', startBeat: 4, endBeat: 8, points: [{ beat: 0, value: 40 }, { beat: 4, value: 40 }] })];
  const out = mergedCurvePoints(BASE_PIT, 'PIT', clips, 't1');
  // 在 0..4 之间取中点，折线应给出基础曲线的 20，而不是被 clip 拉高
  const mid = out.find((p) => Math.abs(p.beat - 2) < 1e-9);
  assert.equal(mid, undefined, '没有多余的采样点');
  const sorted = out.filter((p) => p.beat <= 4);
  const [a, b] = [sorted[0], sorted[sorted.length - 2]];
  assert.ok(Math.abs((a.value + b.value) / 2 - 20) < 1e-3, '0..4 段仍是基础曲线 0→40');
});
