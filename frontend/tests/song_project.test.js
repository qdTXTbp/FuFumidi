// `.fufumidi` 工程格式的测试。
//
// ★ 要验的三件事：
//   1. **往返不丢字段** —— 存了再打开，音符/轨道/BPM 得原样回来
//   2. **本机绝对路径不外泄** —— 这是"自包含"的全部意义，包里出现 `C:\` 就是 bug
//   3. **脏数据不崩** —— 手改过的工程文件（超范围音高、缺字段、非法 assetId）
//      要么被兜底成合法值，要么被明确拒绝，绝不能写盘时静默损坏
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FORMAT_ID, FORMAT_VERSION, PROJECT_EXT,
  serializeProject, parseProject, resolveAssetPaths, missingAssets,
  safeAssetId, extOf, assetEntryName,
} from '../src/core/song_project.js';

function voiceTrack(over) {
  return Object.assign({
    id: 'tr1', name: '主旋律', kind: 'voice', engine: 'diffsinger',
    singer: 'D:/banks/amy', singerName: 'amy', language: 'zh',
    notes: [
      { id: 'n1', startBeat: 0, durBeat: 1, pitch: 60, lyric: 'あ',
        vibrato: true, vibDepth: 35, vibFreq: 5.5, vibFade: 10, pitchOffset: -3 },
      { id: 'n2', startBeat: 1, durBeat: 0.5, pitch: 67, lyric: '',
        vibrato: false, vibDepth: 35, vibFreq: 5.5, vibFade: 0 },
    ],
    pitchCurve: [{ beat: 0, cents: 0 }, { beat: 1, cents: -20 }],
    depth: 0.85, steps: 25,
  }, over || {});
}

function audioTrack(over) {
  return Object.assign({
    id: 'tr2', name: '伴奏', kind: 'audio', engine: 'utau',
    singer: '', language: 'zh', notes: [], pitchCurve: [],
    audio: {
      path: 'C:\\Users\\me\\Music\\backing.wav', fileName: 'backing.wav',
      durationMs: 92000, skip: 0, trim: 0, fadeIn: 500, fadeOut: 800,
      gainDb: -3, muted: false,
    },
  }, over || {});
}

function state(over) {
  return Object.assign({
    tracks: [voiceTrack()],
    bpm: 96, device: 'cuda', sampleNote: 'a', activeTrackId: 'tr1',
    meta: { title: '测试曲', comment: '备注', artist: '某人' },
  }, over || {});
}

/* ------------------------------------------------------------ 往返 */

test('往返：声部轨的字段原样回来', () => {
  const { json } = serializeProject(state());
  const r = parseProject(json);
  assert.equal(r.ok, true, r.error);
  const t = r.project.tracks[0];
  assert.equal(t.id, 'tr1');
  assert.equal(t.name, '主旋律');
  assert.equal(t.engine, 'diffsinger');
  assert.equal(t.singer, 'D:/banks/amy');
  assert.equal(t.language, 'zh');
  assert.equal(t.depth, 0.85);
  assert.equal(t.steps, 25);
  assert.equal(t.notes.length, 2);
  assert.equal(t.notes[0].lyric, 'あ');
  assert.equal(t.notes[0].pitchOffset, -3);
  assert.equal(t.notes[0].vibrato, true);
  assert.deepEqual(t.pitchCurve, [{ beat: 0, cents: 0 }, { beat: 1, cents: -20 }]);
  assert.equal(r.project.bpm, 96);
  assert.equal(r.project.device, 'cuda');
  assert.equal(r.project.meta.title, '测试曲');
  assert.equal(r.project.activeTrackId, 'tr1');
});

test('往返两次结果稳定（第二次不产生漂移）', () => {
  const a = serializeProject(state({ tracks: [voiceTrack(), audioTrack()] })).json;
  const p1 = parseProject(a).project;
  const b = serializeProject(p1).json;
  const p2 = parseProject(b).project;
  assert.deepEqual(JSON.parse(JSON.stringify(p2.tracks)), JSON.parse(JSON.stringify(p1.tracks)));
});

