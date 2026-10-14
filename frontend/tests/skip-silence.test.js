// 播放跳过空白片段：纯函数测试（core/skip_silence.js）。
//
// 钉住的是语义：空白 = **音符间隙**；首尾静音不算"空档"（开头静音另有开关单独处理，
// 用户 2026-10-14 定「开头静音默认跳」）；跳过去要留 lead 余量，别正好落在下一个音上。
import { test } from "node:test";
import assert from "node:assert/strict";

import { mergeSpans, computeGaps, leadingSilenceEnd, gapAt, nextSkipTarget } from "../src/core/skip_silence.js";

test("mergeSpans 合并重叠与相接区间", () => {
  const out = mergeSpans([{ start: 5, end: 8 }, { start: 1, end: 3 }, { start: 2, end: 6 }, { start: 8, end: 10 }]);
  assert.deepEqual(out, [{ start: 1, end: 10 }]);
});

test("mergeSpans 忽略非法项", () => {
  const out = mergeSpans([null, { start: 2, end: 1 }, { start: 0, end: 1 }, undefined]);
  assert.deepEqual(out, [{ start: 0, end: 1 }]);
});

test("computeGaps 取所有够长的音符间隙", () => {
  const notes = [{ start: 0, end: 10 }, { start: 13, end: 20 }, { start: 30, end: 40 }];
  assert.deepEqual(computeGaps(notes, 2.5), [{ start: 10, end: 13 }, { start: 20, end: 30 }]);
});

test("computeGaps：3 秒空档在阈值 2.5 下要保留，1 秒的不留", () => {
  const notes = [{ start: 0, end: 10 }, { start: 11, end: 12 }, { start: 15, end: 20 }];
  const gaps = computeGaps(notes, 2.5);
  assert.equal(gaps.length, 1);
  assert.deepEqual(gaps[0], { start: 12, end: 15 });
});

test("computeGaps：首尾静音不算空档（另有开关）", () => {
  assert.deepEqual(computeGaps([{ start: 19, end: 30 }], 1), []);
  assert.deepEqual(computeGaps([], 1), []);
});

test("leadingSilenceEnd：开头静音够长才返回第一个音的位置", () => {
  assert.equal(leadingSilenceEnd([{ start: 19, end: 30 }], 1.0), 19);
  assert.equal(leadingSilenceEnd([{ start: 0.4, end: 30 }], 1.0), null);
  assert.equal(leadingSilenceEnd([], 1.0), null);
});

test("gapAt / nextSkipTarget：落在空档里才跳，并留 lead", () => {
  const gaps = [{ start: 20, end: 30 }];
  assert.ok(gapAt(gaps, 25));
  assert.equal(gapAt(gaps, 31), null);
  assert.equal(nextSkipTarget({ gaps, sec: 25, lead: 0.2 }), 29.8);
  assert.equal(nextSkipTarget({ gaps, sec: 10, lead: 0.2 }), null);
  // 空档比 lead 还短 → 不跳（否则会往后跳）
  assert.equal(nextSkipTarget({ gaps: [{ start: 20, end: 20.1 }], sec: 20, lead: 0.5 }), null);
});

test("nextSkipTarget 夹在总时长内", () => {
  const gaps = [{ start: 20, end: 30 }];
  assert.equal(nextSkipTarget({ gaps, sec: 25, lead: 0.2, totalSec: 29 }), 29);
});
