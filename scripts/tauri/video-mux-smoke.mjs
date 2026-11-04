import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const py = path.join(root, 'resources', 'python', 'python.exe');
const script = path.join(root, 'scripts', 'tauri', 'video-mux-smoke.py');
const r = spawnSync(py, [script], { stdio: 'inherit' });
process.exit(r.status == null ? 1 : r.status);
