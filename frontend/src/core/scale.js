// 调式音阶（P0-1 调内编辑）：调内音计算、判定与吸附。
// 纯函数、不依赖组件，便于单测；EditorCanvas 用 scaleMode 决定「高亮 / 约束」。
// ScaleSpec 形状：{ root: 0-11（0=C）, type: SCALE_TYPES 的 id, custom: [相对主音的半音偏移] }

// 音阶表：[id, 名称（i18n 源串）, 相对主音的半音集合]
export const SCALE_TYPES = [
  ['major', '大调', [0, 2, 4, 5, 7, 9, 11]],
  ['minor', '自然小调', [0, 2, 3, 5, 7, 8, 10]],
  ['harmonicMinor', '和声小调', [0, 2, 3, 5, 7, 8, 11]],
  ['melodicMinor', '旋律小调', [0, 2, 3, 5, 7, 9, 11]],
  ['dorian', '多利亚', [0, 2, 3, 5, 7, 9, 10]],
  ['phrygian', '弗里吉亚', [0, 1, 3, 5, 7, 8, 10]],
  ['lydian', '利底亚', [0, 2, 4, 6, 7, 9, 11]],
  ['mixolydian', '混合利底亚', [0, 2, 4, 5, 7, 9, 10]],
  ['locrian', '洛克里亚', [0, 1, 3, 5, 6, 8, 10]],
  ['pentatonicMajor', '大调五声', [0, 2, 4, 7, 9]],
  ['pentatonicMinor', '小调五声', [0, 3, 5, 7, 10]],
  ['blues', '布鲁斯', [0, 3, 5, 6, 7, 10]],
  ['wholeTone', '全音音阶', [0, 2, 4, 6, 8, 10]],
  ['custom', '自定义', []],
];

export function scaleTypeName(id) {
  const hit = SCALE_TYPES.find(s => s[0] === id);
  return hit ? hit[1] : id;
}
export function scaleTypeDegrees(id) {
  const hit = SCALE_TYPES.find(s => s[0] === id);
  return hit ? hit[2].slice() : [];
}

const normPc = n => ((Math.round(Number(n) || 0) % 12) + 12) % 12;

/** 解析出该音阶的音级偏移（相对主音，0-11 去重升序）；custom 为空则退化为「仅主音」 */
export function scaleDegrees(spec) {
  if (!spec) return null;
  if (spec.type === 'custom') {
    const arr = Array.isArray(spec.custom) ? spec.custom : [];
    const deg = [...new Set(arr.map(d => normPc(d)))].sort((a, b) => a - b);
    return deg.length ? deg : [0];
  }
  const deg = scaleTypeDegrees(spec.type);
  return deg.length ? deg : [0];
}

/** 调内音级集合（0-11 绝对音级）；spec 为空返回 null（表示不约束） */
export function scalePitchClasses(spec) {
  const deg = scaleDegrees(spec);
  if (!deg || !spec) return null;
  const root = normPc(spec.root);
  return new Set(deg.map(d => (d + root) % 12));
}

/** midi 是否在调内（未指定音阶时恒为 true） */
export function isInScale(midi, spec) {
  const set = scalePitchClasses(spec);
  return set ? set.has(normPc(midi)) : true;
}

/** 吸附到最近的调内音（跨八度比较；距离相同时取更低音，结果限于 0-127） */
export function snapToScale(midi, spec) {
  const set = scalePitchClasses(spec);
  const m0 = Math.max(0, Math.min(127, Math.round(midi)));
  if (!set) return m0;
  if (set.has(normPc(m0))) return m0;
  let best = m0, bestD = 99;
  for (let d = -6; d <= 6; d++) {
    const cand = m0 + d;
    if (cand < 0 || cand > 127) continue;
    if (!set.has(normPc(cand))) continue;
    const ad = Math.abs(d);
    if (ad < bestD) { bestD = ad; best = cand; }
  }
  return best;
}

/** 解析「0,2,4,7,9」这类自定义音级文本 */
export function parseCustomDegrees(text) {
  const deg = [...new Set(String(text || '')
    .split(/[^0-9-]+/)
    .map(x => Number(x))
    .filter(x => Number.isFinite(x))
    .map(x => normPc(x)))].sort((a, b) => a - b);
  return deg;
}
