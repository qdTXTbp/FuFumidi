// P2-5 DAWproject 导出/导入（XML 子集）测试
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAWPROJECT_VERSION, normalizeDawprojectModel, songToDawprojectModel,
  buildProjectXml, buildMetadataXml, makeDawprojectFiles, parseProjectXml,
} from '../src/core/dawproject.js';

const SONG = {
  name: 'P2-5 Song', artist: 'Tester', bpm: 128, tpb: 480, totalTicks: 480 * 8,
  timeSignature: { numerator: 6, denominator: 8 },
  tracks: [
    { name: 'Lead <&>', notes: [
      { start: 0, end: 480, midi: 60, vel: 100, ch: 0 },
      { start: 480, end: 960, midi: 64, vel: 64, ch: 1 },
    ] },
    { name: 'Chords', notes: [{ start: 0, end: 1920, midi: 48, vel: 80 }] },
  ],
};

test('P2-5 模型规范化：bpm/拍号夹紧、空轨与非法音符剔除', () => {
  const m = normalizeDawprojectModel({
    bpm: 9999, timeSignature: { numerator: 0, denominator: 3 },
    tracks: [
      { name: 'A', notes: [{ start: -1, duration: 1, key: 60 }, { start: 4, duration: 0, key: 60 }, { start: 1, duration: 2, key: 200 }] },
      { name: 'Empty', notes: [] },
      { name: 'B', notes: [{ start: 0, duration: 1, key: 60, vel: 3 }] },
    ],
  });
  assert.equal(m.bpm, 666);
  assert.equal(m.timeSignature.numerator, 1);
  assert.ok([2, 4].includes(m.timeSignature.denominator), '分母必须是 2 的幂：' + m.timeSignature.denominator);
  assert.equal(m.tracks.length, 1);
  assert.equal(m.tracks[0].name, 'B');
  assert.equal(m.tracks[0].notes[0].vel, 1);
});

test('P2-5 song→模型：tick/tpb 直接换算 beats（变速曲目也正确）', () => {
  const m = songToDawprojectModel(SONG);
  assert.equal(m.bpm, 128);
  assert.equal(m.timeSignature.numerator, 6);
  assert.equal(m.durationBeats, 8);
  assert.equal(m.tracks.length, 2);
  assert.equal(m.tracks[0].notes[0].start, 0);
  assert.equal(m.tracks[0].notes[0].duration, 1);
  assert.equal(m.tracks[0].notes[1].start, 1);
  assert.equal(m.tracks[1].notes[0].duration, 4);
  assert.ok(Math.abs(m.tracks[0].notes[0].vel - 100 / 127) < 1e-5, '力度按 6 位小数规整');
});

test('P2-5 XML：官方结构关键节点/属性齐全', () => {
  const xml = buildProjectXml(songToDawprojectModel(SONG), { appVersion: '6.0.0' });
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"/);
  assert.ok(xml.includes('<Project version="' + DAWPROJECT_VERSION + '">'));
  assert.ok(xml.includes('<Application name="FuFumidi" version="6.0.0"/>'));
  assert.match(xml, /<Tempo[^>]*unit="bpm"[^>]*value="128"/);
  assert.match(xml, /<TimeSignature[^>]*numerator="6"[^>]*denominator="8"/);
  assert.ok(xml.includes('role="master"'), '必须有 Master 轨');
  assert.ok(xml.includes('destination='), '普通轨要指向 master channel');
  assert.ok(xml.includes('contentType="notes"'));
  assert.match(xml, /<Clip time="0\.0" duration="8"/);
  assert.match(xml, /<Note[^>]*time="0\.000000"[^>]*duration="1\.000000"[^>]*key="60"/);
  assert.ok(xml.includes('<Scenes/>'));
  assert.ok(xml.includes('<Markers>') === false, '无标记不输出 Markers 块');
});

test('P2-5 XML 转义：轨道名/元数据里的特殊字符', () => {
  const xml = buildProjectXml(songToDawprojectModel(SONG));
  assert.ok(xml.includes('name="Lead &lt;&amp;&gt;"'));
  const meta = buildMetadataXml(songToDawprojectModel({ ...SONG, name: 'A & B <C>' }));
  assert.ok(meta.includes('<Title>A &amp; B &lt;C&gt;</Title>'));
});

test('P2-5 往返：导出后 parse 回来音符数量/音高/时值一致', () => {
  const model = songToDawprojectModel(SONG);
  const xml = buildProjectXml(model);
  const back = parseProjectXml(xml);
  assert.equal(back.ok, true);
  assert.equal(back.version, DAWPROJECT_VERSION);
  assert.equal(back.application.name, 'FuFumidi');
  assert.equal(back.bpm, 128);
  assert.equal(back.timeSignature.numerator, 6);
  assert.equal(back.timeSignature.denominator, 8);
  assert.equal(back.tracks.length, 2);
  assert.equal(back.tracks[0].name, 'Lead <&>');
  assert.deepEqual(back.tracks[0].notes.map((n) => [n.key, n.start, n.duration]), [[60, 0, 1], [64, 1, 1]]);
  assert.deepEqual(back.tracks[1].notes.map((n) => n.key), [48]);
});

test('P2-5 包内文件：project.xml + metadata.xml，UTF-8 文本', () => {
  const { files, model } = makeDawprojectFiles(songToDawprojectModel(SONG));
  assert.equal(files.length, 2);
  assert.equal(files[0].name, 'project.xml');
  assert.equal(files[1].name, 'metadata.xml');
  assert.ok(files[0].data.includes('<Project'));
  assert.ok(files[1].data.includes('<MetaData>'));
  assert.ok(!JSON.stringify(files).includes('NaN'));
  assert.equal(model.title, 'P2-5 Song');
});

test('P2-5 标记与空工程安全', () => {
  const withMarkers = buildProjectXml(normalizeDawprojectModel({
    bpm: 120, tracks: [{ name: 'T', notes: [{ start: 0, duration: 1, key: 60 }] }],
    markers: [{ time: 2, name: 'Chorus' }, { time: -1, name: 'Bad' }],
  }));
  assert.match(withMarkers, /<Markers>[\s\S]*<Marker time="2\.000000" name="Chorus"\/>[\s\S]*<\/Markers>/);
  assert.ok(!withMarkers.includes('name="Bad"'));
  const empty = normalizeDawprojectModel({});
  assert.equal(empty.tracks.length, 0);
  assert.ok(Number.isFinite(empty.durationBeats) && empty.durationBeats >= 1);
  assert.equal(parseProjectXml('not xml').ok, false);
});

test('P2-5 颜色：只接受 #RRGGBB，其它丢弃', () => {
  const m = normalizeDawprojectModel({ tracks: [
    { name: 'A', color: '#a2eabf', notes: [{ start: 0, duration: 1, key: 60 }] },
    { name: 'B', color: 'red', notes: [{ start: 0, duration: 1, key: 61 }] },
  ] });
  assert.equal(m.tracks[0].color, '#a2eabf');
  assert.equal(m.tracks[1].color, '');
  assert.ok(buildProjectXml(m).includes('color="#a2eabf"'));
});
