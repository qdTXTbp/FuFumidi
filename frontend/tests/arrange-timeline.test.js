// P1-1 编排时间线 clip 模型测试（纯逻辑）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createArrangeState, validateArrangeState, clipLen, clipsOfTrack, findClip,
  addClip, removeClip, moveClip, resizeClip, splitClip, duplicateClip, setTrackFlags,
  addMarker, removeMarker, addRegion, removeRegion, renderPlan, focusRangeOfClip,
  defaultArrangeState, writeArrangeToSong, readArrangeFromSong, clipsRenderJobs,
} from '../src/core/arrange.js';
import { normalizeTimeline } from '../src/core/timeline.js';

function base() {
  return createArrangeState({
    tracks: [{ id: 't1', name: '钢琴' }, { id: 't2', name: '弦乐' }],
    clips: [{ id: 'c1', trackId: 't1', startTick: 0, endTick: 1920, offsetTick: 0, name: '主歌' }],
    markers: [{ id: 'm1', title: '前奏', tick: 0 }],
    regions: [{ id: 'r1', name: 'A 段', startTick: 0, endTick: 1920 }],
  });
}

test('P1-1 createArrangeState：补默认/排序/幂等', () => {
  const s = base();
  assert.deepEqual(s.tracks.map((t) => t.id), ['t1', 't2']);
  assert.equal(s.tracks[0].height, 56);
  const s2 = createArrangeState({
    tracks: [{ name: 'x' }],
    clips: [
      { trackId: 'track-1', startTick: 960, endTick: 1920 },
      { trackId: 'track-1', startTick: 0, endTick: 480 },
    ],
  });
  assert.deepEqual(s2.clips.map((c) => c.startTick), [0, 960], 'clip 按 startTick 排序');
  assert.ok(s2.clips.every((c) => c.id && c.trackId));
  assert.deepEqual(validateArrangeState(s2).errors, []);
});

test('P1-1 validate：未知轨道/零长度/重复 id 都要报出来', () => {
  const bad = {
    tracks: [{ id: 't1' }],
    clips: [
      { id: 'x', trackId: 'nope', startTick: 0, endTick: 10 },
      { id: 'x', trackId: 't1', startTick: 5, endTick: 5 },
    ],
  };
  const v = validateArrangeState(bad);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.indexOf('不存在') >= 0));
  assert.ok(v.errors.some((e) => e.indexOf('长度') >= 0));
  assert.ok(v.errors.some((e) => e.indexOf('重复') >= 0));
  assert.equal(validateArrangeState(null).ok, false);
});

test('P1-1 addClip：未知轨道自动落到第一轨；不改入参', () => {
  const s = base();
  const s2 = addClip(s, { id: 'c2', trackId: 'missing', startTick: 1920, endTick: 2880 });
  assert.equal(findClip(s2, 'c2').trackId, 't1');
  assert.equal(s.clips.length, 1, '原 state 不被修改');
});

test('P1-1 moveClip：保持长度、跨轨、起点夹到 0', () => {
  const s = base();
  const moved = moveClip(s, 'c1', { startTick: 960 });
  assert.deepEqual([clipLen(moved.clips[0]), moved.clips[0].startTick, moved.clips[0].endTick], [1920, 960, 2880]);
  const cross = moveClip(s, 'c1', { trackId: 't2' });
  assert.equal(cross.clips[0].trackId, 't2');
  assert.equal(cross.clips[0].startTick, 0);
  const clamped = moveClip(s, 'c1', { startTick: -500 });
  assert.equal(clamped.clips[0].startTick, 0);
  assert.equal(findClip(moveClip(s, '不存在', {}), 'c1').startTick, 0);
});

test('P1-1 resizeClip：拉左边同步改 offset，内容不漂移；拉右边最小 1 tick', () => {
  const s = base();
  const left = resizeClip(s, 'c1', 'start', 480);
  const c = left.clips[0];
  assert.deepEqual([c.startTick, c.endTick, c.offsetTick], [480, 1920, 480], '左边缩进：offset 跟着 +480');
  const right = resizeClip(s, 'c1', 'end', 960);
  assert.deepEqual([right.clips[0].startTick, right.clips[0].endTick], [0, 960]);
  const tooShort = resizeClip(s, 'c1', 'start', 999999);
  assert.equal(tooShort.clips[0].endTick > tooShort.clips[0].startTick, true, '不能拉成 0 长度');
  const noOver = resizeClip(s, 'c1', 'end', 0);
  assert.equal(noOver.clips[0].endTick, 1, 'end 最多收到 start+1');
});

