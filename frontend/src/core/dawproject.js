// ============================================================
// P2-5 DAW 互通（DAWproject 1.0）—— 纯逻辑：模型 ↔ XML
// ============================================================
// 规范：https://github.com/bitwig/dawproject（ZIP：project.xml + metadata.xml，UTF-8）
// 本轮只做「音符轨 + 速度/拍号 + 标记」这一个明确子集：
//   · Structure：每条 MIDI 轨 = Track(contentType=notes) + Channel(Volume/Pan/Mute)，另有 Master 轨；
//   · Arrangement：每轨一个 Lanes → Clips → Clip → Notes → Note（时间单位 beats）；
//   · Transport：初始 Tempo(bpm) 与 TimeSignature；更细的 tempo/拍号自动化暂不导出。
// 不做：音频事件、Warp、插件状态、自动化曲线、Clip Launcher。
//
// ★ 诚实声明：没有在 Studio One / Bitwig 里实机导入验证过；XML 结构按官方 XSD/示例逐项对齐，
//   并有自测（parse 往返 + 关键属性断言）。验收锚点里「Studio One/Bitwig 导入报告」需真机补。
'use strict';

export const DAWPROJECT_VERSION = '1.0';
export const DAWPROJECT_APP = 'FuFumidi';

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const MAX_TRACKS = 64;
const MAX_NOTES_PER_TRACK = 200000;