test('音频轨：asset 落定后再次保存保持不变', () => {
  const first = serializeProject(state({ tracks: [audioTrack()] }));
  assert.equal(first.assets.length, 1);
  const id = first.json.tracks[0].audio.asset;
  assert.ok(id, '首次保存应分配 asset id');

  // 模拟"打开工程后 path 已回填到解包出来的缓存路径"
  const opened = resolveAssetPaths(parseProject(first.json).project.tracks, { [id]: 'D:\\cache\\' + id + '.wav' });
  const second = serializeProject(Object.assign(state(), { tracks: opened }));
  assert.equal(second.json.tracks[0].audio.asset, id, 'asset id 不该变');
  assert.equal(second.assets[0].srcPath, 'D:\\cache\\' + id + '.wav', '源路径应指向当前可读文件');
});

/* ------------------------------------------------------------ 硬约束：路径不外泄 */

test('★ 工程包里不含任何本机绝对路径', () => {
  const { json } = serializeProject(state({ tracks: [voiceTrack(), audioTrack()] }));
  const dump = JSON.stringify(json);
  assert.ok(!dump.includes('C:\\'), '不该出现 Windows 绝对路径：' + dump.slice(0, 200));
  assert.ok(!dump.includes('backing.wav'.slice(0, 0) + 'C:'), '');
  assert.ok(!dump.includes('/Users/'), '不该出现 macOS 绝对路径');
  assert.ok(!dump.includes('"path"'), '不该有 path 字段：' + dump.slice(0, 300));
});

test('音频轨序列化后只有 asset，没有 path', () => {
  const { json } = serializeProject(state({ tracks: [audioTrack()] }));
  const a = json.tracks[0].audio;
  assert.ok(!('path' in a), 'audio 里不应有 path 键');
  assert.ok(a.asset.length > 0);
  assert.equal(a.fileName, 'backing.wav');
  assert.equal(a.durationMs, 92000);
  assert.equal(a.gainDb, -3);
});

test('assets 清单带待打包的源路径（只在保存这一刻有效）', () => {
  const { assets } = serializeProject(state({ tracks: [voiceTrack(), audioTrack()] }));
  assert.equal(assets.length, 1);
  assert.equal(assets[0].srcPath, 'C:\\Users\\me\\Music\\backing.wav');
  assert.equal(assets[0].fileName, 'backing.wav');
  assert.ok(safeAssetId(assets[0].id), 'id 必须是合法 assetId');
});

test('未选中任何轨时 activeTrackId 落到第一条', () => {
  const { json } = serializeProject(state({ activeTrackId: '不存在的轨' }));
  const r = parseProject(json);
  assert.equal(r.project.activeTrackId, 'tr1');
});

/* ------------------------------------------------------------ 拒绝打开 */

test('不是本格式 → 拒绝', () => {
  const r = parseProject({ format: 'something-else', version: 1, tracks: [] });
  assert.equal(r.ok, false);
  assert.match(r.error, /不是 FuFumidi 工程文件/);
});

test('版本比当前新 → 拒绝并提示升级', () => {
  const r = parseProject({ format: FORMAT_ID, version: FORMAT_VERSION + 1, tracks: [voiceTrack()] });
  assert.equal(r.ok, false);
  assert.match(r.error, /请升级/);
});

test('没有轨道 → 拒绝', () => {
  assert.equal(parseProject({ format: FORMAT_ID, version: 1 }).ok, false);
  assert.equal(parseProject({ format: FORMAT_ID, version: 1, tracks: [] }).ok, false);
  assert.equal(parseProject(null).ok, false);
  assert.equal(parseProject([]).ok, false);
});

/* ------------------------------------------------------------ 脏数据兜底 */

