import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const r = spawnSync(path.join(root, 'resources', 'python', 'python.exe'), [path.join(root, 'scripts', 'tauri', 'cover-engine-smoke.py')], { stdio: 'inherit', cwd: root });
process.exit(r.status == null ? 1 : r.status);
