import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const py = path.join(root, 'resources', 'python', 'python.exe');
const script = path.join(root, 'engine', 'engine_cover.py');
const r = spawnSync(py, [script, 'all', '--help'], { cwd: path.join(root, 'engine'), encoding: 'utf8' });
const text = String(r.stdout || '') + String(r.stderr || '');
const ok = r.status === 0 && text.includes('--rvc-model') && text.includes('--sep-model') && text.includes('--no-separate');
console.log(JSON.stringify({ ok, status: r.status, hasRvcModel: text.includes('--rvc-model'), hasSepModel: text.includes('--sep-model'), hasNoSeparate: text.includes('--no-separate') }));
process.exit(ok ? 0 : 1);
