// E2E：P0-5 默认 GM 懒加载真链路 —— 首播初始化音频时自动加载内置 GeneralUser GS。
// 做法：先给 E2E 开音频白名单（localStorage），再导入最小 MIDI 触发 ensureAudio，
// 等 synth 把 29.8MB 的 SF2 装载完成，读 window.__fufumidi_appliedSoundfont 验证。
import { encodeMidi } from '../../../frontend/src/core/midi.js';

const MINI = Array.from(encodeMidi([{
  name: 'E2E GM', ch: 0, program: 0,
  notes: [{ start: 0, end: 480, midi: 60, vel: 100, ch: 0 }], ccs: [], events: [],
}], { division: 480 }));

export default async function (app) {
  await app.waitFor("!!(window.__fufumidiE2E)", { timeout: 20000, message: "E2E 测试钩子已注册" });
  // 先查内置音色列表真的能列出 GeneralUser（主进程 soundfont:list → 随包 vendor 目录）
  const list = await app.eval("(async () => JSON.stringify(await window.fuBridge.soundfonts.list()))()");
  app.assert(/GeneralUser\.sf2/i.test(String(list)), "soundfonts.list 能列出内置 GeneralUser：" + String(list).slice(0, 200));
  // 录音频白名单，再导入曲子触发 ensureAudio
  await app.eval("localStorage.setItem('fufumidi_e2e_audio', '1')");
  await app.eval("window.__fufumidiE2E.importMidi('e2e-gm.mid', " + JSON.stringify(MINI) + ")");
  await app.waitFor("!!(window.__fufumidiE2E.hasSong())", { timeout: 20000 });
  await app.waitFor("!!window.__fufumidiActivePlayer", { timeout: 20000, message: "音频引擎已初始化" });
  // 应用启动时音频可能已初始化（那时白名单还没设，懒加载被跳过）——这里显式再试一次，
  // 走的是与首播自动懒加载完全相同的函数，验证 IPC 列表 → 读 29.8MB SF2 → synth 装载。
  await app.eval("window.__fufumidiTryDefaultGm()");
  // 29.8MB SF2 解析需要几秒：等到 appliedSoundfont 变成 GeneralUser 路径
  await app.waitFor("String(window.__fufumidi_appliedSoundfont || '').indexOf('GeneralUser') >= 0", { timeout: 120000, message: "默认 GM 自动加载完成" });
  const applied = await app.eval("String(window.__fufumidi_appliedSoundfont || '')");
  app.assert(/GeneralUser\.sf2$/i.test(applied), "appliedSoundfont 指向内置 GeneralUser：" + applied);
  app.assert(true, "默认 GM 懒加载真链路通过：" + applied);
}