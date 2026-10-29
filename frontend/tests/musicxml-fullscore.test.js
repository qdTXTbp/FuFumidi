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
import { buildFullScore, songToMusicXMLTrack, splitVoices, splitNoteAtBarlines, metronomeXml } from '../src/core/musicxml_out.js';
import { buildSong } from '../src/core/midi.js';

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

/* ---------------- 速度记号 + 小节数（2026-10-18：转谱速度/截断两个真实缺陷） ---------------- */

test('★ 速度记号：x/8 拍按**附点四分**记，且 per-minute 与 beat-unit 成对换算', () => {
  // 3/8、6/8 是复合拍：谱面惯例记成「附点四分 = 60」（= 四分音符 90）
  for (const sig of [{ num: 3, den: 8 }, { num: 6, den: 8 }, { num: 9, den: 8 }, { num: 12, den: 8 }]) {
    const xml = metronomeXml(sig, 90);
    assert.ok(xml.includes('<beat-unit>quarter</beat-unit><beat-unit-dot/>'), '复合拍应带附点：' + xml);
    assert.ok(xml.includes('<per-minute>60</per-minute>'), '附点四分 = 60 才是四分音符 90：' + xml);
  }
  // 简单拍仍按四分音符
  assert.ok(metronomeXml({ num: 4, den: 4 }, 90).includes('<per-minute>90</per-minute>'));
  assert.ok(!metronomeXml({ num: 4, den: 4 }, 90).includes('<beat-unit-dot/>'));
  assert.ok(metronomeXml({ num: 2, den: 4 }, 120).includes('<per-minute>120</per-minute>'));
  // 3/4 不是复合拍（附点四分记号在那儿是错的）
  assert.ok(metronomeXml({ num: 3, den: 4 }, 120).includes('<per-minute>120</per-minute>'));
});

test('★ 总谱：速度记号写进 XML（附点写法），sound tempo 仍是四分音符 BPM', () => {
  const s = song6_8([tr('Flute', [{ start: 0, end: 480, midi: 72, velocity: 80 }])]);
  s.tempoMap = [{ tick: 0, us: 666667 }];            // 90 BPM
  const xml = buildFullScore(s).xml;
  assert.ok(xml.includes('<beat-unit-dot/><per-minute>60</per-minute>'), '6/8 应写成附点四分 = 60');
  assert.ok(xml.includes('<sound tempo="90"/>'), 'MIDI 速度仍是四分音符 90');
});

test('★ 小节数按拍号算（旧写法假定 4/4，3/8 曲子会被算成 1/3 小节数 → 转谱截断）', () => {
  const mid = {
    format: 1, ticksPerBeat: 480,
    tracks: [{ name: 'T', ch: 0, program: 0, events: [{ tick: 0, type: 'sig', num: 3, den: 8 }],
               notes: [{ start: 0, end: 720 * 87, midi: 60, vel: 80 }] }],
  };
  const song = buildSong(mid);
  // 87 小节 × 720 tick（3/8）= 62640 tick，加一拍余量后 ceil 到 88
  assert.equal(song.sigMap[0].num, 3);
  assert.equal(song.bars, Math.ceil(song.totalTicks / 720), '3/8 的一小节是 720 tick');
  assert.ok(song.bars >= 87, '87 小节以上，实际 ' + song.bars);
});

/* ============================================================
 * F-07：跨小节时值 / 连音线
 *
 * 旧行为：一个 3 小节的持续音只在第 1 小节写出一个 duration=5760 的 <note>，
 * 后两小节什么都没有，也没有 tie。Verovio 会把这一小节撑破/丢音。
 * 现在按小节线切片，每片写本片的 duration/type，片与片之间用
 * <tie type="start|stop"> + <notations><tied ...> 连接。
 * ============================================================ */

/** 按小节号取出 measure 内部 XML（1-based；测试里只放一个 part）。 */
function measureBodies(xml) {
  const out = [];
  const re = /<measure number="(\d+)">([\s\S]*?)<\/measure>/g;
  let m;
  while ((m = re.exec(xml))) out[Number(m[1]) - 1] = m[2];
  return out;
}