test('超范围的音高/时长/颤音被夹回合法区间', () => {
  const dirty = {
    format: FORMAT_ID, version: 1, bpm: 99999,
    tracks: [{
      id: 't', kind: 'voice', engine: 'utau',
      notes: [
        { id: 'a', startBeat: -5, durBeat: 0, pitch: 900, lyric: 'x', vibDepth: 999, vibFreq: -1 },
        { id: 'b', startBeat: 2, durBeat: 1, pitch: -3, lyric: 'y' },
        'not an object', null,
      ],
      pitchCurve: [{ beat: 1, cents: 10 }, null, { beat: 'x', cents: 'y' }],
    }],
  };
  const r = parseProject(dirty);
  assert.equal(r.ok, true, r.error);
  const n = r.project.tracks[0].notes;
  assert.equal(n.length, 2, '非对象音符应被丢弃');
  assert.equal(n[0].startBeat, 0);
  assert.equal(n[0].durBeat, 0.125);
  assert.equal(n[0].pitch, 127);
  assert.equal(n[0].vibDepth, 100);
  assert.equal(n[0].vibFreq, 0);
  assert.equal(n[1].pitch, 0);
  assert.equal(r.project.bpm, 400, 'BPM 应被夹到上限');
  assert.equal(r.project.tracks[0].pitchCurve.length, 3, '曲线点只要有有限值就保留');
});

test('未知字段不会污染轨道，也不会被写进包', () => {
  const t = voiceTrack();
  t.__junk = { a: 1 };
  t.notes[0].evilKey = 'x';
  const { json } = serializeProject(state({ tracks: [t] }));
  assert.ok(!('__junk' in json.tracks[0]));
  assert.ok(!('evilKey' in json.tracks[0].notes[0]));
});

test('声部轨的静音 / 增益随工程走（多轨混音要能复现）', () => {
  const t = voiceTrack({ muted: true, gainDb: -6 });
  const { json } = serializeProject(state({ tracks: [t] }));
  assert.equal(json.tracks[0].muted, true);
  assert.equal(json.tracks[0].gainDb, -6);

  const r = parseProject(json);
  assert.equal(r.project.tracks[0].muted, true);
  assert.equal(r.project.tracks[0].gainDb, -6);

  // 缺省值：不写也能读回 0，UI 拿不到 undefined
  const r2 = parseProject(serializeProject(state({ tracks: [voiceTrack()] })).json);
  assert.equal(r2.project.tracks[0].muted, false);
  assert.equal(r2.project.tracks[0].gainDb, 0);

  // 超范围增益被夹住
  const r3 = parseProject(serializeProject(state({ tracks: [voiceTrack({ gainDb: 999 })] })).json);
  assert.equal(r3.project.tracks[0].gainDb, 24);
});

test('效果链与自动化子轨随工程走，伴奏轨也有', () => {
  const voice = voiceTrack({
    fx: [{ id: 'f1', type: 'reverb', enabled: true, params: { mix: 0.4, seconds: 3 } },
         { id: 'f2', type: 'gain', enabled: false, params: { gainDb: -6 } }],
    curves: [{ abbr: 'PIT', points: [{ beat: 0, value: 0 }, { beat: 2, value: -30 }] },
             { abbr: 'DYN', points: [{ beat: 1, value: 80 }] }],
  });
  const audio = audioTrack({ fx: [{ id: 'f3', type: 'eq3', enabled: true, params: { low: 3 } }] });
  const { json } = serializeProject(state({ tracks: [voice, audio] }));
  const r = parseProject(json);
  assert.equal(r.ok, true, r.error);

  const v = r.project.tracks[0];
  assert.equal(v.fx.length, 2);
  assert.equal(v.fx[0].type, 'reverb');
  assert.equal(v.fx[0].params.mix, 0.4);
  assert.equal(v.fx[1].enabled, false);
  assert.equal(v.curves.length, 2);
  assert.equal(v.curves[0].abbr, 'PIT');
  assert.deepEqual(v.curves[0].points, [{ beat: 0, value: 0 }, { beat: 2, value: -30 }]);

  const a = r.project.tracks[1];
  assert.equal(a.kind, 'audio');
  assert.equal(a.fx.length, 1, '伴奏轨同样能挂效果链');
  assert.equal(a.fx[0].type, 'eq3');
});

