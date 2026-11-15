// ============================================================
// V0.2 压缩音频编码（main/audio-encode.js）
// ============================================================
// 渲染进程只产 WAV 母版（core/export_audio.js 的 encodeWav），压缩格式在主进程用
// **包内 ffmpeg** 转码后再交给 writeExport 落盘。ffmpeg 的定位沿用 main/video.js 的做法：
// 通过 imageio_ffmpeg.get_ffmpeg_exe() 拿可执行文件，不硬编码版本号/系统 PATH。
//
// 为什么放在主进程：渲染进程没有编码库，也不该为 MP3/FLAC/OGG 引入 WASM 依赖；
// 而安装包本来就有 imageio-ffmpeg（MP4 导出已依赖它），实测包含
// libmp3lame / flac / libvorbis / libopus 四个编码器。
//
// ⚠️ COMPRESSED_FORMATS 与 frontend/src/core/export_options.js 的 codec 字段是两份表，
//    frontend/tests/audio-encode.test.js 有一条一致性断言，改格式时两边都要动。
'use strict';
const fs = require('fs');
const path = require('path');
const Paths = require('./paths');

const COMPRESSED_FORMATS = Object.freeze({
  flac: Object.freeze({ ext: 'flac', args: ['-c:a', 'flac', '-compression_level', '5'] }),
  mp3: Object.freeze({ ext: 'mp3', args: ['-c:a', 'libmp3lame', '-b:a', '320k'] }),
  ogg: Object.freeze({ ext: 'ogg', args: ['-c:a', 'libvorbis', '-q:a', '6'] }),
});

function isCompressedFormat(id) {
  return Object.prototype.hasOwnProperty.call(COMPRESSED_FORMATS, String(id || ''));
}
function extFor(id) {
  const s = COMPRESSED_FORMATS[String(id || '')];
  return s ? s.ext : 'wav';
}

/** 纯函数：ffmpeg 参数。未知/非压缩格式返回 null（调用方直接落 WAV）。 */
function ffmpegArgs(format, input, output) {
  const spec = COMPRESSED_FORMATS[String(format || '')];
  if (!spec) return null;
  return ['-y', '-hide_banner', '-loglevel', 'error', '-i', input].concat(spec.args, [output]);
}

/** 纯函数：内联 Python 代码（与 main/video.js 同款：imageio_ffmpeg 定位 + JSON 回传结果） */
function buildPyCode(args) {
  return 'import json, subprocess\n' +
    'import imageio_ffmpeg\n' +
    'ff = imageio_ffmpeg.get_ffmpeg_exe()\n' +
    'r = subprocess.run([ff] + ' + JSON.stringify(args) + ', capture_output=True)\n' +
    "print(json.dumps({'ok': r.returncode == 0, 'err': (r.stderr or b'').decode('utf-8', 'replace')[-400:]}))";
}

/**
 * 把 WAV 母版字节转成压缩格式字节。
 * @param {{bytes:Buffer|Uint8Array, format:string, runEngineInline?:Function,
 *          parsePyJson?:Function, tmpDir?:string}} o
 * @returns {Promise<{ok:boolean, bytes?:Buffer, error?:string}>}
 */
async function encodeAudio(o = {}) {
  const format = String(o.format || '');
  if (!isCompressedFormat(format)) return { ok: false, error: '未支持的压缩格式：' + format };
  const input = Buffer.isBuffer(o.bytes) ? o.bytes : Buffer.from(o.bytes || []);
  if (!input.length) return { ok: false, error: '没有可编码的 WAV 数据' };
  if (typeof o.runEngineInline !== 'function') {
    return { ok: false, error: '引擎运行时未就绪，无法导出 ' + format.toUpperCase() };
  }
  const parse = typeof o.parsePyJson === 'function' ? o.parsePyJson : require('./py-util').parsePyJson;

  const dir = o.tmpDir || path.join(Paths.tempDir(), 'fufumidi-audio-encode');
  const stem = Date.now() + '-' + process.pid + '-' + Math.random().toString(36).slice(2, 10);
  const wavPath = path.join(dir, stem + '.wav');
  const outPath = path.join(dir, stem + '.' + extFor(format));
  const cleanup = () => {
    for (const f of [wavPath, outPath]) {
      try { fs.unlinkSync(f); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
    }
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(wavPath, input);
    const rr = await o.runEngineInline(buildPyCode(ffmpegArgs(format, wavPath, outPath)));
    const d = parse(rr && rr.out);
    if (!d || !d.ok) {
      return { ok: false, error: (d && d.err) || (rr && String(rr.out || '').slice(-400)) || 'ffmpeg 转码失败' };
    }
    if (!fs.existsSync(outPath)) return { ok: false, error: 'ffmpeg 未产出文件：' + extFor(format) };
    const bytes = fs.readFileSync(outPath);
    if (!bytes.length) return { ok: false, error: 'ffmpeg 产出了空文件' };
    return { ok: true, bytes };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    cleanup();
  }
}

module.exports = {
  COMPRESSED_FORMATS, isCompressedFormat, extFor,
  ffmpegArgs, buildPyCode, encodeAudio,
};
