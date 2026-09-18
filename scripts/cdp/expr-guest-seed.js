// 给全新安装的应用播一首「种子 MIDI」：在页面内生成一支合法的 format-0 MIDI 并用与界面
// 同一条导入链路（app.importFiles）入库，使后续的引导走查具备「已载入曲目」这一前提。
// 之所以要生成而不是拷文件进来：全新安装的曲库是空的，而引导里大量步骤的 DOM 依赖当前曲目。
(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const app = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app');

  const vlq = (n) => { const b = [n & 0x7f]; n >>= 7; while (n > 0) { b.unshift((n & 0x7f) | 0x80); n >>= 7; } return b; };

  // --- 构造事件表 ---
  const TPQ = 480;
  const evs = [];
  evs.push({ t: 0, d: [0xff, 0x51, 0x03, 0x07, 0xa1, 0x20] });          // tempo 120
  evs.push({ t: 0, d: [0xc0, 0x00] });                                    // program 0 (piano)
  const SCALE = [0, 2, 4, 5, 7, 9, 11];
  for (let i = 0; i < 160; i++) {
    const pitch = 60 + SCALE[i % 7] + (i % 14 >= 7 ? 12 : 0);
    const start = i * (TPQ / 2);
    evs.push({ t: start, d: [0x90, pitch, 72] });
    evs.push({ t: start + TPQ / 2 - 20, d: [0x80, pitch, 0] });
  }
  // 手动补一条弦乐轨的音符（让轨道数 >1，便于「分轨」相关步骤有意义）
  evs.push({ t: 0, d: [0xc1, 0x30] });
  for (let i = 0; i < 40; i++) {
    const start = i * TPQ * 2;
    evs.push({ t: start, d: [0x91, 48 + SCALE[i % 7], 60] });
    evs.push({ t: start + TPQ * 2 - 30, d: [0x81, 48 + SCALE[i % 7], 0] });
  }
  evs.sort((a, b) => a.t - b.t || a.d[0] - b.d[0]);

  const track = [];
  let last = 0;
  for (const e of evs) { track.push(...vlq(e.t - last), ...e.d); last = e.t; }
  track.push(...vlq(0), 0xff, 0x2f, 0x00);

  const trk = [0x4d, 0x54, 0x72, 0x6b,
    (track.length >>> 24) & 255, (track.length >>> 16) & 255, (track.length >>> 8) & 255, track.length & 255, ...track];
  const hdr = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (TPQ >> 8) & 255, TPQ & 255];
  const bytes = new Uint8Array([...hdr, ...trk]);

  const before = app.songs.length;
  await app.importFiles([{ name: 'guest-seed.mid', bytes }], 'all');
  await sleep(1200);
  const pick = app.songs[app.songs.length - 1];
  if (pick) { await app.selectSong(pick.id); await sleep(1500); }
  return {
    midiBytes: bytes.length,
    songsBefore: before,
    songsAfter: app.songs.length,
    imported: pick ? pick.name : null,
    currentId: app.currentId,
    tracks: pick && pick.song ? pick.song.tracks.length : 0,
    notes: pick && pick.song ? pick.song.tracks.reduce((a, t) => a + t.notes.length, 0) : 0,
    durationSec: pick && pick.song ? +pick.song.totalSec.toFixed(1) : 0,
  };
})()