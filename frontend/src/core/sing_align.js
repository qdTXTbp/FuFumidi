// ============================================================
// 歌词 ↔ 音符 的对齐算法（纯函数，可用 node 直接跑，见文件尾自检）
// ============================================================
//
// 为什么单独抽出来：
//   1) 实测「烦恼歌」时，歌词 441 个音节、单音化后旋律只有 275 个音符 ——
//      顺序填只能唱到第 166 个字，后面 275 个字全丢，副歌整段没词；
//   2) 这首 MIDI 的旋律有长前奏（79 秒空档），顺序填还会把开头几个字
//      摊到前奏上，整首歌往后错位；
//   3) 对齐规则是纯数据变换，放在 core 里比塞进 Vue 组件更好验证。
//
// 三种模式：
//   seq       —— 老行为：按顺序一个一个填（可循环 / 截断 / 沿用最后一个）
//   spread    —— 整首按比例铺开：第 1 个字落在第 1 个音符、最后一个字落在最后一个音符，
//                中间按比例取字（字多时跳过一些字，字少时重复一些字），首尾永远对得上
//   phrases   —— 按乐句对齐：先用休止把旋律切成乐句，再把音节流按音符数比例切成同样段数，
//                段内再按比例铺 —— 尊重"一句一句唱"的听感

/** 把歌词按行拆开（去掉空行；行内多余空白压成单空格） */
export function splitLyricLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * 按休止把音符切成乐句。
 * @param notes 已按 startBeat 排序的音符（需要 startBeat / durBeat）
 * @param gapBeats 两个音符之间的空档超过这个拍数就算换句（默认 1 拍）
 */
export function segmentPhrases(notes, gapBeats = 1) {
  const list = (notes || []).filter(Boolean);
  const phrases = [];
  let cur = [];
  let prevEnd = null;
  for (const n of list) {
    const start = Number(n.startBeat) || 0;
    const dur = Math.max(0, Number(n.durBeat) || 0);
    if (prevEnd != null && start - prevEnd > gapBeats) {
      if (cur.length) phrases.push(cur);
      cur = [];
    }
    cur.push(n);
    prevEnd = Math.max(prevEnd == null ? 0 : prevEnd, start + dur);
  }
  if (cur.length) phrases.push(cur);
  return phrases;
}

/**
 * 把 `syllables` 按 `weights`（每段的容量）切成等量的段。
 * 每段分到的字数与权重成正比，且**总和不变**（多退少补，保证不丢字）。
 */
export function splitByWeights(syllables, weights) {
  const total = weights.reduce((a, b) => a + Math.max(0, b), 0) || 1;
  const out = [];
  let taken = 0;
  for (let i = 0; i < weights.length; i++) {
    const isLast = i === weights.length - 1;
    let take;
    if (isLast) {
      take = syllables.length - taken;
    } else {
      const cum = weights.slice(0, i + 1).reduce((a, b) => a + Math.max(0, b), 0);
      take = Math.round((syllables.length * cum) / total) - taken;
    }
    take = Math.max(0, Math.min(take, syllables.length - taken));
    out.push(syllables.slice(taken, taken + take));
    taken += take;
  }
  return out;
}

/**
 * 把一段音节按比例铺到一段音符上（长度不等时跳过/重复，首尾对齐）。
 * 返回与 notes 等长的数组（元素是歌词，可能是空串）。
 */
export function spreadSyllables(syllables, notes) {
  const n = notes.length;
  const s = syllables.length;
  if (!n) return [];
  if (!s) return new Array(n).fill('');
  if (n === 1) return [syllables[0]];
  const out = [];
  for (let k = 0; k < n; k++) {
    const idx = s === 1 ? 0 : Math.round((k * (s - 1)) / (n - 1));
    out.push(syllables[Math.max(0, Math.min(s - 1, idx))]);
  }
  return out;
}

/**
 * 主入口：给音符序列和音节序列，返回等长的歌词数组。
 * @param notes     按时间排序的音符
 * @param syllables 音节（已分词）
 * @param mode      'spread' | 'phrases'
 * @param gapBeats  乐句切分的休止阈值（仅 phrases 模式用）
 */
export function alignLyrics(notes, syllables, mode = 'spread', gapBeats = 1) {
  const list = (notes || []).filter(Boolean);
  const syl = (syllables || []).filter((x) => x !== undefined && x !== null && String(x).length);
  if (!list.length) return { lyrics: [], phrases: 0, skipped: 0, repeated: 0 };
  if (mode === 'phrases') {
    const phrases = segmentPhrases(list, gapBeats);
    const segs = splitByWeights(syl, phrases.map((p) => p.length));
    const out = [];
    phrases.forEach((p, i) => { out.push(...spreadSyllables(segs[i], p)); });
    return finish(out, syl, phrases.length);
  }
  const out = spreadSyllables(syl, list);
  return finish(out, syl, 0);
}

function finish(lyrics, syllables, phrases) {
  /* ★ 统计口径要能读懂：
     - skipped   = 因为「字数 > 音符数」而被跳过的字数（471 字 / 275 音符 → 166）
     - repeated  = 音符数多于字数时，被重复使用的字数
     早先按"字形去重"算，同一首歌里 30 个常见字重复出现就被报成"跳过 30 个字"，不准。 */
  const capacity = Math.min(lyrics.length, syllables.length);
  const skipped = Math.max(0, syllables.length - capacity);
  const repeated = Math.max(0, lyrics.length - capacity);
  return { lyrics, phrases, skipped, repeated };
}

// ---------------------------------------------------------------- 自检
// node --input-type=module -e "import('./frontend/src/core/sing_align.js').then(m=>m.selfCheck())"
export function selfCheck() {
  const notes = [];
  for (let i = 0; i < 4; i++) notes.push({ startBeat: i, durBeat: 1 });
  for (let i = 0; i < 6; i++) notes.push({ startBeat: 10 + i, durBeat: 1 });
  const r1 = alignLyrics(notes, ['a', 'b', 'c'], 'spread', 1);
  const r2 = alignLyrics(notes, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'], 'spread', 1);
  const r3 = alignLyrics(notes, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'], 'phrases', 2);
  const ph = segmentPhrases(notes, 2);
  const ok =
    r1.lyrics.length === 10 && r1.lyrics[0] === 'a' && r1.lyrics[9] === 'c' &&
    r2.lyrics[0] === 'a' && r2.lyrics[9] === 'j' &&
    ph.length === 2 &&
    r3.lyrics[3] === 'd' && r3.lyrics[4] === 'e' && r3.lyrics[9] === 'j';
  return { ok, phrases: ph.length, first: r1.lyrics, spread: r2.lyrics, byPhrase: r3.lyrics };
}
