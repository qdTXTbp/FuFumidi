#!/usr/bin/env node
// 前端设计回归：三大视图 × 三档窗口宽度（980 / 1280 / 1585）
// 用法：node scripts/design/shoot.mjs
import fs from "node:fs";
import path from "node:path";
import { launchApp, ROOT, sleep } from "../e2e/lib.mjs";
import { encodeMidi } from "../../frontend/src/core/midi.js";
const OUT = path.join(ROOT, "scripts", "design", "artifacts");
const WIDTHS = [980, 1280, 1585];
const HEIGHT = 900;
const VIEWS = [
  { hash: "#/edit", name: "edit", marker: "canvas" },
  { hash: "#/singer", name: "sing", marker: "演唱" },
  { hash: "#/transcribe", name: "transcribe", marker: "转录" },
];
const MINI = Array.from(encodeMidi([{
  name: "Design Mini", ch: 0, program: 0, notes: [
    { start: 0, end: 480, midi: 60, vel: 100, ch: 0 },
    { start: 480, end: 960, midi: 64, vel: 90, ch: 0 },
    { start: 960, end: 1440, midi: 67, vel: 95, ch: 0 },
    { start: 1440, end: 1920, midi: 72, vel: 80, ch: 0 },
  ], ccs: [], events: [],
}], { division: 480 }));
const MEASURE_JS = `(() => {
  const iw = window.innerWidth;
  const all = [...document.querySelectorAll("body *")];
  const bad = [];
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) continue;
    if (r.right <= iw + 1) continue;
    if (r.left >= iw) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
    const cls = (el.className && typeof el.className === "string") ? el.className.split(/\s+/).slice(0, 4).join(".") : "";
    bad.push({ tag: el.tagName.toLowerCase(), cls, left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) });
  }
  const uniq = [];
  const seen = new Set();
  for (const b of bad) { const k = b.tag + "|" + b.cls + "|" + b.right; if (!seen.has(k)) { seen.add(k); uniq.push(b); } }
  return { innerWidth: iw, innerHeight: window.innerHeight, scrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body ? document.body.scrollWidth : 0, overflowX: document.documentElement.scrollWidth > iw + 1, offenders: uniq.sort((a, b) => b.right - a.right).slice(0, 12) };
})()`;
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const app = await launchApp({ connectTimeoutMs: 90000 });
  const report = { generatedAt: new Date().toISOString(), version: JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version, widths: WIDTHS, views: [] };
  try {
    await app.waitFor("document.body && document.body.innerText.length > 100", { timeout: 60000 });
    try {
      await app.waitFor("!!(window.__fufumidiE2E)", { timeout: 20000 });
      const has = await app.eval("!!(window.__fufumidiE2E && window.__fufumidiE2E.hasSong())");
      if (!has) {
        await app.eval("window.__fufumidiE2E.importMidi(\"design-mini.mid\", " + JSON.stringify(MINI) + ")");
        await app.waitFor("!!(window.__fufumidiE2E && window.__fufumidiE2E.hasSong())", { timeout: 30000 });
      }
    } catch (e) { console.warn("[design] 无法注入测试曲目：" + e.message); }
    for (const w of WIDTHS) {
      await app.send("Emulation.setDeviceMetricsOverride", { width: w, height: HEIGHT, deviceScaleFactor: 1, mobile: false, screenWidth: w, screenHeight: HEIGHT });
      await sleep(350);
      for (const v of VIEWS) {
        await app.navigate(v.hash);
        await app.waitFor("location.hash.indexOf(" + JSON.stringify(v.hash) + ") >= 0", { timeout: 20000 });
        try { await app.waitFor("document.body.innerText.indexOf(" + JSON.stringify(v.marker) + ") >= 0 || !!document.querySelector(\"canvas\")", { timeout: 30000 }); } catch (e) {}
        await app.eval("new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res(true))))");
        await sleep(400);
        const m = await app.eval(MEASURE_JS);
        const name = v.name + "-" + w;
        const shot = await app.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(shot.data, "base64"));
        report.views.push(Object.assign({ view: v.name, hash: v.hash, width: w, file: name + ".png" }, m));
        console.log("[design] " + name + "  overflowX=" + m.overflowX + (m.offenders.length ? "  越界元素 " + m.offenders.length : ""));
      }
    }
    await app.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  } finally { await app.close(); }
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log("[design] 报告：" + path.join(OUT, "report.json"));
  const bad = report.views.filter((r) => r.overflowX);
  console.log(bad.length ? "[design] 横向溢出：" + bad.map((b) => b.view + "@" + b.width).join(", ") : "[design] 三档宽度均无横向溢出");
}
main().catch((e) => { console.error("[design] FAIL: " + ((e && e.stack) || e)); process.exit(1); });
