// 参数注册表（FLAD-04 数据层）。
//
// ★ 要验的四件事：
//   1. **id 稳定** —— clip 存的是 parameterId，改名/换语言不能影响键
//   2. **单一来源** —— 曲线参数必须与 CURVE_TARGETS 完全一致，不能有第二份定义
//   3. **引擎口径一致** —— paramsForTrack 与 targetsFor 同结果，避免"界面能选、引擎不认"
//   4. **范围钳制** —— 脏值不能进 clip 模型
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PARAMS, CURVE_PARAM_PREFIX, LAST_TWEAK_TTL_MS,
  curveParamId, curveAbbrOf, paramById, isParamId,
  paramsForTrack, normalizeParamValue,
} from '../src/core/param_registry.js';
import { CURVE_TARGETS, CURVE_ORDER, targetsFor } from '../src/core/track_automation.js';

test('★ 参数 id 是固定字符串：改名/换语言不影响键', () => {
  assert.deepEqual(Object.keys(PARAMS).sort(), [
    'curve.BRE', 'curve.DYN', 'curve.GEN', 'curve.PAN', 'curve.PIT', 'curve.VOL', 'track.gain',
  ]);
});

test('每个曲线目标都派生出一条参数，且元数据与 CURVE_TARGETS 一致', () => {
  for (const abbr of CURVE_ORDER) {
    const id = curveParamId(abbr);
    assert.equal(id, CURVE_PARAM_PREFIX + abbr);
    const p = paramById(id);
    const t = CURVE_TARGETS[abbr];
    assert.ok(p, abbr + ' 缺参数定义');
    assert.equal(p.kind, 'curve');
    assert.equal(p.abbr, abbr);
    assert.equal(p.label, t.label);
    assert.equal(p.unit, t.unit);
    assert.equal(p.min, t.min);
    assert.equal(p.max, t.max);
    assert.equal(p.step, t.step);
    assert.equal(p.def, t.def);
    assert.equal(p.mode, t.mode);
    assert.deepEqual([...p.engines], [...t.engines]);
  }
});

test('curveParamId / curveAbbrOf 互逆，脏输入返回 null', () => {
  for (const abbr of CURVE_ORDER) {
    assert.equal(curveAbbrOf(curveParamId(abbr)), abbr);
  }
  assert.equal(curveParamId('nope'), null);
  assert.equal(curveParamId(''), null);
  assert.equal(curveAbbrOf('track.gain'), null);
  assert.equal(curveAbbrOf('curve.NOPE'), null);
  assert.equal(curveAbbrOf(null), null);
});

test('paramById / isParamId 只认注册过的 id', () => {
  assert.equal(paramById('track.gain').kind, 'mix');
  assert.equal(paramById('track.gain').unit, 'dB');
  assert.equal(paramById('Track.Gain'), null, '键区分大小写');
  assert.equal(paramById('PIT'), null, 'abbr 本身不是参数 id');
  assert.equal(isParamId('curve.VOL'), true);
  assert.equal(isParamId('curve.vol'), false);
  assert.equal(isParamId(undefined), false);
});

test('★ paramsForTrack 与 targetsFor 同口径（引擎用不了的参数不暴露）', () => {
  const curveIds = (engine, kind) => targetsFor(engine, kind).map((a) => curveParamId(a));
  assert.deepEqual(paramsForTrack('utau'), ['track.gain', ...curveIds('utau')]);
  assert.deepEqual(paramsForTrack('diffsinger'), ['track.gain', ...curveIds('diffsinger')]);
  assert.deepEqual(paramsForTrack('diffsinger', 'audio'), ['track.gain', ...curveIds('diffsinger', 'audio')]);
  // 伴奏轨没有 DYN/BRE/GEN
  assert.equal(paramsForTrack('utau', 'audio').includes('curve.DYN'), false);
});

test('生效时机：PIT/DYN/BRE/GEN 要重渲，VOL/PAN/增益是播放侧', () => {
  for (const abbr of ['PIT', 'DYN', 'BRE', 'GEN']) {
    assert.equal(paramById('curve.' + abbr).mode, 'render', abbr);
  }
  for (const abbr of ['VOL', 'PAN']) {
    assert.equal(paramById('curve.' + abbr).mode, 'playback', abbr);
  }
  assert.equal(paramById('track.gain').mode, 'playback');
});

test('normalizeParamValue 钳制到参数范围，非法值回落默认值', () => {
  assert.equal(normalizeParamValue('curve.PIT', 99999), 1200);
  assert.equal(normalizeParamValue('curve.PIT', -99999), -1200);
  assert.equal(normalizeParamValue('track.gain', 99), 6);
  assert.equal(normalizeParamValue('track.gain', -99), -60);
  assert.equal(normalizeParamValue('track.gain', -6.5), -6.5);
  assert.equal(normalizeParamValue('curve.VOL', '3.5'), 3.5, '数字字符串也接受');
  assert.equal(normalizeParamValue('curve.VOL', NaN), CURVE_TARGETS.VOL.def);
  assert.equal(normalizeParamValue('curve.VOL', 'abc'), CURVE_TARGETS.VOL.def);
  assert.equal(normalizeParamValue('curve.NOPE', 1), null, '未知 id 不得返回数值');
});

test('注册表只读：运行时改不动范围/时机', () => {
  assert.equal(Object.isFrozen(PARAMS), true);
  const p = paramById('curve.PIT');
  assert.equal(Object.isFrozen(p), true);
  assert.equal(Object.isFrozen(p.engines), true);
  assert.throws(() => { 'use strict'; p.min = -1; });
});

test('「最后调整」的保留时长是短生命周期（>0 且 ≤10 分钟）', () => {
  assert.ok(LAST_TWEAK_TTL_MS > 0 && LAST_TWEAK_TTL_MS <= 10 * 60 * 1000);
});
