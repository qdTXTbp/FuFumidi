// ============================================================
// 主题 = **数据**（可视化重做 · 状态层）
//
// 为什么把主题做成数据：旧实现里"主题"只是几个参数的 diff（把泛光调大），
// 所以换来换去颜色不变、观感不变 —— 用户原话「效果很一般」。
// 重做后一套主题声明：**舞台底色 / 键面 / 音符 / 手色 / 材质 / 后处理**，
// 换主题就是换这套数据，渲染代码一行不用改。
//
// ★ 键面亮度是量出来的元凶（2026-10-17）：
//   参考实现键盘区平均亮度 0.00–0.33，我们旧版 0.59–0.65（一大条白键盘抢戏）。
//   所以这里所有主题的键面都压暗，**只有按键才亮**。
// ============================================================

/** 键面色板：键面/前脸/顶边/侧线 + 键上文字色（键面已暗，文字必须浅色） */
function keys(p) {
  return {
    wkTop: p.wkTop, wkBot: p.wkBot, wkFrontTop: p.wkFrontTop, wkFrontBot: p.wkFrontBot,
    wkEdge: p.wkEdge, wkLine: p.wkLine || 'rgba(0,0,0,0.32)',
    bkTop: p.bkTop, bkBot: p.bkBot, bkFrontTop: p.bkFrontTop, bkFrontBot: p.bkFrontBot,
    ink: p.ink || 'rgba(255,255,255,0.5)',
  };
}

export const THEMES = {
  /** 默认（工作室）：深靛舞台 + 冷色音符，最克制的一套 */
  studio: {
    id: 'studio', name: '默认',
    stage: { top: '#0a0e18', bottom: '#131a2a', vignette: 0.55, floor: 'rgba(90,140,220,0.10)' },
    keys: keys({ wkTop: '#9aa0a8', wkBot: '#7d838b', wkFrontTop: '#6b717a', wkFrontBot: '#565c65', wkEdge: 'rgba(255,255,255,0.34)', bkTop: '#23262b', bkBot: '#14171b', bkFrontTop: '#12151a', bkFrontBot: '#0a0c0f' }),
    note: { radius: 6, core: 0.42, glow: 1.0, edge: 0.28 },
    material: { bloom: 0.55, bloomThr: 0.5, vignette: 0.55, grade: 1.0 },
  },
  /** 霓虹：近黑底 + 品红/青，泛光拉高，粒子密 */
  neon: {
    id: 'neon', name: '霓虹',
    stage: { top: '#05060c', bottom: '#101024', vignette: 0.68, floor: 'rgba(180,80,255,0.14)' },
    keys: keys({ wkTop: '#6f7480', wkBot: '#565b66', wkFrontTop: '#43474f', wkFrontBot: '#34383f', wkEdge: 'rgba(255,120,255,0.35)', bkTop: '#15161c', bkBot: '#08090d', bkFrontTop: '#0a0b10', bkFrontBot: '#040508' }),
    note: { radius: 7, core: 0.5, glow: 1.35, edge: 0.34 },
    material: { bloom: 0.5, bloomThr: 0.55, vignette: 0.68, grade: 1.08 },
  },
  /** 极光：青紫 + 暖橙（左右手分色的适配主题） */
  aurora: {
    id: 'aurora', name: '极光',
    stage: { top: '#07101a', bottom: '#0d1a2c', vignette: 0.5, floor: 'rgba(70,220,200,0.12)' },
    keys: keys({ wkTop: '#8b95a3', wkBot: '#6f7885', wkFrontTop: '#5c6572', wkFrontBot: '#4a525e', wkEdge: 'rgba(140,255,240,0.32)', bkTop: '#1c222b', bkBot: '#0e1218', bkFrontTop: '#0c1015', bkFrontBot: '#060809' }),
    note: { radius: 6, core: 0.46, glow: 1.2, edge: 0.3 },
    material: { bloom: 0.45, bloomThr: 0.55, vignette: 0.5, grade: 1.04 },
  },
  /** 复古：暗棕底 + 琥珀，泛光低、颗粒感 */
  retro: {
    id: 'retro', name: '复古',
    stage: { top: '#120d08', bottom: '#1e1610', vignette: 0.72, floor: 'rgba(220,160,80,0.10)' },
    keys: keys({ wkTop: '#a89a86', wkBot: '#8b7f6d', wkFrontTop: '#756a5b', wkFrontBot: '#5d5449', wkEdge: 'rgba(255,220,170,0.30)', bkTop: '#2a231b', bkBot: '#17130e', bkFrontTop: '#13100b', bkFrontBot: '#0a0806' }),
    note: { radius: 5, core: 0.34, glow: 0.85, edge: 0.22 },
    material: { bloom: 0.34, bloomThr: 0.68, vignette: 0.72, grade: 0.96 },
  },
  /** 极简：黑白灰，无粒子无光柱 —— 给"只看结构"的人 */
  minimal: {
    id: 'minimal', name: '极简',
    stage: { top: '#08090b', bottom: '#101215', vignette: 0.6, floor: 'rgba(200,210,220,0.06)' },
    keys: keys({ wkTop: '#7d8288', wkBot: '#63686e', wkFrontTop: '#4e5257', wkFrontBot: '#3c4044', wkEdge: 'rgba(255,255,255,0.26)', bkTop: '#1b1d20', bkBot: '#0d0f11', bkFrontTop: '#0b0c0e', bkFrontBot: '#050607' }),
    note: { radius: 4, core: 0.3, glow: 0.6, edge: 0.2 },
    material: { bloom: 0.18, bloomThr: 0.75, vignette: 0.6, grade: 0.92 },
  },
};

export function resolveTheme(name) { return THEMES[name] || THEMES.studio; }

/** 音符取色：轨道色 / 按音高 / 左右手（重做版把"分色"收进主题解析，不再散在渲染里） */
export function noteColor(theme, mode, b, cs) {
  if (mode === 'hand') return b.pitch < 60 ? 'hsl(205,78%,62%)' : 'hsl(24,88%,60%)';
  if (mode === 'pitch') return 'hsl(' + ((b.pitch * 13) % 360) + ',68%,54%)';
  if (!cs) return b.color || theme.note.fallback || '#4f9dff';
  return 'hsl(' + (((b.pitch * (cs === 1 ? 7 : cs === 2 ? 13 : 17)) + (cs === 2 ? 30 : 0)) % 360) + ',' +
    (cs === 3 ? 75 : cs === 2 ? 80 : 70) + '%,' + (cs === 3 ? 65 : 60) + '%)';
}
