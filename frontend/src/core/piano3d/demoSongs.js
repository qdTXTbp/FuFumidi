// 6.5.0 3D 钢琴内置练习曲（公有领域旋律，离线可用）
// 每条：[MIDI 音高, 拍数]；不依赖外部音频文件，避免版权与下载失败。
const C4 = 60, D4 = 62, E4 = 64, F4 = 65, G4 = 67, A4 = 69, B4 = 71, C5 = 72;
const def = (id, name, bpm, seq) => {
  let tick = 0;
  const notes = seq.map(([pitch, beats]) => {
    const n = { start: tick, end: tick + Math.max(1, Math.round(beats * 480)), pitch, midi: pitch, vel: 88, ch: 0 };
    tick += Math.max(1, Math.round(beats * 480));
    return n;
  });
  return { id, name, bpm, tpb: 480, totalTicks: tick, notes };
};
export const DEMO_SONGS = [
  def('twinkle', '小星星', 100, [
    [C4,1],[C4,1],[G4,1],[G4,1],[A4,1],[A4,1],[G4,2],
    [F4,1],[F4,1],[E4,1],[E4,1],[D4,1],[D4,1],[C4,2],
    [G4,1],[G4,1],[F4,1],[F4,1],[E4,1],[E4,1],[D4,2],
    [G4,1],[G4,1],[F4,1],[F4,1],[E4,1],[E4,1],[D4,2],
    [C4,1],[C4,1],[G4,1],[G4,1],[A4,1],[A4,1],[G4,2],
    [F4,1],[F4,1],[E4,1],[E4,1],[D4,1],[D4,1],[C4,2],
  ]),
  def('ode', '欢乐颂', 110, [
    [E4,1],[E4,1],[F4,1],[G4,1],[G4,1],[F4,1],[E4,1],[D4,1],
    [C4,1],[C4,1],[D4,1],[E4,1],[E4,1.5],[D4,0.5],[D4,2],
    [E4,1],[E4,1],[F4,1],[G4,1],[G4,1],[F4,1],[E4,1],[D4,1],
    [C4,1],[C4,1],[D4,1],[E4,1],[D4,1.5],[C4,0.5],[C4,2],
  ]),
  def('frere', '两只老虎', 96, [
    [C4,2],[D4,2],[E4,2],[C4,2],[C4,2],[D4,2],[E4,2],[C4,2],
    [E4,2],[F4,2],[G4,4],[E4,2],[F4,2],[G4,4],
    [G4,1],[A4,1],[G4,1],[F4,1],[E4,2],[C4,2],
    [G4,1],[A4,1],[G4,1],[F4,1],[E4,2],[C4,2],
    [C4,2],[G4,2],[C4,2],[C4,2],
  ]),
];
export function buildDemoSong(demo) {
  if (!demo) return null;
  return {
    name: demo.name,
    bpm: demo.bpm,
    tpb: demo.tpb,
    totalTicks: demo.totalTicks,
    tracks: [{ name: demo.name, program: 0, ch: 0, notes: demo.notes.map(n => ({ ...n })) }],
    baseSec(tick) { return tick / demo.tpb * 60 / demo.bpm; },
    secToTick(sec) { return sec * demo.tpb * demo.bpm / 60; },
  };
}
