// E2E: P-012 configurable shortcuts — record, persist, and actually fire the remapped action.
import { encodeMidi } from "../../../frontend/src/core/midi.js";
const MIDI = Array.from(encodeMidi([{ name: "Piano", ch: 0, program: 0, notes: [{ start: 0, end: 960, midi: 60, vel: 100, ch: 0 }], ccs: [], events: [] }], { division: 480 }));

export default async function (app) {
  await app.waitFor("!!window.__fufumidiE2E", { timeout: 20000 });
  if (!(await app.eval("!!window.__fufumidiE2E.hasSong()"))) {
    await app.eval("window.__fufumidiE2E.importMidi('e2e-shortcuts.mid', " + JSON.stringify(MIDI) + ")");
    await app.waitFor("!!window.__fufumidiE2E.hasSong()", { timeout: 20000 });
  }
  await app.eval("localStorage.removeItem('fufumidi_shortcuts_v1')");
  await app.eval("document.querySelector('[data-guide=topbar-settings]').click()");
  await app.waitFor("!!document.querySelector('[data-guide=set-tab-keys]')", { timeout: 15000, message: "settings opened" });
  await app.eval("document.querySelector('[data-guide=set-tab-keys]').click()");
  await app.waitFor("!!document.querySelector('[data-guide=shortcut-togglePlay]')", { timeout: 10000, message: "shortcut editor visible" });
  await app.eval("document.querySelector('[data-guide=shortcut-togglePlay]').click()");
  await app.eval("window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', code: 'KeyT', bubbles: true }))");
  await new Promise((r) => setTimeout(r, 200));
  const stored = await app.eval("(() => { try { return JSON.parse(localStorage.getItem('fufumidi_shortcuts_v1') || '{}').togglePlay || ''; } catch (e) { return 'ERR'; } })()");
  const shown = await app.eval("(document.querySelector('[data-guide=shortcut-togglePlay]') || {}).innerText || ''");
  app.assert(stored === "T", "shortcut persisted as T: " + stored);
  app.assert(shown.trim() === "T", "shortcut button shows T: " + shown.trim());
  await app.screenshot('shortcuts-settings');
  await app.eval("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))");
  await app.waitFor("!document.querySelector('.overlay')", { timeout: 10000, message: "settings closed" });
  await app.eval("window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', code: 'KeyT', bubbles: true }))");
  await app.waitFor("window.__fufumidiLastShortcut === 'togglePlay'", { timeout: 3000, message: 'remapped shortcut fires togglePlay' });
  await app.waitFor("!!window.__fufumidiE2E.playing()", { timeout: 5000, message: 'playback starts' });
  const playing1 = await app.eval("!!window.__fufumidiE2E.playing()");
  await app.eval("window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', code: 'KeyT', bubbles: true }))");
  await new Promise((r) => setTimeout(r, 250));
  const playing2 = await app.eval("!!window.__fufumidiE2E.playing()");
  app.assert(playing1 === true, "remapped T starts playback");
  app.assert(playing2 === false, "remapped T stops playback");
  await app.eval("localStorage.removeItem('fufumidi_shortcuts_v1')");
  app.assert(true, "P-012 configurable shortcut passed");
}
