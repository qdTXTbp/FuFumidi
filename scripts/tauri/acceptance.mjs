import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const quick = process.argv.includes('--quick');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmShell = process.platform === 'win32';
const target = process.env.CARGO_TARGET_DIR || path.join(root, 'poc', 'tauri-poc', 'target');
const steps = [
  { name: 'typecheck', cmd: npm, args: ['run', 'typecheck'] },
  { name: 'audit', cmd: npm, args: ['run', 'audit'] },
  { name: 'test:ui', cmd: npm, args: ['run', 'test:ui'] },
  { name: 'video-smoke', cmd: npm, args: ['run', 'tauri:video-smoke'] },
  { name: 'cover-engine-smoke', cmd: npm, args: ['run', 'tauri:cover-engine-smoke'] },
  { name: 'separate-smoke', cmd: npm, args: ['run', 'tauri:separate-smoke'] },
  { name: 'cargo-test', cmd: 'cargo', args: ['test', '--offline'], cwd: path.join(root, 'shells', 'tauri') },
];
if (!quick) {
  steps.splice(3, 0, { name: 'hidden-e2e', cmd: 'node', args: ['scripts/e2e/run.mjs'] });
  steps.push({ name: 'release-build', cmd: 'cargo', args: ['build', '--release', '--offline'], cwd: path.join(root, 'shells', 'tauri') });
  steps.push({ name: 'host-self-check', cmd: path.join(target, 'release', 'fufumidi-shell.exe'), args: ['--self-check'] });
  steps.push({ name: 'engine-self-check', cmd: path.join(target, 'release', 'fufumidi-shell.exe'), args: ['--engine-self-check'] });
}
let failed = 0;
for (const s of steps) {
  process.stdout.write('\n== ' + s.name + ' ==\n');
  const r = spawnSync(s.cmd, s.args, { cwd: s.cwd || root, stdio: 'inherit', shell: s.cmd === npm ? npmShell : false, env: { ...process.env, CARGO_TARGET_DIR: target } });
  if (r.status !== 0) { failed++; console.error('FAILED: ' + s.name); break; }
}
console.log(JSON.stringify({ ok: failed === 0, quick, steps: steps.map((s) => s.name) }));
process.exit(failed === 0 ? 0 : 1);
