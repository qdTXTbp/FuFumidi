// MusicXML 解析 → song 对象（从 legacy FuFumidi.html 抽取，行为保持一致）
import { buildSong } from './midi.js';
import { clamp } from './util.js';
import { t } from './i18n.js';

const STEP = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function parseMusicXMLToSong(xmlText, fileName) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error(t('MusicXML 解析失败'));
  const tpb = Math.max(1, parseInt(doc.querySelector('divisions') && doc.querySelector('divisions').textContent || '480', 10) || 480);
  let bpm = 120;
  const sound = doc.querySelector('sound');
  if (sound && sound.getAttribute('tempo')) bpm = parseFloat(sound.getAttribute('tempo')) || 120;
  let num = 4, den = 4;
  const sigEl = doc.querySelector('time');
  if (sigEl) {
    num = parseInt(sigEl.querySelector('beats') && sigEl.querySelector('beats').textContent || '4', 10) || 4;
    den = parseInt(sigEl.querySelector('beat-type') && sigEl.querySelector('beat-type').textContent || '4', 10) || 4;
  }
  const fifths = parseInt(doc.querySelector('fifths') && doc.querySelector('fifths').textContent || '0', 10) || 0;
  const tracks = [];
  doc.querySelectorAll('part').forEach((part, pi) => {
    const name = (part.querySelector('part-name') && part.querySelector('part-name').textContent || '').trim() || (t('音轨 ') + (pi + 1));
    let cursor = 0;
    const active = new Map();
    const notes = [];
    const closeDue = () => {
      for (const [p, a] of Array.from(active)) if (cursor >= a.end) { notes.push({ start: a.start, end: a.end, midi: p, vel: a.vel }); active.delete(p); }
    };
    for (const m of part.querySelectorAll('measure')) {
      for (const el of m.children) {
        const tag = el.tagName;
        const dEl = el.querySelector('duration');
        const dur = dEl ? (parseInt(dEl.textContent, 10) || 0) : 0;
        if (tag === 'backup') { cursor = Math.max(0, cursor - dur); closeDue(); continue; }
        if (tag === 'forward') { cursor += dur; closeDue(); continue; }
        if (tag !== 'note') continue;
        const chord = !!el.querySelector('chord');
        const pitch = el.querySelector('pitch');
        if (!chord && !pitch) { cursor += dur; closeDue(); continue; }   // rest
        if (pitch) {
          const step = (pitch.querySelector('step') && pitch.querySelector('step').textContent || 'C').trim();
          const oct = parseInt(pitch.querySelector('octave') && pitch.querySelector('octave').textContent || '4', 10) || 4;
          const alter = parseInt(pitch.querySelector('alter') && pitch.querySelector('alter').textContent || '0', 10) || 0;
          const midi = clamp(12 * (oct + 1) + (STEP[step] || 0) + alter, 0, 127);
          const vel = clamp(parseInt(el.querySelector('velocity') && el.querySelector('velocity').textContent || '80', 10) || 80, 1, 127);
          if (!chord && active.has(midi)) { const a = active.get(midi); notes.push({ start: a.start, end: cursor, midi, vel: a.vel }); active.delete(midi); }
          if (!active.has(midi)) active.set(midi, { start: cursor, end: cursor + dur, vel });
          if (!chord) { cursor += dur; closeDue(); }
        }
      }
      for (const [p, a] of active) notes.push({ start: a.start, end: Math.max(a.start + 1, cursor), midi: p, vel: a.vel });
      active.clear();
    }
    notes.sort((a, b) => a.start - b.start);
    tracks.push({ name, ch: pi % 15, program: 0, notes, events: [], ccs: [] });
  });
  if (!tracks.length) throw new Error(t('MusicXML 没有找到声部'));
  tracks[0].events.push({ tick: 0, type: 'tempo', us: Math.round(60000000 / bpm) });
  tracks[0].events.push({ tick: 0, type: 'sig', num, den });
  if (fifths) tracks[0].events.push({ tick: 0, type: 'key', sf: fifths, mi: 0 });
  const mid = { format: 1, ntrks: tracks.length, ticksPerBeat: tpb, tracks };
  return buildSong(mid, { name: fileName, fileName, fileSize: xmlText.length });
}
