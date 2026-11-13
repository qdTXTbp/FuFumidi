// ============================================================
// 批量导出 MusicXML：文件名规划 + 曲目字节加载（纯逻辑，可单测）
// ============================================================
// 为什么单独一层：乐谱页原本的 exportMusicXML() 只吃「当前这首」的 song 对象，
// 曲库里的其它曲目是懒解析的（item.song 要 selectSong 之后才有）。批量导出不能
// 靠循环 selectSong —— 那会切当前曲、停播放、写 localStorage，一首首把用户的
// 工作状态冲掉。这里按 app.ts:759-783 的四级回退**只读**地把字节捞出来解析。
import { parseMidi, buildSong } from './midi.js';
import { songToMusicXML, songToMusicXMLTrack } from './musicxml_out.js';

const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;
const MIDI_EXT = /\.(midi?|musicxml|xml|mxl)$/i;
const DB_NAME = 'fufumidi-db', STORE_SONGS = 'songs';

/** 曲名 → 可安全落盘的文件名主干（去扩展名、洗非法字符、去尾部点空格、限长） */
export function safeFileBase(name, fallback = 'score') {
  const s = String(name == null ? '' : name)
    .replace(MIDI_EXT, '')
    .replace(ILLEGAL, '_')
    .replace(/[.\s]+$/g, '')
    .trim()
    .slice(0, 120);
  return s || fallback;
}

/**
 * 大小写不敏感地去重（Windows 文件系统语义），重名加 " (2)"。
 * used 是 Set，由整批导出共享，避免两首同名曲 / 同名轨互相覆盖。
 */
export function uniqueName(used, desired) {
  const raw = String(desired || '').slice(0, 220);
  const dot = raw.lastIndexOf('.');
  const stem = dot > 0 ? raw.slice(0, dot) : raw;
  const ext = dot > 0 ? raw.slice(dot) : '';
  let fn = raw, n = 2;
  while (used.has(fn.toLowerCase())) { fn = stem + ' (' + n + ')' + ext; n++; }
  used.add(fn.toLowerCase());
  return fn;
}

/**
 * 一首曲目 → 待写盘的文件列表。
 * mode='score'：整份总谱一份；mode='parts'：每个有音符的非鼓轨一份分谱。
 * 一首歌一条可导出轨都没有时退回总谱，避免静默产出 0 个文件。
 * @returns {{file:string, xml:string}[]}
 */
export function jobsForSong(item, song, mode, used) {
  const base = safeFileBase((item && item.name) || (song && song.name));
  const full = () => [{ file: uniqueName(used, base + '.musicxml'), xml: songToMusicXML(song) }];
  if (mode !== 'parts') return full();
  const jobs = [];
  (song.tracks || []).forEach((tr, ti) => {
    if (!tr || !tr.notes || !tr.notes.length || tr.isDrum) return;
    const part = safeFileBase(tr.name || ('Part ' + (ti + 1)), 'Part');
    jobs.push({
      file: uniqueName(used, base + ' - ' + part + '.musicxml'),
      xml: songToMusicXMLTrack(song, ti),
    });
  });
  return jobs.length ? jobs : full();
}

/** 把各种来源的字节（Uint8Array / ArrayBuffer / 数字数组 / {bytes}）归一化 */
export function toBytes(b) {
  if (!b) return null;
  if (b instanceof Uint8Array) return b;
  if (typeof ArrayBuffer !== 'undefined' && b instanceof ArrayBuffer) return new Uint8Array(b);
  if (Array.isArray(b)) return Uint8Array.from(b);
  if (b && b.bytes) return toBytes(b.bytes);
  return null;
}

/** 字节 → song；失败返回 null（不抛，交给调用方逐首记失败） */
export function songFromBytes(bytes, name) {
  const b = toBytes(bytes);
  if (!b || !b.length) return null;
  try { return buildSong(parseMidi(b), { name: name || 'score' }); }
  catch (e) { return null; }
}

/** IndexedDB 里取曲目字节；环境不支持 / 出错都返回 null（还有 SQLite 与磁盘兜底） */
async function idbSongBytes(id) {
  if (typeof indexedDB === 'undefined') return null;
  try {
    const db = await new Promise((res) => {
      let req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { res(null); return; }
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE_SONGS)) d.createObjectStore(STORE_SONGS, { keyPath: 'id' });
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => res(null);
      req.onblocked = () => res(null);
    });
    if (!db) return null;
    const rec = await new Promise((res) => {
      try {
        const rq = db.transaction(STORE_SONGS, 'readonly').objectStore(STORE_SONGS).get(id);
        rq.onsuccess = () => res(rq.result || null);
        rq.onerror = () => res(null);
      } catch (e) { res(null); }
    });
    return rec ? rec.bytes : null;
  } catch (e) { return null; }
}

/**
 * 只读地拿到某首曲目的 song，不切当前曲、不动播放器。
 * 顺序与 app.ts selectSong 一致：内存 → IndexedDB → SQLite → 磁盘 .mid。
 * 成功后缓存到 item.song（和 selectSong 一样），下一批直接命中。
 */
export async function loadSongForExport(item, bridge) {
  if (!item) return null;
  if (item.song) return item.song;
  const name = item.name || 'score';
  let song = songFromBytes(item.__bytes, name);
  if (!song) song = songFromBytes(await idbSongBytes(item.id), name);
  if (!song && bridge && typeof bridge.dbSongsList === 'function') {
    try {
      const all = await bridge.dbSongsList();
      const rec = Array.isArray(all) ? all.find((x) => x && x.id === item.id) : null;
      song = songFromBytes(rec && rec.bytes, name);
    } catch (e) { song = null; }
  }
  if (!song && item.meta && item.meta.path && bridge && typeof bridge.readBinary === 'function') {
    try { song = songFromBytes(await bridge.readBinary(item.meta.path), name); }
    catch (e) { song = null; }
  }
  if (song) item.song = song;
  return song;
}
