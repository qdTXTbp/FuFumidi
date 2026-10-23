#!/usr/bin/env node
// P1-3 质量基准运行器：调 engine/eval_quality.py → 与 docs/quality-baseline.json 比较（-2% 门禁）。
//
// 指标口径见 engine/eval_quality.py 顶部注释：
//   note F1（音高 + 起点 ±50ms）、onset F1、pedal F1（CC64 区间）。
// 默认跑「确定性合成样本自检」：identity 必须 1.0，perturbed 基线作为指标实现的体检基线；
// 真实转录模型产出后用 --pred-dir <dir> 对同一批真值算真实指标（同样写基线/比较）。
//
// 用法：
//   node scripts/eval-quality.mjs                     # 跑门禁（缺基线时自动建）
//   node scripts/eval-quality.mjs --update-baseline   # 重新记录基线
//   node scripts/eval-quality.mjs --pred-dir out/midi # 用真实预测评估（不更新默认基线）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PY_SCRIPT = path.join(ROOT, 'engine', 'eval_quality.py');
const QUALITY_DIR = path.join(ROOT, 'engine', 'tests', 'quality');
const BASELINE = path.join(ROOT, 'docs', 'quality-baseline.json');
const TOL = 0.02;   // 门禁：不得低于基线 2%

const argv = process.argv.slice(2);
const updateBaseline = argv.includes('--update-baseline');
const predIdx = argv.indexOf('--pred-dir');
const predDir = predIdx >= 0 ? argv[predIdx + 1] : '';

function findPython() {
  const cands = [
    process.env.FUFUMIDI_PYTHON,
    process.env.PYTHON,
    'E:/Midi/FuFumidi/resources/python/python.exe',
    'python',
    'python3',
  ].filter(Boolean);
  for (const exe of cands) {
    try {
      const r = spawnSync(exe, ['-c', 'import mido, numpy; print(1)'], { encoding: 'utf8', timeout: 20000 });
      if (r.status === 0 && String(r.stdout).includes('1')) return exe;
    } catch (e) { /* 继续找 */ }
  }
  return null;
}

function runPy(args) {
  const exe = findPython();
  if (!exe) throw new Error('找不到可用的 Python（需 mido + numpy）。设置 FUFUMIDI_PYTHON 或安装依赖。');
  const r = spawnSync(exe, [PY_SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 10 * 60 * 1000 });
  const out = String(r.stdout || '').trim();
  const line = out.split(/\r?\n/).filter(Boolean).pop() || '';
  try { return JSON.parse(line); } catch (e) {
    throw new Error('eval_quality.py 输出无法解析：' + (r.stderr || out).slice(0, 500));
  }
}

function ensureSamples() {
  const marker = path.join(QUALITY_DIR, 'case1_melody.mid');
  if (fs.existsSync(marker)) return;
  const r = runPy(['--synth-dir', QUALITY_DIR]);
  if (!r.ok) throw new Error('合成样本失败：' + JSON.stringify(r).slice(0, 300));
  console.log('已生成确定性样本：' + path.relative(ROOT, QUALITY_DIR) + '（' + r.cases.length + ' 个用例）');
}

function flatten(selfTest) {
  const out = {};
  for (const [name, v] of Object.entries(selfTest.cases)) {
    out[name] = {
      identityNoteF1: v.identity.note.f1,
      identityOnsetF1: v.identity.onset.f1,
      identityPedalF1: v.identity.pedal.f1,
      perturbedNoteF1: v.perturbed.note.f1,
      perturbedOnsetF1: v.perturbed.onset.f1,
    };
  }
  return out;
}

function loadBaseline() {
  try { return JSON.parse(fs.readFileSync(BASELINE, 'utf8')); } catch (e) { return null; }
}

function writeBaseline(cases, extra) {
  const doc = {
    format: 'fufumidi-quality-baseline',
    version: 1,
    updatedAt: new Date().toISOString(),
    tolerance: TOL,
    metrics: ['noteF1', 'onsetF1', 'pedalF1'],
    note: 'identity 应恒为 1.0；perturbed 是同一套扰动下的指标实现体检值。真实转录模型的基线用 --pred-dir 跑出来后单独记录（不要覆盖默认基线）。',
    cases,
    ...(extra || {}),
  };
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
  fs.writeFileSync(BASELINE, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return doc;
}

function gate(cases) {
  const base = loadBaseline();
  if (!base) { writeBaseline(cases); console.log('首次运行：已写入基线 ' + path.relative(ROOT, BASELINE)); return true; }
  let bad = 0;
  const rows = [];
  for (const [name, cur] of Object.entries(cases)) {
    const b = (base.cases || {})[name];
    if (!b) { rows.push([name, '新增用例（无基线，跳过比较）', '']); continue; }
    for (const key of Object.keys(cur)) {
      const min = Number(b[key]);
      if (!Number.isFinite(min)) continue;
      const ok = cur[key] >= min - TOL;
      if (!ok) bad += 1;
      rows.push([name, key, cur[key].toFixed(4) + ' (min ' + (min - TOL).toFixed(4) + ')' + (ok ? '' : '  ✗')]);
    }
  }
  console.log('质量基准（identity 必须 1.0；perturbed 不得低于基线 -' + (TOL * 100) + '%）');
  for (const r of rows) console.log('  ' + r[0].padEnd(18) + r[1].padEnd(20) + r[2]);
  if (bad) { console.log('  ✗ ' + bad + ' 项低于基线'); return false; }
  console.log('  ✓ 全部通过');
  return true;
}

function main() {
  ensureSamples();
  if (predDir) {
    const r = runPy(['--pred-dir', path.resolve(ROOT, predDir)]);
    if (!r.ok) { console.error('评估失败：' + JSON.stringify(r).slice(0, 500)); process.exit(1); }
    const rows = (r.cases || []).map((c) => ({
      case: c.gt, noteF1: c.note.f1, noteP: c.note.precision, noteR: c.note.recall,
      onsetF1: c.onset.f1, pedalF1: c.pedal.f1, durErr: c.durationErrorSec,
    }));
    const report = { ok: true, mode: 'pred-dir', predDir, cases: rows };
    const outFile = path.join(ROOT, 'docs', 'quality-last-run.json');
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log('真实预测评估：' + rows.length + ' 个用例 → ' + path.relative(ROOT, outFile));
    for (const r2 of rows) console.log('  ' + r2.case.padEnd(18) + ' noteF1 ' + r2.noteF1 + '  onsetF1 ' + r2.onsetF1 + '  pedalF1 ' + r2.pedalF1);
    return;
  }
  const r = runPy(['--self-test']);
  if (!r.ok) { console.error('自检失败：' + JSON.stringify(r).slice(0, 500)); process.exit(1); }
  const cases = flatten(r);
  if (updateBaseline) {
    writeBaseline(cases);
    console.log('已更新基线：' + path.relative(ROOT, BASELINE));
    return;
  }
  const ok = gate(cases);
  process.exit(ok ? 0 : 1);
}

try { main(); } catch (e) {
  console.error(String((e && e.message) || e));
  process.exit(1);
}
