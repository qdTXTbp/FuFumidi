// E2E：P0-4 导出 IPC 真链路（渲染进程 → preload → main/export.js 落盘 → manifest）。
// 用例自己生成一小段 WAV，通过 bridge 写到 artifacts 目录，再在 Node 侧核对文件与 manifest。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeWav, decodeWavHeader } from '../../../frontend/src/core/export_audio.js';

const ART = path.dirname(fileURLToPath(import.meta.url)) + path.sep + '..' + path.sep + 'artifacts';

export default async function (app) {
  await app.waitFor('!!(window.__fufumidiE2E)', { timeout: 20000, message: 'E2E 测试钩子已注册' });
  const sr = 8000, ch = 1;
  const data = [new Float32Array(sr).fill(0.25)];   // 0.5 秒持续 0.25 幅度
  const wav = encodeWav(data, sr, { bitDepth: 16 });
  const target = path.join(ART, 'e2e-export-' + Date.now() + '.wav');
  const out = await app.eval(
    '(async () => JSON.stringify(await window.fuBridge.exportAudio(' +
    JSON.stringify({
      name: 'e2e-export', bytes: Array.from(wav), targetPath: target,
      ext: 'wav', format: 'wav', bitDepth: 16, sampleRate: sr, channels: ch,
      durationSec: 1, lufs: -14.2, peakDb: -1.1, targetLufs: -14, sourceName: 'E2E 导出',
    }) + ')))()'
  );
  const r = JSON.parse(out);
  app.assert(r.ok === true, 'export:audio 返回 ok：' + JSON.stringify(r).slice(0, 200));
  app.assert(fs.existsSync(r.path), '文件已落盘：' + r.path);
  const back = new Uint8Array(fs.readFileSync(r.path));
  const h = decodeWavHeader(back);
  app.assert(h && h.bits === 16 && h.sampleRate === sr && h.channels === ch, '落盘文件是合法 16bit WAV');
  app.assert(fs.existsSync(r.manifestPath), 'sidecar manifest 已落盘：' + r.manifestPath);
  const m = JSON.parse(fs.readFileSync(r.manifestPath, 'utf8'));
  app.assert(m.format === 'fufumidi-export' && m.audio.sampleRate === sr && m.audio.channels === ch, 'manifest 音频参数正确');
  app.assert(m.audio.lufs === -14.2 && m.audio.targetLufs === -14, 'manifest 记录响度与目标');
  app.assert(m.file.size === back.length, 'manifest 大小与文件一致');
  try { fs.unlinkSync(r.path); fs.unlinkSync(r.manifestPath); } catch (e) {}
  app.assert(true, '导出 IPC 真链路通过：' + path.basename(r.path));
}
