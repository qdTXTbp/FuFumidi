#!/usr/bin/env node
// P2-5 DAWproject 格式合规门禁：用官方 XSD 校验我们导出的 project.xml / metadata.xml。
// 用法：node scripts/validate-dawproject.mjs [--file project.xml --metadata metadata.xml]
// 没有 lxml 环境时打印跳过并退出 0（普通用户/发布包不需要 Python lxml）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { songToDawprojectModel, buildProjectXml, buildMetadataXml } from '../frontend/src/core/dawproject.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_DIR = path.join(ROOT, 'docs', 'dawproject');
const argv = process.argv.slice(2);
function arg(name, def = '') { const i = argv.indexOf('--' + name); return i >= 0 ? (argv[i + 1] || def) : def; }
const pyCandidates = [
  process.env.FUFUMIDI_LXML_PYTHON,
  'E:/Midi/_attic/envs/plugin-uv/Scripts/python.exe',
  'E:/Midi/_attic/envs/engine-test/Scripts/python.exe',
  'python', 'py',
].filter(Boolean);
function hasLxml(exe) {
  try {
    const r = spawnSync(exe, ['-c', 'import lxml.etree; print(1)'], { encoding: 'utf8', timeout: 30000 });
    return r.status === 0 && String(r.stdout).includes('1');
  } catch (e) { return false; }
}
const py = pyCandidates.find(hasLxml);
if (!py) {
  console.log('跳过 DAWproject XSD 校验：没有找到带 lxml 的 Python（可选，安装 lxml 后再跑）');
  process.exit(0);
}
if (!fs.existsSync(path.join(SCHEMA_DIR, 'Project.xsd'))) {
  console.error('缺少 docs/dawproject/Project.xsd');
  process.exit(2);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fufumidi-dawproject-'));
let projectFile = arg('file');
let metadataFile = arg('metadata');
if (!projectFile) {
  const song = {
    name: 'DAWproject XSD sample', artist: 'FuFumidi', bpm: 120, tpb: 480, totalTicks: 480 * 8,
    timeSignature: { numerator: 4, denominator: 4 },
    tracks: [
      { name: 'Lead', notes: [{ start: 0, end: 480, midi: 60, vel: 100, ch: 0 }] },
      { name: 'Chords', notes: [{ start: 0, end: 1920, midi: 48, vel: 70, ch: 1 }] },
    ],
  };
  const model = songToDawprojectModel(song, { title: 'DAWproject XSD sample', markers: [{ time: 4, name: 'Chorus' }] });
  projectFile = path.join(dir, 'project.xml');
  metadataFile = path.join(dir, 'metadata.xml');
  fs.writeFileSync(projectFile, buildProjectXml(model, { appVersion: '6.0.3' }), 'utf8');
  fs.writeFileSync(metadataFile, buildMetadataXml(model), 'utf8');
}
const args = [path.join(ROOT, 'engine', 'validate_dawproject.py'), '--schema-dir', SCHEMA_DIR, '--project', projectFile];
if (metadataFile) args.push('--metadata', metadataFile);
const r = spawnSync(py, args, { encoding: 'utf8', timeout: 120000 });
process.stdout.write(r.stdout || '');
process.stderr.write(r.stderr || '');
if (r.status === 2 && String(r.stdout).includes('backend-missing')) {
  console.log('跳过 DAWproject XSD 校验：Python 环境缺少 lxml');
  process.exit(0);
}
if (r.status !== 0) {
  console.error('DAWproject XSD 校验失败');
  process.exit(r.status || 1);
}
console.log('DAWproject 官方 XSD 校验通过（' + py + '）');
