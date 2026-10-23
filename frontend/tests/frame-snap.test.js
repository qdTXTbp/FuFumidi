// P1-6 帧吸附 / 时间码测试
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FPS_PRESETS, normalizeFps, frameSeconds, frameOfTick, tickOfFrame, snapTickToFrame,
  framesBetween, timecodeOfTick, videoTimeForPlayhead, frameTickStep,
} from '../src/core/frame_snap.js';
import { normalizeTimeline, secOfTick } from '../src/core/timeline.js';

const tl = normalizeTimeline({ tpb: 480, tempoMap: [{ tick: 0, us: 500000 }] });   // 120BPM: 960 tick/s
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, '期望 ' + b + ' 实际 ' + a);

test('P1-6 帧率表/归一化：常见 5 档 + 容错', () => {
  assert.deepEqual(FPS_PRESETS.map((p) => p.fps), [23.976, 24, 25, 29.97, 30]);
  assert.equal(normalizeFps(25), 25);
  assert.equal(normalizeFps('29.97'), 29.97);
  assert.equal(normalizeFps(-5), 25, '非法回落 25');
  near(frameSeconds(25), 0.04);
});

test('P1-6 帧 ↔ tick：120BPM / 25fps 下 1s=960tick，1 帧=38.4 tick', () => {
  near(secOfTick(tl, 960), 1);
  assert.equal(frameOfTick(tl, 960, 25), 25);
  near(tickOfFrame(tl, 25, 25), 960);
  near(tickOfFrame(tl, 0, 25), 0);
});

test('P1-6 snapTickToFrame：吸附到最近帧边界，跨帧中点换边', () => {
  // 1 帧 = 38.4 tick，tick 15（0.015625s ≈ 0.39 帧）→ 0 帧 → 0；tick 25（0.65 帧）→ 1 帧
  near(snapTickToFrame(tl, 15, 25), 0);
  near(snapTickToFrame(tl, 25, 25), 38.4);
  near(snapTickToFrame(tl, 1000, 25), Math.round(1000 / 960 * 25) / 25 * 960);
  // 29.97 非整数帧率也必须确定性
  const s1 = snapTickToFrame(tl, 777, 29.97);
  const s2 = snapTickToFrame(tl, 777, 29.97);
  assert.equal(s1, s2);
  assert.ok(Math.abs(secOfTick(tl, s1) * 29.97 - Math.round(secOfTick(tl, s1) * 29.97)) < 1e-6);
});

test('P1-6 变速曲目：帧吸附按秒走，不按固定 tick', () => {
  const tl2 = normalizeTimeline({ tpb: 480, tempoMap: [{ tick: 0, us: 500000 }, { tick: 960, us: 250000 }] });
  // 第二段 240BPM：1 秒 = 1920 tick，25fps 下一帧 = 76.8 tick
  near(secOfTick(tl2, 960 + 1920), 2);
  near(snapTickToFrame(tl2, 960 + 1920, 25), 960 + 1920);
  const snapped = snapTickToFrame(tl2, 960 + 1900, 25);
  near(secOfTick(tl2, snapped) * 25, Math.round(secOfTick(tl2, snapped) * 25));
});

test('P1-6 SMPTE 时间轴：25fps/40tpf 下 1 帧正好 40 tick', () => {
  const smpte = normalizeTimeline({ tpb: 480, smpte: { fps: 25, ticksPerFrame: 40 } });
  assert.equal(frameOfTick(smpte, 400, 25), 10);
  near(snapTickToFrame(smpte, 45, 25), 40);
  near(snapTickToFrame(smpte, 65, 25), 80);   // 1.625 帧 → 2 帧 = 80 tick
});

test('P1-6 时间码格式化：HH:MM:SS:FF', () => {
  assert.equal(timecodeOfTick(tl, 0, 25), '00:00:00:00');
  assert.equal(timecodeOfTick(tl, 960, 25), '00:00:01:00');
  assert.equal(timecodeOfTick(tl, 960 + 19, 25), '00:00:01:00', '不到半帧不进位');
  assert.equal(timecodeOfTick(tl, 960 + 20, 25), '00:00:01:01');
  assert.equal(timecodeOfTick(tl, 960 * 3661, 25), '01:01:01:00');
  assert.equal(timecodeOfTick(tl, 960, 24), '00:00:01:00');
  assert.equal(timecodeOfTick(tl, 960 + 10, 24), '00:00:01:00');
  assert.equal(timecodeOfTick(tl, 960 + 20, 24), '00:00:01:01');
});

test('P1-6 帧差 / 吸附步长 / 视频偏移', () => {
  assert.equal(framesBetween(tl, 0, 960, 25), 25);
  assert.equal(framesBetween(tl, 480, 960, 25), 13);
  assert.ok(Math.abs(frameTickStep(tl, 100, 25) - 38.4) < 1.5);
  near(videoTimeForPlayhead(10, 0.5), 10.5);
  near(videoTimeForPlayhead(10, -0.5), 9.5);
  near(videoTimeForPlayhead(0, -1), -1);
});