test('效果/曲线的脏条目被丢弃，非有限值不进包', () => {
  const t = voiceTrack({
    fx: [{ type: '', params: {} }, null, { type: 'gain', params: { gainDb: NaN, junk: 'x' } }],
    curves: [{ abbr: '', points: [] }, null, { abbr: 'VOL', points: [{ beat: 1, value: NaN }, { beat: 2, value: 3 }] }],
  });
  const { json } = serializeProject(state({ tracks: [t] }));
  assert.equal(json.tracks[0].fx.length, 1);
  // NaN 不进包；不认识的键原样保留（值域钳制由 track_fx 的 normalizeFx 在读到时做，
  // 本模块刻意不去认识每个效果的参数名）
  assert.ok(!('gainDb' in json.tracks[0].fx[0].params), 'NaN 不该进包');
  assert.equal(json.tracks[0].fx[0].type, 'gain');
  const r = parseProject(json);
  assert.deepEqual(r.project.tracks[0].curves[0].points, [{ beat: 2, value: 3 }]);
});

test('audio 缺失时仍然产出合法音频轨', () => {
  const r = parseProject({
    format: FORMAT_ID, version: 1,
    tracks: [{ id: 'a2', kind: 'audio' }],
  });
  assert.equal(r.ok, true, r.error);
  const t = r.project.tracks[0];
  assert.equal(t.kind, 'audio');
  assert.equal(t.audio.path, '');
  assert.equal(t.audio.fileName, 'audio');
  assert.ok(typeof t.engine === 'string', 'engine 应有合法默认值');
});

/* ------------------------------------------------------------ assetId 安全 */

test('assetId 只接受 [A-Za-z0-9_-]，其它一律退化为空', () => {
  assert.equal(safeAssetId('a1'), 'a1');
  assert.equal(safeAssetId('A_b-9'), 'A_b-9');
  assert.equal(safeAssetId('../../evil'), '');
  assert.equal(safeAssetId('a/b'), '');
  assert.equal(safeAssetId('a\\b'), '');
  assert.equal(safeAssetId(''), '');
  assert.equal(safeAssetId(null), '');
  assert.equal(safeAssetId('x'.repeat(65)), '');
});

test('非法 assetId 不会进入 assets 清单', () => {
  const r = parseProject({
    format: FORMAT_ID, version: 1,
    tracks: [{ id: 'a3', kind: 'audio', audio: { asset: '../escape', fileName: 'x.wav' } }],
    assets: { '../escape': { name: 'x.wav' }, 'ok1': { name: 'y.wav' } },
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.project.tracks[0].audio.asset, '', '轨道上的非法 id 应被清空');
  assert.deepEqual(r.assets, [{ id: 'ok1', name: 'y.wav' }], '清单里只留合法 id');
});

test('包内条目名由 id + 扩展名组成，扩展名不含路径分隔符', () => {
  assert.equal(extOf('a.wav'), '.wav');
  assert.equal(extOf('noext'), '');
  assert.equal(extOf('a.b.c.mp3'), '.mp3');
  assert.equal(assetEntryName('a1', 'backing.wav'), 'files/a1.wav');
  assert.equal(assetEntryName('../evil', 'x.wav'), 'files/.wav');
});

/* ------------------------------------------------------------ 资产回填 */

test('resolveAssetPaths 回填 path 且不改动入参', () => {
  const { json } = serializeProject(state({ tracks: [audioTrack()] }));
  const tracks = parseProject(json).project.tracks;
  const id = tracks[0].audio.asset;

  assert.equal(tracks[0].audio.path, '', '回填前 path 应为空');
  const out = resolveAssetPaths(tracks, { [id]: 'D:\\cache\\x.wav' });
  assert.equal(out[0].audio.path, 'D:\\cache\\x.wav');
  assert.equal(tracks[0].audio.path, '', '入参不应被改动');
  assert.notEqual(out[0], tracks[0], '应返回新对象');
});

test('missingAssets 挑出没落到本地的伴奏', () => {
  const { json } = serializeProject(state({ tracks: [voiceTrack(), audioTrack()] }));
  const tracks = parseProject(json).project.tracks;
  assert.equal(missingAssets(tracks).length, 1, '回填前应有 1 条缺失');

  const id = tracks.find((t) => t.kind === 'audio').audio.asset;
  const done = resolveAssetPaths(tracks, { [id]: 'D:\\cache\\x.wav' });
  assert.deepEqual(missingAssets(done), []);
});

/* ------------------------------------------------------------ 常量 */

test('格式常量稳定（改了就是破坏性变更）', () => {
  assert.equal(FORMAT_ID, 'fufumidi-song');
  assert.equal(FORMAT_VERSION, 1);
  assert.equal(PROJECT_EXT, 'fufumidi');
});

test('空状态也能保存（不因缺字段抛异常）', () => {
  const { json, assets } = serializeProject({});
  assert.equal(json.format, FORMAT_ID);
  assert.equal(json.bpm, 120);
  assert.equal(json.device, 'auto');
  assert.deepEqual(assets, []);
  // 空工程没有轨道 → 打开时被拒，这是设计如此（UI 至少有一条轨）
  assert.equal(parseProject(json).ok, false);
});

/* ---------------------------------------------------- 多点变速 / 拍号 / 调号 */

test('tempoMap 往返：标量 bpm 回填首点，多点保留', () => {
  const s = state({ bpm: 96, tempoMap: [
    { beat: 0, bpm: 999 },        // 非法值：首点必须被标量 96 覆盖
    { beat: 16, bpm: 72 },
    { beat: -4, bpm: 60 },        // 非法：负拍丢弃
    { beat: 16, bpm: 80 },        // 同拍去重（后写的赢）
  ] });
  const { json } = serializeProject(s);
  assert.equal(json.tempoMap[0].beat, 0, '首点强制 beat=0');
  assert.equal(json.tempoMap[0].bpm, 96);
  const r = parseProject(json);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.project.bpm, 96, 'parse 后 bpm 应取首点');
  assert.equal(r.project.tempoMap.length, 2, '负拍丢弃 + 同拍去重后剩 2 点');
  assert.deepEqual(r.project.tempoMap[1], { beat: 16, bpm: 80 });
});