/** 只取带 <pitch> 的音符（休止符不算），并抽出时值/类型/连音线标记。 */
function pitchedNotes(xml) {
  const out = [];
  const re = /<note(?: [^>]*)?>([\s\S]*?)<\/note>/g;
  let m;
  while ((m = re.exec(xml))) {
    const body = m[1];
    if (!body.includes('<pitch>')) continue;
    out.push({
      duration: Number((body.match(/<duration>(\d+)<\/duration>/) || [])[1] || 0),
      type: (body.match(/<type>([^<]+)<\/type>/) || [])[1] || '',
      tieStart: /<tie type="start"\/>/.test(body),
      tieStop: /<tie type="stop"\/>/.test(body),
      tiedStart: /<tied type="start"\/>/.test(body),
      tiedStop: /<tied type="stop"\/>/.test(body),
    });
  }
  return out;
}

function notesInMeasure(xml, number) {
  return pitchedNotes(measureBodies(xml)[number - 1] || '');
}

function song44(notes, bars) {
  return {
    tpb: 480,
    sigMap: [{ num: 4, den: 4 }],
    totalTicks: bars * 1920,
    bars,
    tracks: [tr('Lead', notes)],
  };
}

test('★ F-07 单轨：跨 2 小节长音拆成两片，用 <tie>/<tied> 连接', () => {
  const s = song44([{ start: 0, end: 3840, midi: 72, velocity: 80 }], 2);
  const xml = songToMusicXMLTrack(s, 0);
  const first = notesInMeasure(xml, 1);
  const second = notesInMeasure(xml, 2);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.deepEqual(first.map(n => [n.duration, n.type]), [[1920, 'whole']]);
  assert.deepEqual(second.map(n => [n.duration, n.type]), [[1920, 'whole']]);
  assert.deepEqual([first[0].tieStart, first[0].tieStop], [true, false]);
  assert.deepEqual([first[0].tiedStart, first[0].tiedStop], [true, false]);
  assert.deepEqual([second[0].tieStart, second[0].tieStop], [false, true]);
  assert.deepEqual([second[0].tiedStart, second[0].tiedStop], [false, true]);
  assert.ok(!xml.includes('<duration>3840</duration>'), '整段时值不能写进起始小节');
});

test('★ F-07 单轨：从小节中段起的长音，每片 duration/type 按本片长度算（960 = half）', () => {
  const s = song44([{ start: 960, end: 2880, midi: 72, velocity: 80 }], 2);
  const xml = songToMusicXMLTrack(s, 0);
  const first = notesInMeasure(xml, 1);
  const second = notesInMeasure(xml, 2);
  assert.deepEqual(first.map(n => [n.duration, n.type]), [[960, 'half']]);
  assert.deepEqual(second.map(n => [n.duration, n.type]), [[960, 'half']]);
  assert.equal(first[0].tieStart, true);
  assert.equal(second[0].tieStop, true);
});

test('★ F-07 总谱：跨 3 小节的音符拆成三片，连音线 start → start+stop → stop', () => {
  const s = song44([{ start: 0, end: 5760, midi: 72, velocity: 80 }], 3);
  const r = buildFullScore(s);
  const bars = [1, 2, 3].map(n => notesInMeasure(r.xml, n));
  assert.deepEqual(bars.map(x => x.length), [1, 1, 1]);
  assert.deepEqual(bars.map(x => x[0].duration), [1920, 1920, 1920]);
  assert.deepEqual(bars.map(x => x[0].type), ['whole', 'whole', 'whole']);
  assert.deepEqual(bars.map(x => [x[0].tieStart, x[0].tieStop]), [[true, false], [true, true], [false, true]]);
  assert.deepEqual(bars.map(x => [x[0].tiedStart, x[0].tiedStop]), [[true, false], [true, true], [false, true]]);
  assert.equal(r.noteMap.size, 3, '每个分片一个 xml:id');
  assert.deepEqual([...r.noteMap.values()].map(n => n.tick), [0, 1920, 3840]);
  assert.deepEqual([...r.noteMap.values()].map(n => n.noteStart), [0, 0, 0]);
});

test('★ F-07 同音高相邻但中间有休止 → 不误判连音线（单轨 + 总谱）', () => {
  const notes = [
    { start: 0, end: 480, midi: 60, velocity: 80 },
    { start: 960, end: 1440, midi: 60, velocity: 80 },
  ];
  const xmls = [
    songToMusicXMLTrack(song44(notes, 1), 0),
    buildFullScore(song44(notes, 1)).xml,
  ];
  for (const xml of xmls) {
    assert.equal((xml.match(/<tie type=/g) || []).length, 0);
    assert.equal((xml.match(/<tied type=/g) || []).length, 0);
  }
});

