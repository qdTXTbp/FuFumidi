// 6.5.0 智能分轨转录编排：分轨 -> 逐 stem 转录 -> 修正 -> 合并。
'use strict';
const path = require('path');
const SepCommon = require('./separate-common');

function roleOf(file) {
  const s = String(file || '').toLowerCase();
  if (/vocal|voice|sing|人声/.test(s)) return 'vocals';
  if (/drum|perc|鼓/.test(s)) return 'drums';
  if (/bass|贝斯/.test(s)) return 'bass';
  if (/piano|keys|钢琴/.test(s)) return 'piano';
  if (/guitar|吉他/.test(s)) return 'guitar';
  return 'other';
}

function spawnP(spawnEngine, args, opts) {
  return new Promise((resolve, reject) => {
    try {
      spawnEngine(args, {
        ...(opts || {}),
        onDone: (code, r) => resolve({ code, r }),
        onError: (e) => reject(new Error(String(e))),
      });
    } catch (e) { reject(e); }
  });
}

async function runStemWorkflow(cfg, deps) {
  const { fs, Paths, readSettings, spawnEngine, engineWorkerConvert, resolveSeparateModel, listSeparateModels, sendLog, sendProg } = deps;
  const log = (s) => { try { sendLog && sendLog('[分轨] ' + s); } catch (_) {} };
  const progress = (p) => { try { sendProg && sendProg(p); } catch (_) {} };
  try {
    const models = await listSeparateModels();
    const installed = [];
    for (const m of models || []) {
      const r = resolveSeparateModel(m.id);
      if (r && r.exists) installed.push({ ...m, resolved: r });
    }
    let pick = installed.find(m => /htdemucs4_6stems/i.test(m.outName));
    if (!pick) pick = installed.find(m => /6stems/i.test(m.outName));
    if (!pick) pick = installed.find(m => /4stems|htdemucs4\./i.test(m.outName));
    if (!pick) return { ok: false, fallback: true, error: '没有安装可用的分轨模型（推荐 HTDemucs4_6stems）' };
    log('使用分轨模型 ' + pick.outName + '（' + (pick.size ? Math.round(pick.size / 1048576) + 'MB' : '已安装') + '）');
    const work = path.join(Paths.tempDir(), 'fufumidi-stems-' + Date.now());
    const stemsDir = path.join(work, 'stems');
    const midiDir = path.join(work, 'midi');
    fs.mkdirSync(stemsDir, { recursive: true }); fs.mkdirSync(midiDir, { recursive: true });
    progress({ stage: 'separate', text: '正在分轨…' });
    const req = SepCommon.buildSeparateRequest({
      audio: cfg.audio, sep_model: pick.id, out_dir: stemsDir,
      stems: ['vocals', 'drums', 'bass', 'piano', 'guitar', 'other'],
      format: 'wav', batch_size: 1, normalize: true,
    }, { resolveSeparateModel, readSettings, Paths, fs, msstRegistry: {} });
    if (!req.ok) return { ok: false, fallback: true, error: req.error };
    const sep = await spawnP(spawnEngine, req.args, { timeoutMs: 6 * 60 * 60 * 1000 });
    if (!sep.r || !sep.r.result || !sep.r.result.ok) {
      return { ok: false, fallback: true, error: '分轨失败：' + ((sep.r && (sep.r.err || sep.r.out)) || '').slice(-300) };
    }
    log('分轨完成');
    const files = fs.readdirSync(stemsDir).filter(f => /\.(wav|flac)$/i.test(f));
    if (!files.length) return { ok: false, fallback: true, error: '分轨完成但没有输出音轨' };
    const stems = files.map(f => ({ role: roleOf(f), name: f.replace(/\.[^.]+$/, ''), audio: path.join(stemsDir, f), midi: path.join(midiDir, f.replace(/\.[^.]+$/, '') + '.mid') }));
    progress({ stage: 'transcribe', text: '正在逐轨转录…', current: 0, total: stems.length, candidates: stems.length });
    const built = [];
    for (let i = 0; i < stems.length; i++) {
      const st = stems[i];
      if (!fs.existsSync(st.audio)) continue;
      log('转录 ' + st.role + '：' + path.basename(st.audio));
      const workerCfg = { ...cfg, audio: st.audio, out: st.midi, stemEnhance: false, __slots: 1, __logId: cfg.id + ':stem:' + i };
      try {
        const r = await engineWorkerConvert(workerCfg);
        if (r && r.ok) {
          built.push({ role: st.role, name: st.name, midi: st.midi });
          log('完成 ' + st.role + '：' + (r.note_count || 0) + ' notes');
        } else {
          log('跳过 ' + st.role + '：' + ((r && r.error) || '转录失败'));
        }
      } catch (e) { log('跳过 ' + st.role + '：' + ((e && e.message) || e)); }
      progress({ stage: 'transcribe', text: '转录 ' + st.role, current: i + 1, total: stems.length, candidates: stems.length });
    }
    if (!built.length) return { ok: false, fallback: true, error: '所有分轨转录均失败' };
    progress({ stage: 'merge', text: '正在合并并固定音色…' });
    const manifestIn = path.join(work, 'stem-manifest.json');
    fs.writeFileSync(manifestIn, JSON.stringify(built, null, 2));
    const out = cfg.out || path.join(work, 'merged.mid');
    const manifestOut = out.replace(/\.[^.]+$/, '') + '-manifest.json';
    const mr = await spawnP(spawnEngine, ['--out', out, '--manifest-in', manifestIn, '--manifest-out', manifestOut], { script: 'stem_merge.py', timeoutMs: 120000 });
    if (!mr.r || !mr.r.result || !mr.r.result.ok) return { ok: false, fallback: true, error: '合并失败：' + ((mr.r && (mr.r.err || mr.r.out)) || '').slice(-300) };
    progress({ stage: 'done', text: '完成', percent: 100 });
    return { ok: true, out, tracks: built, manifest: manifestOut, fallback: false };
  } catch (e) {
    return { ok: false, fallback: true, error: String((e && e.message) || e) };
  }
}

module.exports = { runStemWorkflow, roleOf };
