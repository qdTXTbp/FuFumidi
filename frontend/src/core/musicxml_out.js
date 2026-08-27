// MIDI 歌曲 → MusicXML（单轨 / 多轨），供 Verovio 渲染与 MusicXML 导出使用。
// 从 v2.1.0 renderer/FuFumidi.html 抽取，行为保持一致。

function escXml(x) {
  return String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function midiToPitch(m) {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const pc = ((m % 12) + 12) % 12;
  const oct = Math.floor(m / 12) - 1;
  const n = names[pc];
  return { step: n[0], alter: n.length > 1 ? 1 : 0, octave: oct };
}

export function musicXmlType(duration, tpb) {
  const q = duration / Math.max(1, tpb);
  if (q >= 3.5) return { type: 'whole', dot: false };
  if (q >= 2.8) return { type: 'half', dot: true };
  if (q >= 1.75) return { type: 'half', dot: false };
  if (q >= 1.4) return { type: 'quarter', dot: true };
  if (q >= 0.875) return { type: 'quarter', dot: false };
  if (q >= 0.7) return { type: 'eighth', dot: true };
  if (q >= 0.4375) return { type: 'eighth', dot: false };
  if (q >= 0.35) return { type: '16th', dot: true };
  if (q >= 0.21875) return { type: '16th', dot: false };
  if (q >= 0.109375) return { type: '32nd', dot: false };
  return { type: '64th', dot: false };
}

export function inferKeyFifths(notes) {
  const MAJOR = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
  const MINOR = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
  const hist = new Array(12).fill(0);
  for (const n of (notes || [])) hist[((n.midi % 12) + 12) % 12]++;
  let best = null;
  for (let i = 0; i < 12; i++) {
    for (const pair of [[MAJOR, 'major'], [MINOR, 'minor']]) {
      const prof = pair[0], mode = pair[1];
      let sc = 0;
      for (let j = 0; j < 12; j++) sc += hist[(i + j) % 12] * prof[j];
      if (!best || sc > best.score) best = { score: sc, pc: i, mode };
    }
  }
  const F = [0,7,2,-3,4,-1,6,1,-4,3,-2,5];
  return { fifths: best ? F[best.pc] : 0, mode: best ? best.mode : 'major' };
}

export function velocityDynTag(v) {
  v = Number(v) || 80;
  if (v >= 120) return 'fff';
  if (v >= 108) return 'ff';
  if (v >= 96) return 'f';
  if (v >= 88) return 'mf';
  if (v >= 76) return 'mp';
  if (v >= 58) return 'p';
  if (v >= 40) return 'pp';
  return 'ppp';
}

export function bpmOfSong(song) {
  try {
    if (song && song.tempoMap && song.tempoMap[0]) return Math.round(60000000 / song.tempoMap[0].us);
    if (song && song.initialBpm) return Math.round(song.initialBpm);
  } catch (e) {}
  return 120;
}

// 单轨 MusicXML（供 Verovio 渲染当前乐谱轨道）
export function songToMusicXMLTrack(song, ti) {
  const tr = song.tracks[ti];
  const tpb = song.tpb || 480;
  const sig = song.sigMap[0] || { num: 4, den: 4 };
  const barLen = Math.max(1, Math.round(sig.num * tpb * 4 / sig.den));
  const bars = song.bars || Math.ceil(song.totalTicks / barLen);

  // 歌词
  const lyrics = [];
  for (const e of (tr.events || [])) if (e.type === 'lyric' && e.text && e.text.trim()) lyrics.push({ tick: e.tick, text: e.text.trim() });
  if (!lyrics.length) for (const t of song.tracks) for (const e of (t.events || [])) if (e.type === 'lyric' && e.text && e.text.trim()) lyrics.push({ tick: e.tick, text: e.text.trim() });
  lyrics.sort((a, b) => a.tick - b.tick);

  // 段落/文本记号
  const marks = [];
  for (const t of song.tracks) for (const e of (t.events || [])) if ((e.type === 'text' || e.type === 'marker') && e.text && e.text.trim()) marks.push({ tick: e.tick, text: e.text.trim() });
  marks.sort((a, b) => a.tick - b.tick);

  const CHORD_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  function barChord(b) {
    const t0 = b * barLen, t1 = t0 + barLen;
    const hist = new Array(12).fill(0);
    for (const trk of song.tracks) {
      if (trk.isDrum) continue;
      for (const n of trk.notes) if (n.end > t0 && n.start < t1) hist[((n.midi % 12) + 12) % 12]++;
    }
    let root = 0, max = 0;
    for (let i = 0; i < 12; i++) if (hist[i] > max) { max = hist[i]; root = i; }
    if (!max) return null;
    const minor = hist[(root + 3) % 12] >= hist[(root + 4) % 12];
    return { root: CHORD_NAMES[root], minor };
  }

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n<score-partwise version="3.1">\n';
  xml += '<part-list><score-part id="P1"><part-name>' + escXml(tr.name || 'Track') + '</part-name></score-part></part-list>\n<part id="P1">\n';
  let idx = 0, li = 0;
  const avgMidi = tr.notes.length ? tr.notes.reduce((s2, n) => s2 + n.midi, 0) / tr.notes.length : 60;
  let lastChordKey = '', lastDyn = '', curClef = avgMidi < 55 ? 'F' : 'G';
  const tieStartSet = new Set(), tieStopSet = new Set();
  {
    const _all = tr.notes.slice().sort((a, b) => a.start - b.start || a.midi - b.midi);
    for (let i = 1; i < _all.length; i++) {
      const _a = _all[i - 1], _b = _all[i];
      if (_a.midi === _b.midi && _a.end === _b.start) { tieStartSet.add(_a); tieStopSet.add(_b); }
    }
  }
  for (let b = 0; b < bars; b++) {
    const mStart = b * barLen;
    const notes = tr.notes.filter(n => n.start >= mStart && n.start < mStart + barLen).sort((a, b2) => a.start - b2.start);
    const hasHigh = notes.some(n => n.midi >= 79);
    const hasLow = notes.some(n => n.midi <= 40);
    xml += '<measure number="' + (b + 1) + '">\n';
    const mAvg = notes.length ? notes.reduce((s2, n) => s2 + n.midi, 0) / notes.length : (curClef === 'F' ? 40 : 70);
    const hasHighAny = notes.some(n => n.midi >= 77);
    const hasLowAny = notes.some(n => n.midi <= 40);
    let newClef = curClef;
    if (hasHighAny && curClef === 'F') newClef = 'G';
    else if (!hasHighAny && mAvg < 50) newClef = 'F';
    else if (hasLowAny && curClef === 'G' && mAvg < 55) newClef = 'F';
    if (b === 0) {
      const clefSign = curClef, clefLine = curClef === 'F' ? 4 : 2;
      const kf = inferKeyFifths(tr.notes);
      xml += '<attributes><divisions>' + tpb + '</divisions><key><fifths>' + kf.fifths + '</fifths><mode>' + kf.mode + '</mode></key><time><beats>' + sig.num + '</beats><beat-type>' + sig.den + '</beat-type></time><clef><sign>' + clefSign + '</sign><line>' + clefLine + '</line></clef></attributes>\n';
      const _bpm0 = bpmOfSong(song);
      xml += '<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>' + _bpm0 + '</per-minute></metronome></direction-type><sound tempo="' + _bpm0 + '"/></direction>\n';
    } else if (newClef !== curClef) {
      curClef = newClef;
      const clefLine = curClef === 'F' ? 4 : 2;
      xml += '<attributes><clef><sign>' + curClef + '</sign><line>' + clefLine + '</line></clef></attributes>\n';
    }
    const mark = marks.find(m => m.tick >= mStart && m.tick < mStart + Math.min(barLen, Math.max(1, tpb)));
    if (mark) xml += '<direction placement="above"><direction-type><rehearsal>' + escXml(mark.text) + '</rehearsal></direction-type></direction>\n';
    const ch = barChord(b);
    const chKey = ch ? ch.root + (ch.minor ? 'm' : '') : '';
    if (ch && chKey !== lastChordKey) {
      lastChordKey = chKey;
      xml += '<harmony placement="above"><root><root-step>' + ch.root[0] + '</root-step>' + (ch.root.length > 1 ? '<root-alter>1</root-alter>' : '') + '</root><kind>' + (ch.minor ? 'minor' : 'major') + '</kind></harmony>\n';
    }
    const avgVel = notes.length ? notes.reduce((s2, n) => s2 + (n.velocity || 80), 0) / notes.length : 0;
    if (avgVel) {
      const dyn = velocityDynTag(avgVel);
      if (dyn !== lastDyn) {
        lastDyn = dyn;
        xml += '<direction placement="below"><direction-type><dynamics><' + dyn + '/></dynamics></direction-type><sound dynamics="' + dyn + '"/></direction>\n';
      }
    }
    let cursor = mStart;
    for (let ni = 0; ni < notes.length; ni++) {
      const n = notes[ni];
      if (n.start > cursor) xml += '<note><rest/><duration>' + (n.start - cursor) + '</duration><voice>1</voice></note>\n';
      let writeMidi = n.midi;
      const lo = curClef === 'F' ? 43 : 64, hi = curClef === 'F' ? 57 : 76;
      while (writeMidi < lo) writeMidi += 12;
      while (writeMidi > hi) writeMidi -= 12;
      const prevN = ni > 0 ? notes[ni - 1] : null;
      const p = midiToPitch(writeMidi);
      let lyricXml = '';
      if (li < lyrics.length && Math.abs(lyrics[li].tick - n.start) < Math.max(tpb / 2, 10)) {
        lyricXml = '<lyric number="1"><syllabic>single</syllabic><text>' + escXml(lyrics[li].text) + '</text></lyric>';
        li++;
      }
      const tieStart = tieStartSet.has(n);
      const tieStop = tieStopSet.has(n);
      let tieXml = '';
      if (tieStart) tieXml += '<tie type="start"/>';
      if (tieStop) tieXml += '<tie type="stop"/>';
      let notationTie = '';
      {
        const arts = [];
        if ((n.end - n.start) < tpb / 4) arts.push('<staccato/>');
        if ((n.velocity || 80) >= 110) arts.push('<accent/>');
        if ((n.velocity || 80) <= 42) arts.push('<tenuto/>');
        let inner = '';
        if (tieStart) inner += '<tied type="start"/>';
        if (tieStop) inner += '<tied type="stop"/>';
        inner += arts.join('');
        if (inner) notationTie = '<notations>' + inner + '</notations>';
      }
      const midLine = curClef === 'F' ? 50 : 71;
      const stemDir = n.midi < midLine ? 'up' : (n.midi > midLine ? 'down' : (avgMidi > 64 ? 'down' : 'up'));
      const tInfo = musicXmlType(Math.max(1, n.end - n.start), tpb);
      xml += '<note xml:id="n' + (idx++) + '"><pitch><step>' + p.step + '</step>';
      if (p.alter !== 0) xml += '<alter>' + p.alter + '</alter>';
      xml += '<octave>' + p.octave + '</octave></pitch><duration>' + Math.max(1, n.end - n.start) + '</duration><voice>1</voice><stem>' + stemDir + '</stem><type>' + tInfo.type + '</type>' + (tInfo.dot ? '<dot/>' : '') + tieXml + lyricXml + notationTie + '</note>\n';
      cursor = Math.max(cursor, n.end);
    }
    if (b === bars - 1) xml += '<barline location="right"><bar-style>light-heavy</bar-style></barline>\n';
    xml += '</measure>\n';
  }
  xml += '</part></score-partwise>';
  return xml;
}

// 歌曲 → MusicXML（part-wise，每轨一个 part）
export function songToMusicXML(song) {
  const tpb = song.tpb || 480;
  const sig = song.sigMap[0] || { num: 4, den: 4 };
  const bars = song.bars || Math.ceil(song.totalTicks / (tpb * sig.num));
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n<score-partwise version="3.1">\n';
  xml += '<part-list>\n';
  song.tracks.forEach((tr, i) => { xml += '<score-part id="P' + (i + 1) + '"><part-name>' + escXml(tr.name) + '</part-name></score-part>\n'; });
  xml += '</part-list>\n';
  song.tracks.forEach((tr, ti) => {
    xml += '<part id="P' + (ti + 1) + '">\n';
    let curClef = (tr.notes.length ? tr.notes.reduce((s2, n) => s2 + n.midi, 0) / tr.notes.length : 60) < 55 ? 'F' : 'G';
    for (let b = 0; b < bars; b++) {
      const mStart = b * sig.num * tpb;
      const notes = tr.notes.filter(n => n.start >= mStart && n.start < mStart + sig.num * tpb).sort((a, b2) => a.start - b2.start);
      xml += '<measure number="' + (b + 1) + '">\n';
      const mAvg = notes.length ? notes.reduce((s2, n) => s2 + n.midi, 0) / notes.length : (curClef === 'F' ? 40 : 70);
      const hasHighAny = notes.some(n => n.midi >= 77);
      const hasLowAny = notes.some(n => n.midi <= 40);
      let newClef = curClef;
      if (hasHighAny && curClef === 'F') newClef = 'G';
      else if (!hasHighAny && mAvg < 50) newClef = 'F';
      else if (hasLowAny && curClef === 'G' && mAvg < 55) newClef = 'F';
      if (b === 0) {
        const clefSign = curClef, clefLine = curClef === 'F' ? 4 : 2;
        xml += '<attributes><divisions>' + tpb + '</divisions><key><fifths>0</fifths></key><time><beats>' + sig.num + '</beats><beat-type>' + sig.den + '</beat-type></time><clef><sign>' + clefSign + '</sign><line>' + clefLine + '</line></clef></attributes>\n';
      } else if (newClef !== curClef) {
        curClef = newClef;
        const clefLine = curClef === 'F' ? 4 : 2;
        xml += '<attributes><clef><sign>' + curClef + '</sign><line>' + clefLine + '</line></clef></attributes>\n';
      }
      let cursor = mStart;
      for (const n of notes) {
        if (n.start > cursor) xml += '<note><rest/><duration>' + (n.start - cursor) + '</duration><voice>1</voice></note>\n';
        const p = midiToPitch(n.midi);
        const tInfo = musicXmlType(Math.max(1, n.end - n.start), tpb);
        xml += '<note><pitch><step>' + p.step + '</step>';
        if (p.alter !== 0) xml += '<alter>' + p.alter + '</alter>';
        xml += '<octave>' + p.octave + '</octave></pitch><duration>' + Math.max(1, n.end - n.start) + '</duration><voice>1</voice><type>' + tInfo.type + '</type>' + (tInfo.dot ? '<dot/>' : '') + '</note>\n';
        cursor = Math.max(cursor, n.end);
      }
      xml += '</measure>\n';
    }
    xml += '</part>\n';
  });
  xml += '</score-partwise>';
  return xml;
}
