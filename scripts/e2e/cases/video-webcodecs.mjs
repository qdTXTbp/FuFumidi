// E2E：隐藏窗口内验证 WebCodecs H.264 编码能力（视频导出的渲染端前提；不落盘/不弹窗）
export default async function (app) {
  await app.waitFor('!!window.__fufumidiE2E', { timeout: 20000 });
  const r = await app.eval(`(async () => {
    if (!window.VideoEncoder || !window.VideoFrame) return { ok: false, reason: 'no WebCodecs' };
    const cfg = { codec: 'avc1.42001f', width: 160, height: 90, bitrate: 500000, framerate: 24, avc: { format: 'annexb' } };
    const s = await VideoEncoder.isConfigSupported(cfg);
    if (!s.supported) return { ok: false, reason: 'h264 unsupported' };
    const cv = document.createElement('canvas'); cv.width = 160; cv.height = 90;
    const ctx = cv.getContext('2d'); ctx.fillStyle = '#123'; ctx.fillRect(0, 0, 160, 90);
    let chunks = 0, bytes = 0, err = null;
    const enc = new VideoEncoder({
      output: (c) => { chunks++; bytes += c.byteLength; },
      error: (e) => { err = String(e && e.message || e); },
    });
    enc.configure(cfg);
    for (let i = 0; i < 6; i++) {
      const vf = new VideoFrame(cv, { timestamp: Math.round(i * 1e6 / 24), duration: 41666 });
      enc.encode(vf, { keyFrame: i % 3 === 0 });
      vf.close();
    }
    await enc.flush();
    try { enc.close(); } catch (e) {}
    return { ok: !err && chunks > 0 && bytes > 0, chunks, bytes, err, codec: cfg.codec };
  })()`, { awaitPromise: true });
  if (!r || !r.ok) throw new Error('WebCodecs H.264 编码不可用: ' + JSON.stringify(r));
  app.assert(true, 'WebCodecs H.264 编码通过：' + JSON.stringify(r));
}