function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
function unesc(s) {
  return String(s == null ? '' : s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
function attr(obj) {
  return Object.keys(obj).filter((k) => obj[k] != null && obj[k] !== '')
    .map((k) => ' ' + k + '="' + esc(obj[k]) + '"').join('');
}

/** 规范化 DAWproject 模型：bpm 20..666、拍号 1..32 的 2 的幂、去掉空轨/非法音符。 */
export function normalizeDawprojectModel(raw = {}) {
  const bpm = clamp(num(raw.bpm, 120), 20, 666);
  const ts = raw.timeSignature || {};
  let numerator = Math.round(clamp(num(ts.numerator, 4), 1, 32));
  let denominator = Math.round(clamp(num(ts.denominator, 4), 1, 32));
  // 拍号分母规范成 2 的幂（XSD 不限制，但 DAW 一般只接受 1/2/4/8/16/32）
  denominator = Math.pow(2, Math.round(Math.log2(denominator)));
  const tracksIn = Array.isArray(raw.tracks) ? raw.tracks.slice(0, MAX_TRACKS) : [];
  const tracks = [];
  for (const t of tracksIn) {
    if (!t) continue;
    const notesIn = Array.isArray(t.notes) ? t.notes.slice(0, MAX_NOTES_PER_TRACK) : [];
    const notes = [];
    for (const n of notesIn) {
      const start = num(n && n.start, NaN);
      const dur = num(n && n.duration, NaN);
      const key = num(n && n.key, NaN);
      if (!Number.isFinite(start) || !Number.isFinite(dur) || !Number.isFinite(key)) continue;
      if (start < 0 || dur <= 0 || key < 0 || key > 127) continue;
      notes.push({
        start: Math.round(start * 1e6) / 1e6,
        duration: Math.round(dur * 1e6) / 1e6,
        key: Math.round(key),
        vel: Math.round(clamp(num(n.vel, 0.8), 0, 1) * 1e6) / 1e6,
        ch: Math.round(clamp(num(n.ch, 0), 0, 15)),
      });
    }
    if (!notes.length) continue;
    tracks.push({
      name: String(t.name || 'Track').slice(0, 120),
      color: COLOR_RE.test(String(t.color || '')) ? String(t.color) : '',
      notes,
    });
  }
  const markersIn = Array.isArray(raw.markers) ? raw.markers : [];
  const markers = markersIn
    .map((m) => ({ time: num(m && m.time, NaN), name: String((m && m.name) || 'Marker').slice(0, 200) }))
    .filter((m) => Number.isFinite(m.time) && m.time >= 0)
    .slice(0, 500);
  const durationBeats = Math.max(0, num(raw.durationBeats, 0)) ||
    Math.max(1, ...tracks.map((t) => Math.max(...t.notes.map((n) => n.start + n.duration))));
  return {
    title: String(raw.title || 'Untitled').slice(0, 200),
    artist: String(raw.artist || '').slice(0, 200),
    album: String(raw.album || '').slice(0, 200),
    bpm,
    timeSignature: { numerator: numerator, denominator: denominator },
    tracks,
    markers,
    durationBeats: Math.round(durationBeats * 1e6) / 1e6,
  };
}

/** Song 状态 → DAWproject 模型（beats 由 tick/tpb 直接换算，变速曲目也正确）。 */
export function songToDawprojectModel(song, opts = {}) {
  const s = song || {};
  const tpb = Math.max(1, Number(s.tpb) || 480);
  const totalTicks = Math.max(0, Number(s.totalTicks) || 0);
  const tracks = (Array.isArray(s.tracks) ? s.tracks : []).map((tr, i) => ({
    name: String(tr.name || ('Track ' + (i + 1))).slice(0, 120),
    color: COLOR_RE.test(String(opts.colors && opts.colors[i] || '')) ? opts.colors[i] : '',
    notes: (Array.isArray(tr.notes) ? tr.notes : []).map((n) => ({
      start: Number(n.start) / tpb,
      duration: Math.max(1, Number(n.end) - Number(n.start)) / tpb,
      key: n.midi,
      vel: Number(n.vel == null ? 80 : n.vel) / 127,
      ch: Number(n.ch) || 0,
    })),
  }));
  return normalizeDawprojectModel({
    title: opts.title || (s.name || s.title || 'Untitled'),
    artist: opts.artist || s.artist || '',
    album: opts.album || s.album || '',
    bpm: s.bpm || 120,
    timeSignature: s.timeSignature || { numerator: 4, denominator: 4 },
    tracks,
    markers: opts.markers || [],
    durationBeats: totalTicks / tpb,
  });
}

let _idSeq = 0;
function resetIds() { _idSeq = 0; }
function nid() { return 'id' + (_idSeq++); }
function paramXml(tag, value, unit, extra) {
  return '  <' + tag + attr({ ...extra, unit, value: String(value) }) + '/>';
}

/** 模型 → project.xml（与官方示例同构；所有文本已转义）。 */
export function buildProjectXml(model, opts = {}) {
  const m = normalizeDawprojectModel(model);
  resetIds();
  const appVersion = String(opts.appVersion || '6.0.0');
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  lines.push('<Project version="' + DAWPROJECT_VERSION + '">');
  lines.push('  <Application name="' + esc(DAWPROJECT_APP) + '" version="' + esc(appVersion) + '"/>');
  lines.push('  <Transport>');
  lines.push(paramXml('Tempo', m.bpm, 'bpm', { id: nid(), name: 'Tempo', min: '20.000000', max: '666.000000' }));
  lines.push('    <TimeSignature' + attr({
    id: nid(), numerator: m.timeSignature.numerator, denominator: m.timeSignature.denominator,
  }) + '/>');
  lines.push('  </Transport>');
  lines.push('  <Structure>');
  const masterId = nid();
  const masterChannelId = nid();
  const trackIds = m.tracks.map(() => nid());
  const channelIds = m.tracks.map(() => nid());
  for (let i = 0; i < m.tracks.length; i++) {
    const t = m.tracks[i];
    lines.push('    <Track' + attr({ contentType: 'notes', loaded: 'true', id: trackIds[i], name: t.name, color: t.color || null }) + '>');
    lines.push('      <Channel' + attr({ audioChannels: '2', destination: masterChannelId, role: 'regular', solo: 'false', id: channelIds[i] }) + '>');
    lines.push('        <Mute' + attr({ value: 'false', id: nid(), name: 'Mute' }) + '/>');
    lines.push(paramXml('Pan', '0.500000', 'normalized', { min: '0.000000', max: '1.000000', id: nid(), name: 'Pan' }));
    lines.push(paramXml('Volume', '1.000000', 'linear', { min: '0.000000', max: '2.000000', id: nid(), name: 'Volume' }));
    lines.push('      </Channel>');
    lines.push('    </Track>');
  }
  // Master：DAWproject 约定 role=master，其它 Channel 的 destination 指向它
  lines.push('    <Track' + attr({ contentType: 'audio notes', loaded: 'true', id: masterId, name: 'Master' }) + '>');
  lines.push('      <Channel' + attr({ audioChannels: '2', role: 'master', solo: 'false', id: masterChannelId }) + '>');
  lines.push('        <Mute' + attr({ value: 'false', id: nid(), name: 'Mute' }) + '/>');
  lines.push(paramXml('Pan', '0.500000', 'normalized', { min: '0.000000', max: '1.000000', id: nid(), name: 'Pan' }));
  lines.push(paramXml('Volume', '1.000000', 'linear', { min: '0.000000', max: '2.000000', id: nid(), name: 'Volume' }));
  lines.push('      </Channel>');
  lines.push('    </Track>');
  lines.push('  </Structure>');
  lines.push('  <Arrangement' + attr({ id: nid() }) + '>');
  lines.push('    <Lanes' + attr({ timeUnit: 'beats', id: nid() }) + '>');
  for (let i = 0; i < m.tracks.length; i++) {
    lines.push('      <Lanes' + attr({ track: trackIds[i], id: nid() }) + '>');
    lines.push('        <Clips' + attr({ id: nid() }) + '>');
    lines.push('          <Clip' + attr({ time: '0.0', duration: String(m.durationBeats), playStart: '0.0' }) + '>');
    lines.push('            <Notes' + attr({ id: nid() }) + '>');
    for (const n of m.tracks[i].notes) {
      lines.push('              <Note' + attr({
        time: n.start.toFixed(6), duration: n.duration.toFixed(6),
        channel: n.ch, key: n.key, vel: n.vel.toFixed(6), rel: n.vel.toFixed(6),
      }) + '/>');
    }
    lines.push('            </Notes>');
    lines.push('          </Clip>');
    lines.push('        </Clips>');
    lines.push('      </Lanes>');
  }
  lines.push('    </Lanes>');
  if (m.markers.length) {
    lines.push('    <Markers>');
    for (const mk of m.markers) {
      lines.push('      <Marker' + attr({ time: mk.time.toFixed(6), name: mk.name }) + '/>');
    }
    lines.push('    </Markers>');
  }
  lines.push('  </Arrangement>');
  lines.push('  <Scenes/>');
  lines.push('</Project>');
  return lines.join('\n') + '\n';
}

/** 模型 → metadata.xml（Title/Artist/Album 等，按官方 MetaData.xsd 顺序）。 */
export function buildMetadataXml(model) {
  const m = normalizeDawprojectModel(model);
  const rows = [
    ['Title', m.title], ['Artist', m.artist], ['Album', m.album],
    ['Composer', ''], ['Genre', ''], ['Comment', 'Exported by FuFumidi'],
  ];
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<MetaData>\n'
    + rows.filter(([, v]) => v != null && v !== '').map(([k, v]) => '  <' + k + '>' + esc(v) + '</' + k + '>').join('\n')
    + '\n</MetaData>\n';
}

/** 生成 .dawproject 包内文件列表（ZIP 由主进程写盘）。 */
export function makeDawprojectFiles(model, opts = {}) {
  return {
    files: [
      { name: 'project.xml', data: buildProjectXml(model, opts) },
      { name: 'metadata.xml', data: buildMetadataXml(model) },
    ],
    model: normalizeDawprojectModel(model),
  };
}

/** 解析 project.xml（只读回本模块能识别的子集；用于自测/导入预览）。 */
export function parseProjectXml(xml) {
  const text = String(xml || '');
  if (!/<Project\b/.test(text)) return { ok: false, error: '缺少 Project 根节点' };
  const version = (text.match(/<Project[^>]*\bversion="([^"]*)"/) || [])[1] || '';
  const app = text.match(/<Application\b([^>]*)\/?>/);
  const appAttrs = {};
  if (app) for (const m of app[1].matchAll(/(\w+)="([^"]*)"/g)) appAttrs[m[1]] = unesc(m[2]);
  const bpm = Number((text.match(/<Tempo\b[^>]*\bvalue="([^"]*)"/) || [])[1]) || 120;
  const ts = text.match(/<TimeSignature\b([^>]*)\/?>/);
  const tsAttrs = {};
  if (ts) for (const m of ts[1].matchAll(/(\w+)="([^"]*)"/g)) tsAttrs[m[1]] = Number(m[2]);
  // Structure 里的 Track 只有名字/颜色；音符在 Arrangement → Lanes(track=ID) → Clips → Notes
  const trackMeta = {};
  for (const tm of text.matchAll(/<Track\b([^>]*)>/g)) {
    const a = {};
    for (const m of tm[1].matchAll(/(\w+)="([^"]*)"/g)) a[m[1]] = unesc(m[2]);
    if (a.id) trackMeta[a.id] = { name: a.name || 'Track', color: a.color || '' };
  }
  const tracks = [];
  let anon = 0;
  // 只认 Arrangement 里带 track= 的 Lanes（外层的 <Lanes timeUnit="beats"> 没有 track 属性）
  for (const tm of text.matchAll(/<Lanes\b([^>]*\btrack="[^"]*"[^>]*)>[\s\S]*?<Notes[^>]*>([\s\S]*?)<\/Notes>/g)) {
    const la = {};
    for (const m of tm[1].matchAll(/(\w+)="([^"]*)"/g)) la[m[1]] = unesc(m[2]);
    const meta = trackMeta[la.track] || { name: 'Track ' + (++anon), color: '' };
    const notes = [];
    for (const nm of tm[2].matchAll(/<Note\b([^>]*)\/?>/g)) {
      const a = {};
      for (const m of nm[1].matchAll(/(\w+)="([^"]*)"/g)) a[m[1]] = unesc(m[2]);
      notes.push({
        start: Number(a.time), duration: Number(a.duration), key: Number(a.key),
        vel: Number(a.vel), ch: Number(a.channel) || 0,
      });
    }
    if (notes.length) tracks.push({ name: meta.name, color: meta.color, notes });
  }
  const markers = [];
  for (const mm of text.matchAll(/<Marker\b([^>]*)\/?>/g)) {
    const a = {};
    for (const m of mm[1].matchAll(/(\w+)="([^"]*)"/g)) a[m[1]] = unesc(m[2]);
    markers.push({ time: Number(a.time), name: a.name || 'Marker' });
  }
  return {
    ok: true,
    version,
    application: appAttrs,
    bpm,
    timeSignature: { numerator: tsAttrs.numerator || 4, denominator: tsAttrs.denominator || 4 },
    tracks: tracks.map((t) => ({ ...t, notes: t.notes.filter((n) => Number.isFinite(n.start) && Number.isFinite(n.duration) && Number.isFinite(n.key)) })),
    markers,
  };
}
