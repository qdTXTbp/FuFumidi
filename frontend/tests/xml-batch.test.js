// 批量 MusicXML 导出：文件名规划 + 只读加载曲目（回归 B 站 2026-11-09 反馈）
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeMidi } from '../src/core/midi.js';
import {
  safeFileBase, uniqueName, jobsForSong, toBytes, songFromBytes, loadSongForExport,
} from '../src/core/xml_batch.js';

function fakeSong() {
  return {
    name: 'demo.mid', tpb: 480, bars: 1, totalTicks: 1920,
    sigMap: [{ num: 4, den: 4 }], tempoMap: [{ tick: 0, us: 500000 }],
    tracks: [
      { name: 'Piano', program: 0, ch: 0, events: [], notes: [{ start: 0, end: 480, midi: 60, vel: 80 }] },
      { name: 'Drums', isDrum: true, ch: 9, events: [], notes: [{ start: 0, end: 480, midi: 36, vel: 90 }] },
    ],
  };
}

test('safeFileBase：去扩展名 / 洗非法字符 / 去尾点 / 空名兜底', () => {
  assert.equal(safeFileBase('夜曲.mid'), '夜曲');
  assert.equal(safeFileBase('a/b:c*d?e"f<g>h|i.midi'), 'a_b_c_d_e_f_g_h_i');
  assert.equal(safeFileBase('曲名... '), '曲名');
  assert.equal(safeFileBase('', 'score'), 'score');
  assert.equal(safeFileBase('\\'), '_');
});

test('uniqueName：大小写不敏感去重，同名加序号', () => {
  const used = new Set();
  assert.equal(uniqueName(used, 'A.musicxml'), 'A.musicxml');
  assert.equal(uniqueName(used, 'a.musicxml'), 'a (2).musicxml');
  assert.equal(uniqueName(used, 'A (2).musicxml'), 'A (2) (2).musicxml');
  assert.equal(uniqueName(used, 'B.musicxml'), 'B.musicxml');
});

test('jobsForSong：总谱模式每首一份，XML 结构合法', () => {
  const jobs = jobsForSong({ name: '夜曲.mid' }, fakeSong(), 'score', new Set());
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].file, '夜曲.musicxml');
  assert.match(jobs[0].xml, /<score-partwise version="3\.1">/);
  assert.match(jobs[0].xml, /<part-name>Piano<\/part-name>/);
});

test('jobsForSong：分谱模式跳过鼓轨，轨名进文件名且非法字符被洗掉', () => {
  const song = fakeSong();
  song.tracks[0].name = 'Lead/Voice';
  const jobs = jobsForSong({ name: 'demo' }, song, 'parts', new Set());
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].file, 'demo - Lead_Voice.musicxml');
  assert.match(jobs[0].xml, /<score-partwise/);
});

test('jobsForSong：没有可导出轨时退回总谱，不静默产出 0 个文件', () => {
  const song = fakeSong();
  song.tracks = [{ name: 'Drums', isDrum: true, notes: [{ start: 0, end: 480, midi: 36 }], events: [] }];
  const jobs = jobsForSong({ name: 'only-drums' }, song, 'parts', new Set());
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].file, 'only-drums.musicxml');
});

test('整批共享 used：两首同名曲不会互相覆盖', () => {
  const used = new Set();
  const a = jobsForSong({ name: '同一首.mid' }, fakeSong(), 'score', used);
  const b = jobsForSong({ name: '同一首.mid' }, fakeSong(), 'score', used);
  assert.notEqual(a[0].file, b[0].file);
  assert.equal(b[0].file, '同一首 (2).musicxml');
});

test('toBytes / songFromBytes：多形态字节归一化，坏字节返回 null', () => {
  const u8 = new Uint8Array([1, 2, 3]);
  assert.deepEqual(toBytes(u8), u8);
  assert.deepEqual([...toBytes(u8.buffer)], [1, 2, 3]);
  assert.deepEqual([...toBytes([1, 2, 3])], [1, 2, 3]);
  assert.deepEqual([...toBytes({ bytes: [1, 2, 3] })], [1, 2, 3]);
  assert.equal(songFromBytes(new Uint8Array([1, 2]), 'x'), null);
  assert.equal(songFromBytes(null, 'x'), null);
});

test('loadSongForExport：已解析的直接命中，不碰 bridge', async () => {
  const song = fakeSong();
  const item = { id: 's1', name: 'a.mid', song };
  assert.equal(await loadSongForExport(item, null), song);
});

test('loadSongForExport：内存坏字节时按 SQLite → 磁盘回退，成功后缓存 song', async () => {
  const midi = encodeMidi([{ name: 'Piano', notes: [{ start: 0, end: 480, midi: 60, vel: 80 }] }], { division: 480 });
  const item = { id: 's2', name: 'b.mid', __bytes: new Uint8Array([0, 0]), meta: { path: '' } };
  const bridge = {
    dbSongsList: async () => [{ id: 's2', bytes: Array.from(midi) }],
    readBinary: async () => null,
  };
  const song = await loadSongForExport(item, bridge);
  assert.ok(song && song.tracks.length, '应能从 SQLite 字节解析出 song');
  assert.equal(item.song, song, '解析结果应缓存，下一批直接命中');
});

test('loadSongForExport：所有来源都拿不到时返回 null 且不写缓存', async () => {
  const item = { id: 's3', name: 'c.mid', meta: { path: '' } };
  const bridge = { dbSongsList: async () => [], readBinary: async () => null };
  assert.equal(await loadSongForExport(item, bridge), null);
  assert.equal(item.song, undefined);
});
