// ============================================================
// 音频处理（人声分离）的**唯一参数构造处**
// ------------------------------------------------------------
// 为什么单独抽出来：分离不只是「音频处理」面板的事 ——
//   · 翻唱工作流的第一步就是分离（engine_cover.py）；
//   · 换音色（GPT-SoVITS A+ 路线）的**参考源**正是分离出来的人声轨，分离质量决定成败；
//   · 资源中心的分离模型就绪状态也要在同一处判定。
// 三处如果各写一份「默认参数 + 输出命名」，迟早出现「面板出一个名字、工作流找另一个名字」
// 这种只在运行时才炸的错。所以：**参数构造、输出命名、就绪判定全在这里**。
//
// 输出命名约定（与 music2midi.py separate 的实际产物一致，工作流按同一约定查找）：
//   <输入基名>_Vocals.wav / <输入基名>_Instrumental.wav
// ============================================================
'use strict';

/** 分离产物命名：输入 src.flac → src_Vocals.wav / src_Instrumental.wav */
function outputNames(inputPath, path) {
  const base = path.basename(String(inputPath || ''), path.extname(String(inputPath || ''))) || 'src';
  return { vocals: base + '_Vocals.wav', instrumental: base + '_Instrumental.wav' };
}

/** 默认分离模型：优先「人声/伴奏 duality」，其次是任何已安装的 vocal 类模型 */
function pickDefaultSepModel(msstRegistry, resolveSeparateModel) {
  const ids = Object.keys(msstRegistry || {});
  const preferred = [
    'melband_roformer_instvox_duality_v2',
    'melband_roformer_inst_v2',
    'mel_band_roformer_vocals_becruily',
  ];
  for (const id of preferred) if (ids.includes(id)) return id;
  const anyVocal = ids.find((id) => (msstRegistry[id] || {}).splitCat === 'vocal');
  return anyVocal || '';
}

/** 输出目录优先级：调用方指定 > 设置里的「默认输出目录」> 与输入同目录 > 临时目录 */
function pickOutputDir(cfg, { readSettings, Paths, fs }) {
  let dir = cfg && cfg.out_dir && String(cfg.out_dir).trim() ? String(cfg.out_dir).trim() : '';
  if (!dir) {
    try { const s = readSettings ? readSettings() : {}; dir = (s && s.output_dir && String(s.output_dir).trim()) || ''; } catch (e) { dir = ''; }
  }
  if (!dir) {
    const src = String((cfg && cfg.audio) || '');
    const srcDir = src.replace(/[\\/][^\\/]*$/, '');
    dir = srcDir && srcDir !== src ? srcDir : Paths.tempDir();
  }
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { dir = Paths.tempDir(); try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {} }
  return dir;
}

/**
 * 解析一次分离请求 → 引擎参数。面板与翻唱工作流都用它。
 * @returns {{ok:boolean, error?:string, dir?:string, args?:string[], names?:object, model?:string}}
 */
function buildSeparateRequest(cfg, { resolveSeparateModel, readSettings, Paths, fs, msstRegistry }) {
  if (!cfg || !cfg.audio) return { ok: false, error: '缺少参数：需要音频文件' };
  let modelId = cfg.sep_model;
  if (!modelId) {
    modelId = pickDefaultSepModel(msstRegistry, resolveSeparateModel);
    if (!modelId) return { ok: false, error: '还没有安装任何人声分离模型：请先到资源中心下载（推荐「人声/伴奏 duality v2」）' };
  }
  if (!resolveSeparateModel) return { ok: false, error: '音频处理服务未就绪' };
  const resolved = resolveSeparateModel(modelId);
  if (!resolved) return { ok: false, error: '未知的分离模型：' + modelId };
  if (resolved.exists === false) return { ok: false, error: resolved.error || ('分离模型未下载：' + modelId + '（请到资源中心下载）') };
  if (!resolved.configPath) return { ok: false, error: '该模型缺少配置文件，暂不支持此模型' };

  const dir = pickOutputDir(cfg, { readSettings, Paths, fs });
  const args = ['separate', cfg.audio, '--output', dir,
    '--model', resolved.modelPath, '--config', resolved.configPath, '--arch', resolved.arch];
  if (cfg.chunk_size) args.push('--chunk-size', String(cfg.chunk_size));
  if (cfg.num_overlap) args.push('--num-overlap', String(cfg.num_overlap));
  if (cfg.batch_size) args.push('--batch-size', String(cfg.batch_size));
  else args.push('--batch-size', '1');            // 实测：batch 2 + TTA 在长曲上会挤爆显存（进程静默退出）
  if (Array.isArray(cfg.stems) && cfg.stems.length) args.push('--stems', cfg.stems.join(','));
  if (cfg.format) args.push('--format', String(cfg.format).toLowerCase());
  if (cfg.tta) args.push('--tta');
  if (cfg.normalize !== false) args.push('--normalize');
  return { ok: true, dir, args, names: outputNames(cfg.audio, Paths.path || require('path')), model: modelId };
}

module.exports = { outputNames, pickDefaultSepModel, pickOutputDir, buildSeparateRequest };
