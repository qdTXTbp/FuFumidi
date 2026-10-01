// 音素派生层
// ------------------------------------------------------------
// 参考 OpenUTAU：音素不是用户直接输入的，而是 Phonemizer 从「歌词」派生的中间层，
// 用户可在此基础上再微调（OpenUTAU 用 preutterDelta / attackTimeDelta 等 delta 字段）。
//
// 本模块只做 **只读派生** 的 v1：
//   1) 中文/拼音：按声母表切出「声母 + 韵母」（零声母时整段为一个韵母）
//   2) 假名 / 拉丁 / 其它：整段作为一个音素
//   3) 多音节歌词（空格、连字符、撇号分隔）逐段拆
//
// 时间分配沿用与钢琴卷帘一致的朴素估计：辅音占 30%、元音占 70%；
// 无辅音时整段即元音。真实切分应由声库 oto / G2P 词典给出（后续增量接）。

/* 汉语拼音声母表：先匹配双字母（zh/ch/sh），再匹配单字母 */
const INITIALS_2 = ['zh', 'ch', 'sh'];
const INITIALS_1 = ['b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h',
  'j', 'q', 'x', 'r', 'z', 'c', 's', 'y', 'w'];

/** 去掉声调数字与常见分隔符，返回音节数组 */
export function splitSyllables(lyric) {
  const raw = String(lyric == null ? '' : lyric).trim();
  if (!raw) return [];
  // 用空格 / 连字符 / 撇号 / 中点 分隔多音节
  return raw
    .split(/[\s\-'’·]+/)
    .map(s => s.replace(/[0-9]/g, '').trim())   // 去声调数字
    .filter(Boolean);
}

/** 把单个音节拆成音素数组（声母在前，韵母在后） */
export function syllableToPhonemes(syllable) {
  // 自身做一次归一化：单独调用时也应能处理带声调数字 / 大小写混写的输入
  const s = String(syllable == null ? '' : syllable).toLowerCase().replace(/[0-9]/g, '').trim();
  if (!s) return [];
  // 含非拉丁字符（假名/汉字等）→ 不拆，整段一个音素
  if (!/^[a-zü]+$/.test(s)) return [syllable];

  for (const ini of INITIALS_2) {
    if (s.startsWith(ini) && s.length > ini.length) return [s.slice(0, ini.length), s.slice(ini.length)];
  }
  for (const ini of INITIALS_1) {
    if (s.startsWith(ini) && s.length > ini.length) return [s.slice(0, 1), s.slice(1)];
  }
  return [s];   // 零声母：整体作一个音素
}

/** 音符 → 音素序列（带音符内的相对时间，单位：拍，0..durBeat） */
export function notePhonemes(note) {
  const sylls = splitSyllables(note && note.lyric);
  const dur = Math.max(0.0625, Number(note && note.durBeat) || 1);
  if (!sylls.length) return [];
  const out = [];
  const per = dur / sylls.length;
  sylls.forEach((syl, i) => {
    const base = i * per;
    const ph = syllableToPhonemes(syl);
    if (ph.length === 2) {
      const c = per * 0.3;                       // 辅音占比
      out.push({ text: ph[0], t0: base, t1: base + c, cons: true, syl: i });
      out.push({ text: ph[1], t0: base + c, t1: base + per, cons: false, syl: i });
    } else {
      out.push({ text: ph[0], t0: base, t1: base + per, cons: false, syl: i });
    }
  });
  return out;
}

/** 整谱派生：返回 [{ noteId, startBeat, pitch, items:[{text,t0,t1,cons}] }] */
export function derivePhonemes(notes) {
  const out = [];
  for (const n of (notes || [])) {
    const items = notePhonemes(n);
    if (items.length) out.push({ noteId: n.id, startBeat: n.startBeat, pitch: n.pitch, items });
  }
  return out;
}
