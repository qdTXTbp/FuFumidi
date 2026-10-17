// E2E 运行器：node scripts/e2e/run.mjs [用例过滤...] [--keep]
// 每个用例一个全新开发态实例（FUFUMIDI_E2E=1）；产物在 scripts/e2e/artifacts/。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchApp, ensureArtifacts, ARTIFACTS } from './lib.mjs';

const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const filters = argv.filter((a) => !a.startsWith("--"));
const casesDir = path.join(import.meta.dirname, "cases");

function listCases() {
  if (!fs.existsSync(casesDir)) return [];
  return fs.readdirSync(casesDir)
    .filter((f) => f.endsWith(".mjs"))
    .sort()
    .filter((f) => !filters.length || filters.some((x) => f.includes(x)));
}

// 已知无害的浏览器/环境噪声（真异常必须让用例失败）
const BENIGN = [
  /DevTools/i, /Autofill/i, /GPU stall/i, /WebGL.*fallback/i,
  /Failed to load resource: net::ERR_FILE_NOT_FOUND/i,
  // FluidSynth（wasm）在加载 SF2 时会往 console.error 打库内告警：
  //   "function fluid_file_test is a stub"（emscripten 特性）、"Discarding invalid global zone"（第三方 SF2 数据问题）。
  // 这些不是应用异常，用例不该因此失败。
  /fluidsynth[::\s]/i, /Discarding invalid global zone/i, /fluid_file_test/i,
];
const isBenign = (msg) => BENIGN.some((r) => r.test(String(msg || "")));

async function main() {
  ensureArtifacts();
  const cases = listCases();
  if (!cases.length) { console.error("没有匹配的 E2E 用例"); process.exit(2); }
  console.log(`E2E：${cases.length} 个用例（${cases.join(", ")}）`);
  const results = [];
  for (const file of cases) {
    const name = file.replace(/\.mjs$/, "");
    console.log(`\n── ${name} ──`);
    const meta = { name, ok: false, ms: 0, error: "", screenshot: "" };
    const t0 = Date.now();
    let app = null;
    try {
      app = await launchApp();
      const mod = await import(pathToFileURL(path.join(casesDir, file)).href + "?t=" + Date.now());
      if (typeof mod.default !== "function") throw new Error("用例必须 export default async function(app)");
      await mod.default(app, { artifacts: ARTIFACTS });
      // 用例跑完后统一检查未捕获异常 / console.error
      const badExceptions = app.exceptions.filter((e) => !isBenign(e.text));
      const badConsole = app.consoleErrors.filter((e) => !isBenign(e.text));
      if (badExceptions.length) {
        throw new Error("页面未捕获异常：" + badExceptions.slice(0, 3).map((e) => e.text.split("\n")[0]).join(" | "));
      }
      if (badConsole.length) {
        throw new Error("console.error：" + badConsole.slice(0, 3).map((e) => e.text).join(" | "));
      }
      meta.ok = true;
      console.log("  ✓ 通过");
    } catch (e) {
      meta.error = String((e && e.stack) || e);
      console.log("  ✗ 失败：" + String((e && e.message) || e));
      try { if (app) meta.screenshot = await app.screenshot(name + "-fail"); } catch (_) {}
    } finally {
      if (app && !keep) await app.close();
      meta.ms = Date.now() - t0;
      if (app) meta.log = app.logFile;
      results.push(meta);
    }
  }
  const pass = results.filter((r) => r.ok).length;
  console.log(`\nE2E 结果：${pass}/${results.length} 通过`);
  for (const r of results) {
    if (!r.ok) console.log(`  ✗ ${r.name}：${r.error.split("\n")[0]}`);
  }
  if (results.some((r) => !r.ok)) {
    console.log("\n产物：" + ARTIFACTS);
    process.exit(1);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });