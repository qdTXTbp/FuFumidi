// 配色系统单测（2026-10-17 推倒重做）：两条正交轴上的每个控件都必须**改变颜色**。
// 旧版的教训是「数据变了、画面上全白」—— 所以这里既断言取色方式，也断言参数。
import test from 'node:test';
import assert from 'node:assert/strict';
import { noteColorOf, COLOR_MODES, COLOR_PRESETS, hslHex, toHsl } from '../src/core/viz/state/colors.js';

const NOTE = { pitch: 60, color: '#ff5530', vel: 90 };
const hex = /^#[0-9a-f]{6}$/;

test('输出永远是 #rrggbb（两条光栅器都能解析；旧版返回 hsl() 在 GPU 路径会变白）', () => {
  for (const m of COLOR_MODES) {
    for (const cs of [{}, { hueShift: 40 }, { satAdj: 20, lightAdj: -10 }]) {
      const c = noteColorOf(Object.assign({ colorMode: m.k }, cs), NOTE);
      assert.ok(hex.test(c), m.k + ' 应返回 hex，实际 ' + c);
    }
  }
});

test('轨道色默认与轨道色逐位一致（不改用户既有观感）', () => {
  assert.equal(noteColorOf({ colorMode: 'track' }, { pitch: 60, color: '#ff5530', vel: 90 }), '#ff5530');
  assert.equal(noteColorOf({ colorMode: 'track' }, { pitch: 40, color: '#4f9dff', vel: 60 }), '#4f9dff');
});

test('四种取色方式互不相同（旧版「按音高/按左右手」在界面上根本看不出来）', () => {
  const cols = COLOR_MODES.map((m) => noteColorOf({ colorMode: m.k, hueBase: 0, hueSpan: 330 }, NOTE));
  assert.equal(new Set(cols).size, COLOR_MODES.length, '四种方式应给出四种不同颜色，实际 ' + JSON.stringify(cols));
});

test('按音高：色相随音高铺开，且色相基准/跨度真的参与取色', () => {
  const lo = toHsl(noteColorOf({ colorMode: 'pitch', hueBase: 0, hueSpan: 300 }, { pitch: 24, color: '#fff', vel: 90 }));
  const hi = toHsl(noteColorOf({ colorMode: 'pitch', hueBase: 0, hueSpan: 300 }, { pitch: 105, color: '#fff', vel: 90 }));
  assert.ok(hi.h > lo.h, '音高越高色相越大：' + lo.h.toFixed(1) + ' → ' + hi.h.toFixed(1));
  const shifted = toHsl(noteColorOf({ colorMode: 'pitch', hueBase: 120, hueSpan: 300 }, { pitch: 24, color: '#fff', vel: 90 }));
  assert.ok(Math.abs(shifted.h - (lo.h + 120)) < 2, '色相基准必须整体平移');
  const narrow = toHsl(noteColorOf({ colorMode: 'pitch', hueBase: 0, hueSpan: 40 }, { pitch: 105, color: '#fff', vel: 90 }));
  assert.ok(narrow.h < hi.h, '色相跨度变小，最高音的色相也要跟着变小');
});

test('色相旋转/饱和/亮度对**所有**取色方式都生效（旧版「其它选项不生效」的根因）', () => {
  for (const m of COLOR_MODES) {
    const base = noteColorOf({ colorMode: m.k }, NOTE);
    assert.notEqual(noteColorOf({ colorMode: m.k, hueShift: 90 }, NOTE), base, m.k + ' 色相旋转应生效');
    assert.notEqual(noteColorOf({ colorMode: m.k, satAdj: -35 }, NOTE), base, m.k + ' 饱和度应生效');
    assert.notEqual(noteColorOf({ colorMode: m.k, lightAdj: 18 }, NOTE), base, m.k + ' 亮度应生效');
  }
});

test('按左右手用**用户自选**的两色（不再是写死的冷暖）', () => {
  const cfg = { colorMode: 'hand', handL: '#12ab34', handR: '#abcdef' };
  assert.equal(noteColorOf(cfg, { pitch: 40, color: '#000', vel: 90 }), '#12ab34');
  assert.equal(noteColorOf(cfg, { pitch: 80, color: '#000', vel: 90 }), '#abcdef');
});

test('按力度在两端色之间插值（强度越高越接近强色）', () => {
  const cfg = { colorMode: 'vel', velLow: '#0000ff', velHigh: '#ff0000' };
  // 色相是环形的，用"到强色的角距"判断方向（蓝 240° → 红 0/360°，短弧经品红）
  const dist = (c, target) => { const d = Math.abs(toHsl(c).h - target) % 360; return Math.min(d, 360 - d); };
  const soft = noteColorOf(cfg, { pitch: 60, color: '#000', vel: 10 });
  const mid = noteColorOf(cfg, { pitch: 60, color: '#000', vel: 64 });
  const hard = noteColorOf(cfg, { pitch: 60, color: '#000', vel: 127 });
  assert.equal(hard, '#ff0000', '满力度应恰好是强色');
  assert.ok(dist(mid, 0) < dist(soft, 0), '力度越大离强色越近：' + dist(soft, 0).toFixed(1) + ' → ' + dist(mid, 0).toFixed(1));
});

test('四个预设各自给出不同参数，点完能继续微调', () => {
  const keys = new Set(COLOR_PRESETS.map((p) => p.k));
  assert.equal(keys.size, COLOR_PRESETS.length);
  const a = noteColorOf(Object.assign({ colorMode: 'pitch' }, COLOR_PRESETS[0]), NOTE);
  const b = noteColorOf(Object.assign({ colorMode: 'pitch' }, COLOR_PRESETS[1]), NOTE);
  const c = noteColorOf(Object.assign({ colorMode: 'pitch' }, COLOR_PRESETS[2]), NOTE);
  assert.equal(new Set([a, b, c]).size, 3, '七彩/暖/冷 必须给出三种颜色');
  const mono = COLOR_PRESETS.find((p) => p.k === 'mono');
  const m1 = noteColorOf(Object.assign({ colorMode: 'pitch' }, mono), { pitch: 30, color: '#fff', vel: 90 });
  const m2 = noteColorOf(Object.assign({ colorMode: 'pitch' }, mono), { pitch: 100, color: '#fff', vel: 90 });
  assert.equal(m1, m2, '单色：跨度 0，不同音高同色');
});

test('hslHex/toHsl 往返一致（色相误差 < 1°）', () => {
  for (const [h, s, l] of [[0, 70, 58], [120, 55, 40], [250, 90, 66], [359, 20, 72]]) {
    const back = toHsl(hslHex(h, s, l));
    const dh = Math.min(Math.abs(back.h - h), 360 - Math.abs(back.h - h));
    // 8 位 RGB 量化：低饱和（S=20%）时色相分辨率本来就粗，给 3° 容差
    assert.ok(dh < 3, '色相往返 ' + h + ' → ' + back.h.toFixed(2));
    assert.ok(Math.abs(back.s - s) < 1.5 && Math.abs(back.l - l) < 1.5, 'S/L 往返');
  }
});

test('旧存档只有 colorBy 时按取色方式继续用（不丢用户设置）', () => {
  assert.equal(noteColorOf({ colorBy: 'hand', handL: '#111111', handR: '#222222' }, { pitch: 40, color: '#fff', vel: 90 }), '#111111');
});