test('P1-1 splitClip：左右两段偏移正确，切点外不变', () => {
  const s = base();
  const out = splitClip(s, 'c1', 960);
  assert.equal(out.clips.length, 2);
  const [a, b] = out.clips;
  assert.deepEqual([a.startTick, a.endTick, a.offsetTick], [0, 960, 0]);
  assert.deepEqual([b.startTick, b.endTick, b.offsetTick], [960, 1920, 960], '右段偏移 += 切点相对起点');
  assert.ok(a.id !== b.id);
  assert.equal(splitClip(s, 'c1', 0).clips.length, 1, '切在开头不生效');
  assert.equal(splitClip(s, 'c1', 1920).clips.length, 1, '切在结尾不生效');
});

test('P1-1 duplicateClip：默认紧跟原 clip，可换轨/指定起点', () => {
  const s = base();
  const dup = duplicateClip(s, 'c1');
  assert.equal(dup.clips.length, 2);
  const added = dup.clips.find((c) => c.id !== 'c1');
  assert.deepEqual([added.startTick, added.endTick, added.trackId], [1920, 3840, 't1']);
  const cross = duplicateClip(s, 'c1', { trackId: 't2', startTick: 500 });
  const c2 = cross.clips.find((c) => c.id !== 'c1');
  assert.deepEqual([c2.startTick, c2.endTick, c2.trackId], [500, 2420, 't2']);
});

test('P1-1 removeClip / clipsOfTrack / setTrackFlags', () => {
  const s = base();
  const added = addClip(s, { id: 'c2', trackId: 't2', startTick: 3840, endTick: 4800 });
  assert.deepEqual(clipsOfTrack(added, 't2').map((c) => c.id), ['c2']);
  assert.equal(removeClip(added, 'c2').clips.length, 1);
  const flags = setTrackFlags(added, 't1', { mute: true, solo: true, height: 20 });
  assert.deepEqual([flags.tracks[0].mute, flags.tracks[0].solo, flags.tracks[0].height], [true, true, 28]);
  assert.equal(setTrackFlags(added, 'nope', { mute: true }).tracks[0].mute, false);
});

test('P1-1 markers / regions：添加排序、删除、默认值', () => {
  const s = base();
  const m = addMarker(s, { title: '副歌', tick: 960 });
  assert.deepEqual(m.markers.map((x) => x.tick), [0, 960]);
  assert.equal(removeMarker(m, m.markers[1].id).markers.length, 1);
  const r = addRegion(s, { name: 'B 段', startTick: 960, endTick: 1920 });
  assert.deepEqual(r.regions.map((x) => x.startTick), [0, 960]);
  assert.equal(removeRegion(r, r.regions[0].id).regions.length, 1);
});

test('P1-1 renderPlan：clip tick → 秒（走 TimelineModel），变速时分段正确', () => {
  const tl = normalizeTimeline({ tpb: 480, tempoMap: [{ tick: 0, us: 500000 }, { tick: 960, us: 250000 }] });
  const s = createArrangeState({
    tracks: [{ id: 't1' }],
    clips: [
      { id: 'c1', trackId: 't1', startTick: 0, endTick: 960, offsetTick: 0 },
      { id: 'c2', trackId: 't1', startTick: 960, endTick: 1440, offsetTick: 480 },
    ],
  });
  const plan = renderPlan(s, tl);
  assert.equal(plan.length, 2);
  const [a, b] = plan;
  assert.deepEqual([a.startSec, a.endSec, a.durationSec, a.offsetSec], [0, 1, 1, 0]);
  assert.ok(Math.abs(b.startSec - 1) < 1e-9);
  assert.ok(Math.abs(b.endSec - 1.25) < 1e-9, '第二段在 240BPM 下 480tick=0.25s');
  assert.ok(Math.abs(b.offsetSec - 0.5) < 1e-9, 'offset 480tick=0.5s');
  const only = renderPlan(s, tl, { trackId: 't1' });
  assert.equal(only.length, 2);
});

