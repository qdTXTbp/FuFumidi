// E2E: P-015 arrange clips must drive player.events (move/mute change playback source).
import { encodeMidi } from "../../../frontend/src/core/midi.js";

const MIDI = Array.from(encodeMidi([
  { name: "Piano", ch: 0, program: 0, notes: [{ start: 0, end: 1920, midi: 60, vel: 100, ch: 0 }], ccs: [], events: [] },
  { name: "Strings", ch: 1, program: 48, notes: [{ start: 960, end: 2880, midi: 72, vel: 90, ch: 1 }], ccs: [], events: [] },
], { division: 480 }));

export default async function (app) {
  await app.waitFor("!!window.__fufumidiE2E", { timeout: 20000, message: "E2E hooks ready" });
  if (!(await app.eval("!!window.__fufumidiE2E.hasSong()"))) {
    await app.eval("window.__fufumidiE2E.importMidi('e2e-arrange-playback.mid', " + JSON.stringify(MIDI) + ")");
    await app.waitFor("!!window.__fufumidiE2E.hasSong()", { timeout: 20000 });
  }
  await app.navigate("#/views?tab=arrange");
  await app.waitFor("location.hash.indexOf('arrange') >= 0", { timeout: 15000 });
  await app.waitFor("!!document.querySelector('[data-guide=arrange-canvas] canvas')", { timeout: 30000, message: "arrange canvas mounted" });
  await app.waitFor("window.__fufumidiE2E.song() && window.__fufumidiE2E.song().arrange && window.__fufumidiE2E.song().arrange.clips && window.__fufumidiE2E.song().arrange.clips.length > 0", { timeout: 6000, message: "arrange persisted into song.arrange" });
  if (!(await app.eval("!!window.__fufumidiActivePlayer"))) {
    await app.eval("window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }))");
    await app.waitFor("!!window.__fufumidiActivePlayer", { timeout: 20000, message: "player initialized" });
  }
  const d = await app.eval("(() => { const p = window.__fufumidiActivePlayer; const song = window.__fufumidiE2E.song(); if (!p || !song || !song.arrange || !Array.isArray(song.arrange.clips) || !song.arrange.clips.length) return { err: 'no-player-or-arrange', player: !!p, clips: song && song.arrange ? (song.arrange.clips || []).length : -1 }; p.load(song); const base = p.events.map((e) => e.start); const c = song.arrange.clips[0]; const oldStart = c.startTick || 0; const oldMuted = !!c.muted; c.startTick = oldStart + 1920; p.load(song); const moved = p.events.map((e) => e.start); const movedCount = p.events.length; c.startTick = oldStart; c.muted = true; p.load(song); const mutedCount = p.events.length; c.muted = oldMuted; p.load(song); return { clips: song.arrange.clips.length, base: base.slice().sort((a, b) => a - b), moved: moved.slice().sort((a, b) => a - b), movedCount, mutedCount }; })()");
  app.assert(!d.err, "arrange data and player available: " + JSON.stringify(d.err || ""));
  app.assert(d.base.length > 0, "arrange baseline events: " + d.base.length);
  app.assert(d.movedCount === d.base.length, "moving clip keeps events: " + d.base.length + " -> " + d.movedCount);
  app.assert(JSON.stringify(d.base) !== JSON.stringify(d.moved), "moving clip changes event starts: " + JSON.stringify(d.base.slice(0, 3)) + " -> " + JSON.stringify(d.moved.slice(0, 3)));
  app.assert(d.mutedCount < d.base.length, "muting clip reduces events: " + d.base.length + " -> " + d.mutedCount);
  app.assert(true, "P-015 arrange clips -> player events passed");
}