test('★ F-07 跨小节长音的尾片不会和后面的同音高音符误连（中间有休止）', () => {
  const s = song44([
    { start: 0, end: 2400, midi: 60, velocity: 80 },     // 跨到第 2 小节，尾片 1920–2400
    { start: 2640, end: 2880, midi: 60, velocity: 80 },  // 同音高，但中间空了 240 tick
  ], 2);
  const xmls = [
    songToMusicXMLTrack(s, 0),
    buildFullScore(s).xml,
  ];
  for (const xml of xmls) {
    const first = notesInMeasure(xml, 1);
    const second = notesInMeasure(xml, 2);
    assert.equal(first[0].tieStart, true, '长音起片应起连音线');
    assert.equal(second.length, 2);
    assert.deepEqual([second[0].tieStart, second[0].tieStop], [false, true], '尾片只收连音线');
    assert.deepEqual([second[1].tieStart, second[1].tieStop], [false, false], '后面那个同音高音符是独立音');
  }
});

test('★ F-07 不破坏原有逻辑：同音高、首尾相接的相邻音符仍然连', () => {
  const s = song44([
    { start: 0, end: 960, midi: 60, velocity: 80 },
    { start: 960, end: 1920, midi: 60, velocity: 80 },
  ], 1);
  const notes = notesInMeasure(songToMusicXMLTrack(s, 0), 1);
  assert.equal(notes.length, 2);
  assert.deepEqual([notes[0].tieStart, notes[0].tieStop], [true, false]);
  assert.deepEqual([notes[1].tieStart, notes[1].tieStop], [false, true]);
});

test('splitNoteAtBarlines：正好落在小节线上不产生空片段；跨 3 小节按 3 片切', () => {
  const one = splitNoteAtBarlines({ start: 0, end: 1920 }, 1920);
  assert.equal(one.length, 1);
  assert.deepEqual([one[0].bar, one[0].start, one[0].end], [0, 0, 1920]);
  assert.deepEqual([one[0].tieStart, one[0].tieStop], [false, false]);

  const three = splitNoteAtBarlines({ start: 960, end: 4800 }, 1920);
  assert.deepEqual(three.map(p => [p.bar, p.start, p.end]), [[0, 960, 1920], [1, 1920, 3840], [2, 3840, 4800]]);
  assert.deepEqual(three.map(p => [p.tieStart, p.tieStop]), [[true, false], [true, true], [false, true]]);
});

test('★ F-07 和弦里有一条跨小节长音：长音未结束前不得补休止（小节总长不超）', () => {
  const s = song44([
    { start: 0, end: 480, midi: 60, velocity: 80 },     // 短音
    { start: 0, end: 2400, midi: 64, velocity: 80 },    // 跨到第 2 小节
  ], 2);
  const xml = buildFullScore(s).xml;
  const bodies = measureBodies(xml);
  const first = pitchedNotes(bodies[0]);
  assert.equal(first.length, 2, '同刻起音仍是和弦');
  assert.deepEqual(first.map(n => n.duration).sort((a, b) => a - b), [480, 1920]);
  assert.ok(!bodies[0].includes('<rest/>'), '长音还没结束就补休止会把小节撑长');
  const second = pitchedNotes(bodies[1]);
  assert.equal(second.length, 1);
  assert.equal(second[0].duration, 480);
  assert.equal(second[0].tieStop, true);
});

test('★ F-07 song.bars 偏小时也把跨小节分片写全（不产生只有 start 没有 stop 的悬空连音线）', () => {
  // 故意把 bars 设成 1，而音符跨到第 2 小节：生成器必须自行把第 2 小节补出来
  const s = song44([{ start: 0, end: 3840, midi: 72, velocity: 80 }], 1);
  for (const xml of [songToMusicXMLTrack(s, 0), buildFullScore(s).xml]) {
    assert.equal((xml.match(/<measure number="/g) || []).length, 2);
    assert.equal(notesInMeasure(xml, 2)[0].tieStop, true);
  }
});
