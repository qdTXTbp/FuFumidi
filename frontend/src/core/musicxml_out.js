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

/** 导出 MusicXML 前把起止量化到 1/16 拍网格：演奏 MIDI 的微小时值不适合直接当记谱时值。
 * 只影响导出的 MusicXML，不改应用内的音符/播放。 */
function quantizeForNotation(song) {
  const tpb = song.tpb || 480;
  const grid = Math.max(1, Math.round(tpb / 16));
  const tracks = (song.tracks || []).map((tr) => ({
    ...tr,
    notes: (tr.notes || []).map((n) => {
      const start = Math.max(0, Math.round((n.start || 0) / grid) * grid);
      const end = Math.max(start + grid, Math.round((n.end || start) / grid) * grid);
      return { ...n, start, end };
    }),
  }));
  return { ...song, tracks };
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

/** 按小节线把**一个**音符切成片段（F-07）。
 *
 *  跨小节的长音不能只写成一个 <note>：MusicXML 的 <duration> 超过本小节长度时，
 *  Verovio 会把这一小节撑破或把音符丢掉，谱面上只剩起始小节。正确写法是每小节一个
 *  分片、相邻分片之间用 <tie>/<tied> 连接（见两条生成路径里的 tieXml / notationXml）。
 *
 *  返回的每个片段带 bar（从 0 开始）、start/end、tieStart/tieStop：
 *  - tieStart = 后面还有分片 → 本片段末尾起连音线
 *  - tieStop  = 前面已有分片 → 本片段开头收连音线
 *  恰好落在小节线上的音符只属于前一小节（end 用 end-1 判最后一小节）。
 */
export function splitNoteAtBarlines(note, barLen) {
  const len = Math.max(1, Math.round(Number(barLen) || 0));
  const start = Math.max(0, Math.round(Number(note && note.start) || 0));
  const endRaw = Number(note && note.end);
  const end = Math.max(start + 1, Math.round(Number.isFinite(endRaw) ? endRaw : start + 1));
  const firstBar = Math.floor(start / len);
  const lastBar = Math.floor((end - 1) / len);
  const pieces = [];
  for (let b = firstBar; b <= lastBar; b++) {
    const s = Math.max(start, b * len);
    const e = Math.min(end, (b + 1) * len);
    if (e > s) pieces.push({ bar: b, start: s, end: e, tieStart: false, tieStop: false });
  }
  if (!pieces.length) pieces.push({ bar: firstBar, start, end, tieStart: false, tieStop: false });
  for (let i = 0; i < pieces.length; i++) {
    pieces[i].index = i;
    pieces[i].count = pieces.length;
    pieces[i].tieStop = i > 0;
    pieces[i].tieStart = i < pieces.length - 1;
  }
  return pieces;
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

/** 速度记号的 MusicXML 片段：x/8（3/8、6/8、9/8、12/8）按**附点四分**记（谱面惯例），
 *  其它拍号按四分音符。★ per-minute 必须与 beat-unit 成对换算：附点四分 = 60 ⇔ 四分音符 90
 *  —— MIDI 的 set_tempo 永远是四分音符，所以这里换算的是**记号写法**，不是速度本身。
 *  这样重新渲出来的谱面记号与原始谱面一致（用户 2026-10-18：转谱的速度记号不对）。 */
export function metronomeXml(sig, bpmQuarter) {
  const num = (sig && sig.num) || 4, den = (sig && sig.den) || 4;
  const compound = den === 8 && (num === 3 || num === 6 || num === 9 || num === 12);
  const bpm = Math.max(1, Math.round(bpmQuarter || 120));
  const per = compound ? Math.max(1, Math.round(bpm / 1.5)) : bpm;
  return '<metronome><beat-unit>quarter</beat-unit>' + (compound ? '<beat-unit-dot/>' : '')
    + '<per-minute>' + per + '</per-minute></metronome>';
}

// 单轨 MusicXML（供 Verovio 渲染当前乐谱轨道）
export function songToMusicXMLTrack(song, ti) {
  song = quantizeForNotation(song);
  const tr = song.tracks[ti];
  const tpb = song.tpb || 480;
  const sig = song.sigMap[0] || { num: 4, den: 4 };
  const barLen = Math.max(1, Math.round(sig.num * tpb * 4 / sig.den));
  // 小节数至少要覆盖最后一个音的结尾，否则跨到末尾之外的分片不会被写出，
  // 连音线会以「只有 start 没有 stop」悬空（数据里 song.bars 偏小时尤其明显）。
  const maxNoteEnd = (tr.notes || []).reduce((m, n) => Math.max(m, n.end || 0), 0);
  const bars = Math.max(1, song.bars || 0, Math.ceil((song.totalTicks || 0) / barLen), Math.ceil(maxNoteEnd / barLen));

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
  // 同音高、首尾相接的音符继续用连音线连起来（原有逻辑，F-07 不改）。
  const tieStartSet = new Set(), tieStopSet = new Set();
  {
    const _all = tr.notes.slice().sort((a, b) => a.start - b.start || a.midi - b.midi);
    for (let i = 1; i < _all.length; i++) {
      const _a = _all[i - 1], _b = _all[i];
      if (_a.midi === _b.midi && _a.end === _b.start) { tieStartSet.add(_a); tieStopSet.add(_b); }
    }
  }
  // ★ F-07：跨小节的长音先按小节线切成片段，分片之间用 tieStart/tieStop 连接。
  // 旧写法把整段时值塞进起始小节的 <duration>，超过小节长度，谱面上只剩起始小节。
  const segments = [];
  for (const n of tr.notes) {
    const pieces = splitNoteAtBarlines(n, barLen);
    for (let pi = 0; pi < pieces.length; pi++) {
      const piece = pieces[pi];
      piece.note = n;
      piece.first = pi === 0;
      piece.last = pi === pieces.length - 1;
      if (piece.first) piece.tieStop = tieStopSet.has(n);    // 与前一个同音高音符相连
      if (piece.last) piece.tieStart = tieStartSet.has(n);   // 与后一个同音高音符相连
      segments.push(piece);
    }
  }
  segments.sort((a, b) => a.start - b.start || a.note.midi - b.note.midi);
  for (let b = 0; b < bars; b++) {
    const mStart = b * barLen;
    const notes = segments.filter(s => s.bar === b);
    xml += '<measure number="' + (b + 1) + '">\n';
    const mAvg = notes.length ? notes.reduce((s2, s) => s2 + s.note.midi, 0) / notes.length : (curClef === 'F' ? 40 : 70);
    const hasHighAny = notes.some(s => s.note.midi >= 77);
    const hasLowAny = notes.some(s => s.note.midi <= 40);
    let newClef = curClef;
    if (hasHighAny && curClef === 'F') newClef = 'G';
    else if (!hasHighAny && mAvg < 50) newClef = 'F';
    else if (hasLowAny && curClef === 'G' && mAvg < 55) newClef = 'F';
    if (b === 0) {
      const clefSign = curClef, clefLine = curClef === 'F' ? 4 : 2;
      const kf = inferKeyFifths(tr.notes);
      xml += '<attributes><divisions>' + tpb + '</divisions><key><fifths>' + kf.fifths + '</fifths><mode>' + kf.mode + '</mode></key><time><beats>' + sig.num + '</beats><beat-type>' + sig.den + '</beat-type></time><clef><sign>' + clefSign + '</sign><line>' + clefLine + '</line></clef></attributes>\n';
      const _bpm0 = bpmOfSong(song);
      xml += '<direction placement="above"><direction-type>' + metronomeXml(sig, _bpm0) + '</direction-type><sound tempo="' + _bpm0 + '"/></direction>\n';
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
    const avgVel = notes.length ? notes.reduce((s2, s) => s2 + (s.note.velocity || 80), 0) / notes.length : 0;
    if (avgVel) {
      const dyn = velocityDynTag(avgVel);
      if (dyn !== lastDyn) {
        lastDyn = dyn;
        xml += '<direction placement="below"><direction-type><dynamics><' + dyn + '/></dynamics></direction-type><sound dynamics="' + dyn + '"/></direction>\n';
      }
    }
    let cursor = mStart;
    for (let ni = 0; ni < notes.length; ni++) {
      const seg = notes[ni];
      const n = seg.note;
      if (seg.start > cursor) xml += '<note><rest/><duration>' + (seg.start - cursor) + '</duration><voice>1</voice></note>\n';
      let writeMidi = n.midi;
      const lo = curClef === 'F' ? 43 : 64, hi = curClef === 'F' ? 57 : 76;
      while (writeMidi < lo) writeMidi += 12;
      while (writeMidi > hi) writeMidi -= 12;
      const p = midiToPitch(writeMidi);
      // 歌词、奏法只写在跨小节长音的**第一片**上；后面几片只是时值延续。
      let lyricXml = '';
      if (seg.first && li < lyrics.length && Math.abs(lyrics[li].tick - n.start) < Math.max(tpb / 2, 10)) {
        lyricXml = '<lyric number="1"><syllabic>single</syllabic><text>' + escXml(lyrics[li].text) + '</text></lyric>';
        li++;
      }
      const tieStart = !!seg.tieStart;
      const tieStop = !!seg.tieStop;
      // MusicXML 惯例：中间分片先收前一条连音线（stop），再起下一条（start）。
      // 顺序反了 Verovio 会把同一音符上的 start/stop 配成一对，报 startid == endid。
      let tieXml = '';
      if (tieStop) tieXml += '<tie type="stop"/>';
      if (tieStart) tieXml += '<tie type="start"/>';
      let notationXml = '';
      {
        const arts = [];
        if (seg.first) {
          if ((n.end - n.start) < tpb / 4) arts.push('<staccato/>');
          if ((n.velocity || 80) >= 110) arts.push('<accent/>');
          if ((n.velocity || 80) <= 42) arts.push('<tenuto/>');
        }
        let inner = '';
        if (tieStop) inner += '<tied type="stop"/>';
        if (tieStart) inner += '<tied type="start"/>';
        inner += arts.join('');
        if (inner) notationXml = '<notations>' + inner + '</notations>';
      }
      const midLine = curClef === 'F' ? 50 : 71;
      const stemDir = n.midi < midLine ? 'up' : (n.midi > midLine ? 'down' : (avgMidi > 64 ? 'down' : 'up'));
      const segDur = Math.max(1, seg.end - seg.start);
      const tInfo = musicXmlType(segDur, tpb);
      xml += '<note xml:id="n' + (idx++) + '"><pitch><step>' + p.step + '</step>';
      if (p.alter !== 0) xml += '<alter>' + p.alter + '</alter>';
      xml += '<octave>' + p.octave + '</octave></pitch><duration>' + segDur + '</duration>' + tieXml
        + '<voice>1</voice><type>' + tInfo.type + '</type>' + (tInfo.dot ? '<dot/>' : '')
        + '<stem>' + stemDir + '</stem>' + notationXml + lyricXml + '</note>\n';
      cursor = Math.max(cursor, seg.end);
    }
    if (b === bars - 1) xml += '<barline location="right"><bar-style>light-heavy</bar-style></barline>\n';
    xml += '</measure>\n';
  }
  xml += '</part></score-partwise>';
  return xml;
}

/* ============================================================
 * 总谱（conductor's score）：所有声部同时刻在一张谱上
 *
 * 与单轨版（songToMusicXMLTrack）的区别 —— 这几条都是「能不能当总谱看」的关键：
 *   1. 小节长度按**拍号分母**算：barLen = num × tpb × 4 / den。
 *      旧版写死 num × tpb，6/8 的小节会被当成 6 个四分音符（长了一倍），
 *      于是所有声部的音符都错位、每小节末尾多出一大截空白。
 *   2. 空小节补**整小节休止**：总谱里大量乐器整段不演奏，
 *      空 <measure/> 在 MusicXML 里是非法的，Verovio 会直接丢掉那一小节。
 *   3. **和弦**：同一时刻起音的音符用 <chord/>，否则会被当成先后演奏（钢琴和弦全散架）。
 *   4. **多声部**：同一小节里时间上重叠的音符拆成 voice 1/2/…，用 <backup> 回到小节头。
 *   5. **谱表括号**：<part-group><group-symbol>bracket —— 总谱左侧那条竖括号。
 *   6. 调号对**整首曲子**推断一次（总谱只有一个调号），不再是每轨各推各的。
 *   7. 每个音符带 xml:id，界面据此建立「SVG 元素 ↔ 音符」映射（多声部时按顺序数会对不上）。
 *   8. **跨小节时值**：长音按小节线切片，片间用 <tie>/<tied> 连接（F-07）。
 * ============================================================ */
export function buildFullScore(song, opts) {
  song = quantizeForNotation(song);
  const o = opts || {};
  const tpb = song.tpb || 480;
  const sig = (song.sigMap && song.sigMap[0]) || { num: 4, den: 4 };
  const barLen = Math.max(1, Math.round(sig.num * tpb * 4 / sig.den));
  const maxNoteEnd = (song.tracks || []).reduce((mx, tr) => (tr.notes || []).reduce((m, n) => Math.max(m, n.end || 0), mx), 0);
  // 同单轨：小节数必须覆盖所有音的结尾，跨小节分片才有地方落，连音线不会悬空。
  const bars = Math.max(1, song.bars || 0, Math.ceil((song.totalTicks || 0) / barLen), Math.ceil(maxNoteEnd / barLen));
  const parts = (song.tracks || [])
    .map((tr, i) => ({ tr, i }))
    .filter((x) => x.tr && x.tr.notes && x.tr.notes.length && !x.tr.isDrum);
  const allNotes = parts.reduce((acc, p) => acc.concat(p.tr.notes), []);
  const kf = o.keyFifths != null ? { fifths: o.keyFifths } : inferKeyFifths(allNotes);
  const fifths = clampInt(kf.fifths != null ? kf.fifths : 0, -7, 7);
  const bpm = bpmOfSong(song);
  const noteMap = new Map();          // xml:id → { track, tick, midi, dur, noteStart, noteEnd, name }（跨小节时每片一条）

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n<score-partwise version="3.1">\n';
  xml += '<part-list>\n';
  if (parts.length > 1) {
    xml += '<part-group type="start" number="1"><group-symbol>bracket</group-symbol><group-barline>yes</group-barline></part-group>\n';
  }
  parts.forEach((p, i) => {
    xml += '<score-part id="P' + (i + 1) + '"><part-name>' + escXml(p.tr.name || ('Part ' + (i + 1))) + '</part-name>';
    if (!o.noMidi) xml += '<midi-instrument id="P' + (i + 1) + '-I1"><midi-channel>' + ((i % 16) + 1) + '</midi-channel><midi-program>' + (p.tr.program != null ? p.tr.program + 1 : 1) + '</midi-program></midi-instrument>';
    xml += '</score-part>\n';
  });
  if (parts.length > 1) xml += '<part-group type="stop" number="1"/>\n';
  xml += '</part-list>\n';

  let idSeq = 0;
  parts.forEach((p, pi) => {
    const tr = p.tr;
    const notes = tr.notes.slice().sort((a, b) => a.start - b.start || a.midi - b.midi);
    let curClef = (notes.reduce((s2, n) => s2 + n.midi, 0) / notes.length) < 55 ? 'F' : 'G';
    // ★ F-07：先给整条轨的音符分配声部，再按小节线切片。片段继承原音符的声部，
    // 跨小节的长音在下一小节不会突然换声部，连音线也接得上。
    const segmentsByBar = new Map();
    for (const g of voiceGroupsOf(notes).groups) {
      for (const n of g.notes) {
        const pieces = splitNoteAtBarlines(n, barLen);
        for (let k = 0; k < pieces.length; k++) {
          const piece = pieces[k];
          const seg = {
            bar: piece.bar, start: piece.start, end: piece.end,
            note: n, voice: g.voice,
            first: k === 0, last: k === pieces.length - 1,
            tieStart: piece.tieStart, tieStop: piece.tieStop,
          };
          if (!segmentsByBar.has(seg.bar)) segmentsByBar.set(seg.bar, []);
          segmentsByBar.get(seg.bar).push(seg);
        }
      }
    }
    xml += '<part id="P' + (pi + 1) + '">\n';
    for (let b = 0; b < bars; b++) {
      const mStart = b * barLen;
      const inBar = segmentsByBar.get(b) || [];
      xml += '<measure number="' + (b + 1) + '">\n';
      const mAvg = inBar.length ? inBar.reduce((s2, s) => s2 + s.note.midi, 0) / inBar.length : (curClef === 'F' ? 40 : 70);
      const hasHigh = inBar.some((s) => s.note.midi >= 77);
      const hasLow = inBar.some((s) => s.note.midi <= 40);
      let newClef = curClef;
      if (hasHigh && curClef === 'F') newClef = 'G';
      else if (!hasHigh && mAvg < 50) newClef = 'F';
      else if (hasLow && curClef === 'G' && mAvg < 55) newClef = 'F';
      if (b === 0) {
        const cl = curClef === 'F' ? 4 : 2;
        xml += '<attributes><divisions>' + tpb + '</divisions><key><fifths>' + fifths + '</fifths></key>'
          + '<time><beats>' + sig.num + '</beats><beat-type>' + sig.den + '</beat-type></time>'
          + '<clef><sign>' + curClef + '</sign><line>' + cl + '</line></clef></attributes>\n';
        if (pi === 0) {
          xml += '<direction placement="above"><direction-type>' + metronomeXml(sig, bpm)
            + '</direction-type><sound tempo="' + bpm + '"/></direction>\n';
        }
      } else if (newClef !== curClef) {
        curClef = newClef;
        xml += '<attributes><clef><sign>' + curClef + '</sign><line>' + (curClef === 'F' ? 4 : 2) + '</line></clef></attributes>\n';
      }
      if (!inBar.length) {
        // 整小节休止：总谱里绝大多数小节都是这种
        xml += '<note><rest measure="yes"/><duration>' + barLen + '</duration><voice>1</voice></note>\n';
        xml += '</measure>\n';
        continue;
      }
      const byVoice = new Map();
      for (const seg of inBar) {
        if (!byVoice.has(seg.voice)) byVoice.set(seg.voice, []);
        byVoice.get(seg.voice).push(seg);
      }
      const voiceIds = Array.from(byVoice.keys()).sort((a, b) => a - b);
      voiceIds.forEach((vid, vi) => {
        if (vi > 0) xml += '<backup><duration>' + barLen + '</duration></backup>\n';
        const list = byVoice.get(vid).sort((a, b) => a.start - b.start || a.note.midi - b.note.midi);
        let cursor = 0;
        let lastStart = -1;
        for (const seg of list) {
          const rel = Math.max(0, seg.start - mStart);
          const dur = Math.max(1, Math.min(barLen - rel, seg.end - seg.start));
          if (rel > cursor) {
            xml += '<note><rest/><duration>' + (rel - cursor) + '</duration><voice>' + (vi + 1) + '</voice></note>\n';
            cursor = rel;
          }
          const isChord = rel === lastStart;
          const p2 = midiToPitch(seg.note.midi);
          const tInfo = musicXmlType(dur, tpb);
          const nid = 'n' + (idSeq++);
          noteMap.set(nid, {
            track: p.i, tick: seg.start, midi: seg.note.midi, dur: seg.end - seg.start,
            noteStart: seg.note.start, noteEnd: seg.note.end, name: tr.name || '',
          });
          // 中间分片：先 stop 再 start（与单轨路径一致，否则 Verovio 会配错连音线）。
          let tieXml = '';
          if (seg.tieStop) tieXml += '<tie type="stop"/>';
          if (seg.tieStart) tieXml += '<tie type="start"/>';
          let notationXml = '';
          {
            let inner = '';
            if (seg.tieStop) inner += '<tied type="stop"/>';
            if (seg.tieStart) inner += '<tied type="start"/>';
            if (inner) notationXml = '<notations>' + inner + '</notations>';
          }
          xml += '<note xml:id="' + nid + '">' + (isChord ? '<chord/>' : '') + '<pitch><step>' + p2.step + '</step>';
          if (p2.alter !== 0) xml += '<alter>' + p2.alter + '</alter>';
          xml += '<octave>' + p2.octave + '</octave></pitch><duration>' + dur + '</duration>' + tieXml
            + '<voice>' + (vi + 1) + '</voice><type>' + tInfo.type + '</type>' + (tInfo.dot ? '<dot/>' : '')
            + notationXml + '</note>\n';
          // 和弦里的每个音都要参与游标推进：同组的音可能时值不同（尤其跨小节的长音），
          // 只看第一个音会把后面的休止补到长音还没结束的位置，小节总长就超了。
          cursor = Math.max(cursor, rel + dur);
          lastStart = rel;
        }
        if (cursor < barLen) {
          xml += '<note><rest/><duration>' + (barLen - cursor) + '</duration><voice>' + (vi + 1) + '</voice></note>\n';
        }
      });
      if (b === bars - 1) xml += '<barline location="right"><bar-style>light-heavy</bar-style></barline>\n';
      xml += '</measure>\n';
    }
    xml += '</part>\n';
  });
  xml += '</score-partwise>';
  return { xml, bars, barLen, partCount: parts.length, noteMap, fifths, bpm };
}

/** 把音符按「同刻起音」分组，再贪心分到互不重叠的声部；返回组与声部。
 *  整条轨只分配一次：buildFullScore 要把跨小节的片段留在同一声部里，
 *  所以不能像旧版那样每小节各自分一次声部。 */
function voiceGroupsOf(notes) {
  const groups = [];
  for (const n of notes) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g.start - n.start) <= 2) g.notes.push(n);
    else groups.push({ start: n.start, notes: [n] });
  }
  const voices = [];
  for (const g of groups) {
    let target = null, voiceIndex = -1;
    for (let i = 0; i < voices.length; i++) {
      const v = voices[i];
      if (g.start >= v.end - 2) { target = v; voiceIndex = i; break; }
    }
    if (!target) { target = { notes: [], end: -1 }; voices.push(target); voiceIndex = voices.length - 1; }
    g.voice = voiceIndex;
    for (const n of g.notes) target.notes.push(n);
    for (const n of g.notes) target.end = Math.max(target.end, n.end);
  }
  return { groups, voices };
}

/** 把一小节的音符按「时间上能不能接在同一条声部里」切成若干声部。
 *  同一时刻起音的音符算一个**和弦组**，整组进同一条声部（否则和弦会被拆成两声部）。 */
export function splitVoices(notes, barLen) {
  return voiceGroupsOf(notes).voices.slice(0, 4);
}

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v) || 0);
  return n < lo ? lo : (n > hi ? hi : n);
}

/** 歌曲 → MusicXML（part-wise，每轨一个 part）—— 总谱导出与总谱预览都用它。 */
export function songToMusicXML(song, opts) {
  return buildFullScore(song, opts).xml;
}
