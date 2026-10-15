// 总谱（conductor's score）生成器的回归测试。
//
// ★ 为什么单独立一份测试：总谱和单轨谱是两套排版要求，下面每一条都对应过真实缺陷 ——
//   1. 小节长度按拍号分母算：旧版写死 num×tpb，6/8 的小节长了一倍，所有声部整体错位。
//   2. 空小节必须补整小节休止：总谱里大量乐器整段不演奏，空 <measure/> 是非法 XML。
//   3. 同刻起音 = <chord/>：不加就会被当成先后演奏，钢琴和弦全散架。
//   4. 时间重叠 = 多条 <voice> + <backup>：否则长音下面走不动旋律。
//   5. 多声部要有谱表括号 <part-group>，且每个音符带 xml:id（界面靠它做播放高亮）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFullScore, splitVoices } from '../src/core/musicxml_out.js';

function song6_8(tracks) {
  return {
    tpb: 480,
    sigMap: [{ num: 6, den: 8 }],
    totalTicks: 1440 * 2,
    bars: 2,
    tracks,
  };
}
const tr = (name, notes) => ({ name, program: 0, notes });

test('总谱：小节长度按拍号分母算（6/8 一小节 = 1440 tick）', () => {
  const s = song6_8([tr('Flute', [{ start: 0, end: 480, midi: 72, velocity: 80 }])]);
  const r = buildFullScore(s);
  assert.equal(r.barLen, 1440, '6/8 的小节是 6×480×4/8，不是 6×480');
  assert.equal(r.bars, 2);
});

test('总谱：空小节补整小节休止（不是空 <measure/>）', () => {
  const s = song6_8([tr('Flute', [{ start: 0, end: 480, midi: 72, velocity: 80 }])]);
  const xml = buildFullScore(s).xml;
  assert.ok(xml.includes('<rest measure="yes"/><duration>1440</duration>'), '第二小节应是整小节休止');
  assert.ok(!/<measure number="2">\s*<\/measure>/.test(xml), '不允许出现空小节');
});

test('总谱：同刻起音写成 <chord/>（和弦不散架）', () => {
  const s = song6_8([tr('Piano', [
    { start: 0, end: 480, midi: 60, velocity: 80 },
    { start: 0, end: 480, midi: 64, velocity: 80 },
    { start: 0, end: 480, midi: 67, velocity: 80 },
  ])]);
  const xml = buildFullScore(s).xml;
  assert.equal((xml.match(/<chord\/>/g) || []).length, 2, '三音和弦 = 两个 <chord/>');
  assert.equal((xml.match(/<note /g) || []).length, 3);
});

test('总谱：时间重叠的音符拆成多声部 + <backup>', () => {
  const s = song6_8([tr('Cello', [
    { start: 0, end: 1440, midi: 48, velocity: 80 },
    { start: 480, end: 960, midi: 55, velocity: 80 },
  ])]);
  const xml = buildFullScore(s).xml;
  assert.ok(xml.includes('<voice>1</voice>'), '长音在声部 1');
  assert.ok(xml.includes('<voice>2</voice>'), '走动的那条在声部 2');
  assert.ok(xml.includes('<backup><duration>1440</duration></backup>'), '换声部要 backup 回小节头');
});

test('总谱：多声部带谱表括号、每轨一条 part，音符 id 能在 noteMap 里查到', () => {
  const s = song6_8([
    tr('Part 1', [{ start: 0, end: 480, midi: 72, velocity: 80 }]),
    tr('Part 2', [{ start: 480, end: 960, midi: 55, velocity: 80 }]),
  ]);
  const r = buildFullScore(s);
  assert.equal(r.partCount, 2);
  assert.equal((r.xml.match(/<part id=/g) || []).length, 2);
  assert.ok(r.xml.includes('<part-group type="start" number="1"><group-symbol>bracket</group-symbol>'), '两条以上要加括号组');
  assert.equal(r.noteMap.size, 2);
  for (const id of r.noteMap.keys()) assert.ok(r.xml.includes('xml:id="' + id + '"'), id + ' 应在 XML 里');
  const one = [...r.noteMap.values()][0];
  assert.equal(one.tick, 0);
  assert.equal(one.midi, 72);
  assert.equal(one.track, 0);
});

test('总谱：空轨不进总谱、鼓轨排除', () => {
  const s = song6_8([
    tr('Part 1', [{ start: 0, end: 480, midi: 72, velocity: 80 }]),
    tr('Empty', []),
    { name: 'Drums', isDrum: true, program: 0, notes: [{ start: 0, end: 480, midi: 38, velocity: 90 }] },
  ]);
  const r = buildFullScore(s);
  assert.equal(r.partCount, 1, '空轨与鼓轨都不进总谱');
});

test('splitVoices：同刻起音归同一组，重叠才另起声部', () => {
  const vs = splitVoices([
    { start: 0, end: 480, midi: 60 },
    { start: 0, end: 480, midi: 64 },
    { start: 240, end: 720, midi: 67 },
  ], 1440);
  assert.equal(vs.length, 2, '和弦组 + 重叠音 = 两声部');
  assert.equal(vs[0].notes.length, 2, '和弦两个音在同一组');
  assert.equal(vs[1].notes.length, 1);
});
