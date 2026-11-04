import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const target = process.env.CARGO_TARGET_DIR ? path.resolve(process.env.CARGO_TARGET_DIR) : path.join(root, 'target');
const src = path.join(root, 'engine');
const dst = path.join(target, 'release', 'engine');
function copy(d, out) {
  mkdirSync(out, { recursive: true });
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name === '__pycache__' || e.name === 'tests') continue;
    const s = path.join(d, e.name), t = path.join(out, e.name);
    if (e.isDirectory()) copy(s, t); else if (e.isFile()) cpSync(s, t);
  }
}
if (!existsSync(src)) { console.error('engine directory missing'); process.exit(1); }
copy(src, dst);
console.log(JSON.stringify({ ok: true, dst }));
