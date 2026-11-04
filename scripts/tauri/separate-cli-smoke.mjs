import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const r = spawnSync(path.join(root, 'resources', 'python', 'python.exe'), [path.join(root, 'engine', 'music2midi.py'), 'separate', '--help'], { cwd: path.join(root, 'engine'), encoding: 'utf8' });
const text = String(r.stdout || '') + String(r.stderr || '');
const ok = r.status === 0 && text.includes('--model') && text.includes('--arch') && text.includes('--stems') && text.includes('--output');
console.log(JSON.stringify({ ok, status: r.status, hasModel: text.includes('--model'), hasArch: text.includes('--arch'), hasStems: text.includes('--stems'), hasOutput: text.includes('--output') }));
process.exit(ok ? 0 : 1);