test('tempoMap 空表 → 单点兜底（bpm 标量仍生效）', () => {
  const { json } = serializeProject(state({ bpm: 88 }));
  assert.deepEqual(json.tempoMap, [{ beat: 0, bpm: 88 }]);
  const r = parseProject(json);
  assert.equal(r.project.bpm, 88);
  // 旧版工程（没有 tempoMap 字段）打开也不炸
  const old = JSON.parse(JSON.stringify(json));
  delete old.tempoMap; delete old.sigMap; delete old.keySf;
  const r2 = parseProject(old);
  assert.equal(r2.ok, true);
  assert.equal(r2.project.bpm, 88, '旧工程 bpm 回退到标量');
  assert.deepEqual(r2.project.sigMap, [{ beat: 0, num: 4, den: 4 }]);
});

test('sigMap 往返：非法点丢弃、首点强制存在、同拍去重', () => {
  const s = state({ sigMap: [
    { beat: 8, num: 3, den: 4 },
    { beat: 4, num: 0, den: 5 },   // 非法（num<1、den 不在集合）→ 丢
    { beat: 8, num: 6, den: 8 },   // 同拍去重（后写的赢）
    { beat: -1, num: 4, den: 4 },  // 负拍 → 丢
  ] });
  const { json } = serializeProject(s);
  assert.deepEqual(json.sigMap[0], { beat: 0, num: 4, den: 4 }, '无首点时补 4/4');
  const r = parseProject(json);
  assert.equal(r.ok, true);
  assert.equal(r.project.sigMap.length, 2, '0 处 4/4 + 8 拍处 6/8');
  assert.deepEqual(r.project.sigMap[1], { beat: 8, num: 6, den: 8 });
});

test('keySf 往返与钳制', () => {
  const { json } = serializeProject(state({ keySf: 3 }));
  assert.equal(json.keySf, 3);
  assert.equal(parseProject(json).project.keySf, 3);
  const over = serializeProject(state({ keySf: 99 }));
  assert.equal(over.json.keySf, 7);
  const noKey = serializeProject(state());
  delete noKey.json.keySf;
  assert.equal(parseProject(noKey.json).project.keySf, 0, '缺字段兜底 0（C 调）');
});

