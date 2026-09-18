// 虚拟机 L3：真实跑一次音频→MIDI 转录（走主进程 bridge.convert → 内置 python 引擎），
// 拿结果验证「引擎链路在本机可用」而不只是「依赖都装了」。
// 结果挂 window，避免长求值的响应被 NAT 丢掉。
(async () => {
  const app = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app');
  const bridge = window.fuBridge;
  if (!bridge || !bridge.convert) return 'no bridge.convert';
  const t0 = Date.now();
  const cfg = {
    audio: 'C:\\Users\\tester\\fufumidi-guest\\guest-tone.wav',
    id: 'l3transcribe',
    out: null,
    mode: 'universal',
    perf: 'fast',
    model: 'basic',
    onset_threshold: 0.5,
    frame_threshold: 0.3,
    min_note_length: 58,
    denoise: true,
    normalize: true,
    auto_bpm: true,
  };
  let res = null, err = '';
  try { res = await bridge.convert(cfg); } catch (e) { err = (e && e.message) || String(e); }
  const out = {
    elapsedSec: Math.round((Date.now() - t0) / 100) / 10,
    err,
    ok: !!(res && res.ok),
    out: (res && res.out) || '',
    noteCount: (res && res.note_count) || 0,
    code: res ? res.code : null,
    engineError: (res && res.error) || '',
    songsBefore: app.songs.length,
  };
  if (res && res.ok && res.out) {
    try {
      const bytes = await bridge.readBinary(res.out);
      out.bytes = bytes ? bytes.byteLength : 0;
      if (bytes) { await app.importFiles([{ name: String(res.out).replace(/^.*[\\/]/, ''), bytes }], 'all'); }
      out.songsAfter = app.songs.length;
      const last = app.songs[app.songs.length - 1];
      out.importedName = last ? last.name : '';
      out.importedNotes = last && last.song ? last.song.tracks.reduce((a, t) => a + t.notes.length, 0) : 0;
    } catch (e) { out.importErr = (e && e.message) || String(e); }
  }
  window.__l3Transcribe = out;
  return 'ok';
})()