test('P1-1 focusRangeOfClip：双击聚焦到原曲区间', () => {
  const s = base();
  const c = Object.assign({}, s.clips[0], { startTick: 480, endTick: 2400, offsetTick: 960 });
  assert.deepEqual(focusRangeOfClip(c), { fromTick: 960, toTick: 960 + 1920, trackId: 't1' });
});

test('P1-1 所有变更函数都不改入参（函数式）', () => {
  const s = base();
  const snapshot = JSON.stringify(s);
  moveClip(s, 'c1', { startTick: 999 });
  splitClip(s, 'c1', 500);
  resizeClip(s, 'c1', 'end', 4000);
  duplicateClip(s, 'c1');
  removeClip(s, 'c1');
  setTrackFlags(s, 't1', { mute: true });
  addMarker(s, { title: 'x', tick: 1 });
  addRegion(s, { name: 'x', startTick: 1, endTick: 2 });
  assert.equal(JSON.stringify(s), snapshot, '原 state 字符串未变');
});


test('P1-1c defaultArrangeState：按曲目音符生成默认 clip（每轨一个整曲区间）', () => {
  const song = { tpb: 480, totalTicks: 9600, tracks: [
    { name: '钢琴', notes: [{ start: 0, end: 9600, midi: 60 }], mute: true },
    { name: '空轨', notes: [] },
    { name: '弦乐', notes: [{ start: 0, end: 4800, midi: 72 }] },
  ] };
  const st = defaultArrangeState(song);
  assert.deepEqual(st.tracks.map((t) => t.name), ['钢琴', '弦乐']);
  assert.deepEqual(st.clips.map((c) => [c.trackId, c.startTick, c.endTick]), [['t0', 0, 9600], ['t2', 0, 9600]]);
  assert.equal(st.tracks[0].mute, true);
  assert.deepEqual(defaultArrangeState(null).clips, []);
});

test('P1-1c writeArrangeToSong / readArrangeFromSong：round-trip 且坏数据返回 null', () => {
  const song = { tpb: 480, totalTicks: 3840, tracks: [{ name: 'a', notes: [{ start: 0, end: 3840, midi: 60 }] }] };
  const st = defaultArrangeState(song);
  const plain = writeArrangeToSong(song, st);
  assert.ok(song.arrange && plain === song.arrange);
  const back = readArrangeFromSong(song);
  assert.deepEqual(back.clips.map((c) => [c.trackId, c.startTick, c.endTick]), [[st.clips[0].trackId, 0, 3840]]);
  song.arrange = { tracks: [], clips: [{ id: 'x', trackId: 'nope', startTick: 0, endTick: 10 }] };
  assert.equal(readArrangeFromSong(song), null, '指向未知轨道的坏数据不恢复');
  assert.equal(readArrangeFromSong({}), null);
});

test('P1-1c clipsRenderJobs：每个 clip 的「放置时间 / 原曲区间 / 时长」+ 总长', () => {
  const tl = normalizeTimeline({ tpb: 480, tempoMap: [{ tick: 0, us: 500000 }] });
  const st = createArrangeState({
    tracks: [{ id: 't1' }],
    clips: [
      { id: 'c1', trackId: 't1', startTick: 0, endTick: 960, offsetTick: 0 },
      { id: 'c2', trackId: 't1', startTick: 1920, endTick: 2400, offsetTick: 960 },
    ],
  });
  const r = clipsRenderJobs(st, tl);
  assert.equal(r.jobs.length, 2);
  assert.deepEqual(r.jobs.map((j) => j.clipId), ['c1', 'c2'], '按放置时间排序');
  assert.deepEqual(r.jobs.map((j) => [j.placeSec, j.sourceStartSec, j.sourceEndSec, j.durationSec]), [[0, 0, 1, 1], [2, 1, 1.5, 0.5]]);
  assert.ok(Math.abs(r.totalSec - 2.5) < 1e-9);
  const fast = clipsRenderJobs(st, tl, { scale: 2 });
  assert.ok(Math.abs(fast.jobs[0].durationSec - 0.5) < 1e-9, '2× 播放时片段时长减半');
  assert.ok(Math.abs(fast.totalSec - 1.25) < 1e-9);
});