/* ---------------------------------------------------- 颤音 8 参 */

test('颤音扩展参往返：in/out/shift/drift/volLink', () => {
  const vt = voiceTrack();
  vt.notes[0] = Object.assign(vt.notes[0], {
    vibIn: 20, vibOut: 10, vibShift: 25, vibDrift: -30, vibVolLink: 10,
  });
  const { json } = serializeProject(state({ tracks: [vt] }));
  const n = parseProject(json).project.tracks[0].notes[0];
  assert.equal(n.vibIn, 20);
  assert.equal(n.vibOut, 10);
  assert.equal(n.vibShift, 25);
  assert.equal(n.vibDrift, -30);
  assert.equal(n.vibVolLink, 10);
});

test('颤音扩展参钳制与缺字段兜底（旧工程兼容）', () => {
  const vt = voiceTrack();
  vt.notes[0] = Object.assign(vt.notes[0], {
    vibIn: 150, vibOut: -5, vibShift: 999, vibDrift: 'x', vibVolLink: 0,
  });
  const { json } = serializeProject(state({ tracks: [vt] }));
  const n = parseProject(json).project.tracks[0].notes[0];
  assert.equal(n.vibIn, 100, 'in 钳到 100');
  assert.equal(n.vibOut, 0, 'out 钳到 0');
  assert.equal(n.vibShift, 100, 'shift 钳到 100');
  assert.equal(n.vibDrift, 0, '非数值兜底 0（不崩）');
  assert.equal(n.vibVolLink, 0);
  // 旧工程音符没有扩展参 → parse 后不带这些键，引擎侧按默认值兜底
  const old = serializeProject(state()).json;
  const on = parseProject(old).project.tracks[0].notes[0];
  assert.equal(on.vibIn, undefined);
  assert.equal(on.vibOut, undefined);
});

/* ---------------------------------------------------- 音素覆写 */

test('phonemeOverrides 往返：清洗 + 钳制 + 兼容', () => {
  const vt = voiceTrack();
  vt.notes[0].phonemeOverrides = [
    { index: 0, offset: 120, preutterDelta: -5 },
    { index: 1, overlapDelta: 30 },
    { index: -1, offset: 10 },      // 坏 index → 丢
    { index: 2 },                    // 只有 index 没值 → 丢
    { index: 3, offset: 99999 },     // 钳 ±2000
    'x', null,
  ];
  const { json } = serializeProject(state({ tracks: [vt] }));
  const n = parseProject(json).project.tracks[0].notes[0];
  assert.equal(n.phonemeOverrides.length, 3);
  assert.deepEqual(n.phonemeOverrides[0], { index: 0, offset: 120, preutterDelta: -5 });
  assert.equal(n.phonemeOverrides[2].offset, 2000, 'offset 钳到 ±2000ms');
  // 旧工程没有该字段 → parse 后不带
  const old = parseProject(serializeProject(state()).json).project.tracks[0].notes[0];
  assert.equal(old.phonemeOverrides, undefined);
  // 空数组不落盘
  const vt2 = voiceTrack();
  vt2.notes[0].phonemeOverrides = [];
  const j2 = serializeProject(state({ tracks: [vt2] })).json;
  assert.equal(j2.tracks[0].notes[0].phonemeOverrides, undefined);
});

/* ------------------------------------------------------------ 片段模型 */

test('partStarts 往返：升序去重保留；缺省不写', () => {
  const { json } = serializeProject(state({
    tracks: [voiceTrack({ partStarts: [4, 0, 2.5, -1, 'x'] })],
  }));
  const r = parseProject(json);
  assert.equal(r.ok, true, r.error);
  const t = r.project.tracks[0];
  assert.deepEqual(t.partStarts, [0, 2.5, 4], '非法/负值丢弃、去重升序');
});

test('partStarts 缺省：旧工程不带该字段', () => {
  const { json } = serializeProject(state());
  assert.ok(!('partStarts' in json.tracks[0]), '无片段概念时不写字段');
  const r = parseProject(json);
  assert.deepEqual(r.project.tracks[0].partStarts, [], '读旧工程为空数组（= 单段语义）');
});
