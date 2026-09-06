<script setup>
// 交互式新手引导：欢迎导览 + 全功能实操步骤（参照 v2.1 交互式引导迁移）
import { ref, computed, nextTick, onBeforeUnmount } from 'vue';
import { useRoute } from 'vue-router';
import Icon from './Icon.vue';
import { useAppStore, OLD_VIEW_TO_PARENT, viewParentOf } from '../stores/app';
import { t } from '../core/i18n.js';

const app = useAppStore();
const state = app;
const setView = (v) => app.setView(v);
const bridge = window.fuBridge;
const route = useRoute();

const WELCOME_STEPS = [
  { ic: 'play2', title: t('欢迎使用 FuFumidi'), body: [ t('转录、修正、编辑、播放一条龙，全部在本机完成，无需联网。'), t('首页工作区已整合：最近曲目、保存工程、导出 MusicXML、快速开始都在一屏内。') ] },
  { ic: 'viz', title: t('播放与可视化'), body: [ t('演奏视图：瀑布流下落音符，跟随播放实时滚动；点击底部琴键可试听单音。'), t('可视化页支持仪表盘 / 瀑布流模式切换，还可点击和弦高亮对应音符。') ] },
  { ic: 'music', title: t('歌词页面'), body: [ t('实时预览当前歌词，并配有波形 / 频谱辅助定位。'), t('歌词时间轴为钢琴卷帘式：可直接拖拽歌词块对齐，Shift 吸附音符、Ctrl 吸附网格。') ] },
  { ic: 'edit', title: t('编辑与修正'), body: [ t('钢琴卷帘默认使用折叠 + 图标工具栏，低频功能不占空间。'), t('选中音符后右侧自动打开属性检查器，可精确调整音高、力度、起点与长度。') ] },
  { ic: 'score', title: t('乐谱页面'), body: [ t('自动根据音域切换高低音谱号，并使用 8va / 8vb / 15ma 避免加线“梯子”。'), t('符干方向按谱号中线规则优化，音符间距与连线排版更均匀。') ] },
  { ic: 'transcribe', title: t('转录与转换'), body: [ t('音频转 MIDI：通用识别 / 钢琴专用 / 人声分离三种引擎，性能档位自动推荐。'), t('转换页新增 16:9 视频预览与输出估算，导出前即可看到画质和文件大小预期。') ] },
  { ic: 'palette', title: t('个性化与设置'), body: [ t('主题库与强调色：深色扁平设计，多种配色随心切换。'), t('支持中英双语、快捷键、插件扩展；更多功能已集中到首页“更多功能”横排区域。') ] },
];

const IG_STEPS = [
  { view: 'home', selector: '[data-guide="quick-transcode"]', title: t('1. 进入转译页'), desc: t('点击首页“转译”卡片，或顶部切换到“转译”标签。'), action: true, validate: () => state.view === 'transcode' },
  { view: 'transcribe', selector: '[data-guide="mode-piano"]', title: t('2. 选择转录引擎'), desc: t('通用识别适合任意歌曲；钢琴专用适合纯钢琴；人声分离先分离人声/伴奏。'), action: true, validate: el => el.classList.contains('active') },
  { view: 'transcribe', selector: '[data-guide="audio-drop"]', title: t('3. 导入音频文件'), desc: t('点击上传区域，选择 MP3 / WAV / FLAC / M4A 等音频。建议使用音质较高的音频。'), manual: true },
  { view: 'transcribe', selector: '[data-guide="adv-panel"]', title: t('4. 调整转录参数'), desc: t('展开高级参数可调整阈值、最短音符、合并间隔、踏板、降噪、响度平衡、自动 BPM。'), manual: true },
  { view: 'transcribe', selector: '[data-guide="start-transcribe"]', title: t('5. 开始转录'), desc: t('点击“开始转录”，AI 会在本地生成 MIDI，全程离线。'), manual: true },
  { view: 'play', selector: '.tp-play', title: t('6. 试听转录结果'), desc: t('点击播放 / 暂停试听；瀑布流会实时滚动。'), manual: true },
  { view: 'edit', selector: '[data-guide="edit-canvas"]', title: t('7. 进入编辑器'), desc: t('在钢琴卷帘中点击或框选音符；拖动移动位置，边缘拉伸改时值，Delete 删除。'), manual: true },
  { view: 'edit', selector: '[data-guide="velocity-slider"]', title: t('8. 力度调节'), desc: t('选中音符后拖动“力度”滑块，力度越大播放时音量越强。'), manual: true },
  { view: 'viz', selector: '.viz-card', title: t('9. 可视化分析'), desc: t('查看音符瀑布、频谱瀑布、波形示波器等，适合检查整体旋律走向。'), manual: true },
  { view: 'analyze', selector: '#azPitch', title: t('10. MIDI 数据分析'), desc: t('鼠标悬停在图表上可查看具体数值；分析结果可帮助判断是否需要修正调性/音区。'), manual: true },
  { view: 'score', selector: '.score-view', title: t('11. 乐谱视图'), desc: t('查看可跟随播放的五线谱；可选择乐谱轨道、开启播放跟随、点击乐谱音符定位播放头。'), manual: true },
  { view: 'convert', selector: '.convert-view', title: t('12. 导出转换'), desc: t('可导出 MIDI、MusicXML、WAV、视频；导出前可选择范围和速度。'), manual: true },
  { view: 'home', selector: '[data-guide="quick-settings"]', title: t('13. 应用设置'), desc: t('设置主题、强调色、字号、语言、Python 解释器、默认输出目录、MIDI 文件关联、插件管理。'), action: true, validate: () => !!state.ui.settingsOpen },
  { view: 'home', selector: '[data-guide="quick-settings"]', title: t('14. 完成'), desc: t('你已经掌握 FuFumidi 的主要功能。常用快捷键：Space 播放/暂停、L 循环、M 节拍器、Ctrl+K 命令面板、F1 帮助。'), manual: true },
];

const mode = ref('welcome');
const welcomeIdx = ref(0);
const igIdx = ref(0);
const igEl = ref(null);
const highlightStyle = ref({});
const cardStyle = ref({});
let pollTimer = null;
let scrollHandler = null;
let actionOff = null;

const isLastWelcome = computed(() => welcomeIdx.value >= WELCOME_STEPS.length - 1);
const welcomeStep = computed(() => WELCOME_STEPS[welcomeIdx.value]);
const igStep = computed(() => IG_STEPS[igIdx.value] || null);

function markDone() {
  try { localStorage.setItem('fufumidi_guide_done', '1'); } catch (e) {}
  if (bridge && typeof bridge.saveSettings === 'function') {
    bridge.saveSettings({ guide_done: true }).catch(() => {});
  }
}
function closeGuide() {
  state.ui.guideOpen = false;
  cleanupIg();
  markDone();
}
function skip() { closeGuide(); }

function goWelcomePrev() { if (welcomeIdx.value > 0) welcomeIdx.value--; }
function goWelcomeNext() {
  if (isLastWelcome.value) startIg();
  else welcomeIdx.value++;
}

/* ---------------- 交互式实操引擎 ---------------- */
let targetTimer = null;
function cleanupIg() {
  if (targetTimer) { clearTimeout(targetTimer); targetTimer = null; }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (scrollHandler) { window.removeEventListener('scroll', scrollHandler, true); window.removeEventListener('resize', scrollHandler); scrollHandler = null; }
  if (actionOff) { actionOff(); actionOff = null; }
  if (igEl.value) { try { igEl.value.classList.remove('ig-target'); } catch (e) {} igEl.value = null; }
}

function updateHighlight() {
  if (!igEl.value) return;
  const r = igEl.value.getBoundingClientRect();
  highlightStyle.value = { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' };
  let top = r.bottom + 12;
  if (top + 150 > window.innerHeight) top = Math.max(8, r.top - 165);
  cardStyle.value = {
    left: Math.min(window.innerWidth - 320, Math.max(8, r.left)) + 'px',
    top: top + 'px',
  };
}

function startIg() {
  mode.value = 'ig';
  igIdx.value = 0;
  nextTick(renderIg);
}

function attachIg(el, st) {
  igEl.value = el;
  el.classList.add('ig-target');
  scrollHandler = () => updateHighlight();
  window.addEventListener('scroll', scrollHandler, true);
  window.addEventListener('resize', scrollHandler);
  try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' }); } catch (e) {}
  // 等平滑滚动稳定后再计算高亮位置
  setTimeout(updateHighlight, 250);
  updateHighlight();
  if (st.action) {
    const handler = () => {
      if (st.validate ? st.validate(el) : true) igNext();
    };
    el.addEventListener('click', handler);
    actionOff = () => el.removeEventListener('click', handler);
  } else if (st.waitFor) {
    pollTimer = setInterval(() => { if (st.waitFor()) igNext(); }, 300);
  }
}

function renderIg() {
  cleanupIg();
  const st = igStep.value;
  if (!st) { closeGuide(); return; }
  if (st.view) {
    const parent = viewParentOf(st.view);
    const child = OLD_VIEW_TO_PARENT[st.view] || '';
    const currentTab = String(route.query.tab || '');
    if (state.view !== parent || (child && currentTab !== child)) {
      setView(st.view);
      targetTimer = setTimeout(renderIg, 80);
      return;
    }
  }
  const started = Date.now();
  const tryFind = () => {
    const el = typeof st.selector === 'string' ? document.querySelector(st.selector) : null;
    if (el) { attachIg(el, st); return; }
    // 懒加载视图/组件尚未挂载时等待，避免误跳过
    if (Date.now() - started < 3000) {
      targetTimer = setTimeout(tryFind, 100);
      return;
    }
    console.warn('[guide] target missing:', st.selector);
    igNext();
  };
  targetTimer = setTimeout(tryFind, 60);
}

function igNext() {
  igIdx.value++;
  nextTick(renderIg);
}

function finishIg() { toast('恭喜！你已完成 FuFumidi 全功能教程', 'ok'); closeGuide(); }
function toast(msg, type) { app.toast(msg, type); }

/* 欢迎页插画装饰 */
const notes = ['♪', '♫', '♩', '♬'];

onBeforeUnmount(cleanupIg);
</script>

<template>
  <div class="overlay guide-overlay" v-focus-trap role="dialog" aria-modal="true" :aria-label="t('新手引导')" @click.self="skip" @keydown.esc="skip">
    <!-- 欢迎导览 -->
    <div v-if="mode === 'welcome'" class="guide-card">
      <div class="guide-head">
        <span class="guide-count">{{ t('新手引导') }}</span>
        <button class="icon-btn" :title="t('关闭')" aria-label="t('关闭')" @click="skip"><Icon name="plus" :size="16" style="transform:rotate(45deg)" /></button>
      </div>
      <div class="guide-art">
        <span class="g-step">{{ welcomeIdx + 1 }} / {{ WELCOME_STEPS.length }}</span>
        <i v-for="n in notes" :key="n" class="g-note">{{ n }}</i>
        <Icon :name="welcomeStep.ic" :size="44" class="g-ic" />
      </div>
      <div class="guide-body">
        <div class="guide-text">
          <h3>{{ welcomeStep.title }}</h3>
          <ul>
            <li v-for="(line, i) in welcomeStep.body" :key="i">{{ line }}</li>
          </ul>
        </div>
      </div>
      <div class="guide-dots">
        <i v-for="(s, i) in WELCOME_STEPS" :key="i" :class="{ on: i === welcomeIdx }"></i>
      </div>
      <div class="guide-foot">
        <button class="guide-btn ghost" @click="closeGuide">{{ t('跳过 / 关闭') }}</button>
        <button class="guide-btn ghost" :style="{ visibility: welcomeIdx ? 'visible' : 'hidden' }" @click="goWelcomePrev">{{ t('上一步') }}</button>
        <button class="guide-btn primary" @click="goWelcomeNext">{{ isLastWelcome ? t('开始全功能实操') : t('下一步') }}</button>
      </div>
    </div>

    <!-- 交互式实操 -->
    <template v-else>
      <div class="ig-highlight" :style="highlightStyle"></div>
      <div class="ig-card" :style="cardStyle">
        <div class="ig-head">
          <b>{{ igStep.title }}</b>
          <span class="ig-count">{{ igIdx + 1 }} / {{ IG_STEPS.length }}</span>
        </div>
        <p class="ig-desc">{{ igStep.desc }}</p>
        <div class="ig-foot">
          <button class="guide-btn ghost" @click="skip">{{ t('跳过') }}</button>
          <button v-if="igStep.manual" class="guide-btn primary" @click="igNext">{{ t('下一步') }}</button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.guide-art {
  position: relative;
  height: 92px;
  display: grid;
  place-items: center;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, var(--surface));
  border-radius: 14px;
  margin-bottom: 12px;
  overflow: hidden;
}
.g-ic { position: relative; z-index: 2; opacity: .9; }
.g-step {
  position: absolute;
  top: 8px; left: 12px;
  font-size: 11px;
  font-weight: 700;
  color: var(--stone);
  letter-spacing: .4px;
  z-index: 2;
}
.g-note { position: absolute; color: color-mix(in srgb, var(--accent) 30%, transparent); font-size: 24px; user-select: none; animation: gfloat 3.2s ease-in-out infinite; }
.g-note:nth-child(1){ top:16%; left:12%; animation-delay:0s; }
.g-note:nth-child(2){ top:70%; left:20%; font-size:18px; animation-delay:1s; }
.g-note:nth-child(3){ top:30%; right:10%; font-size:30px; animation-delay:1.9s; }
.g-note:nth-child(4){ top:64%; right:22%; font-size:15px; animation-delay:.5s; }
@keyframes gfloat { 0%,100%{ transform:translateY(0); } 50%{ transform:translateY(-6px); } }
.guide-dots { display: flex; gap: 6px; margin-top: 14px; }
.guide-dots i { width:8px; height:8px; border-radius:50%; background: var(--hairline); transition:.2s; }
.guide-dots i.on { background: var(--accent); transform: scale(1.25); }
.guide-overlay { background: rgba(6,10,16,.58); backdrop-filter: blur(2px); pointer-events: none; }
.guide-overlay .guide-card, .guide-overlay .ig-card { pointer-events: auto; }
.guide-overlay :deep(.ig-target) { position: relative !important; z-index: 1200 !important; outline: 2px dashed var(--accent) !important; outline-offset: 3px !important; pointer-events: auto !important; }
.ig-highlight {
  position: fixed;
  z-index: 1200;
  pointer-events: none;
  border-radius: 12px;
  box-shadow: 0 0 0 999px rgba(6,10,16,.58);
  border: 2px dashed var(--accent);
  animation: igpulse 1.4s ease-in-out infinite;
}
@keyframes igpulse { 0%,100%{ box-shadow: 0 0 0 999px rgba(6,10,16,.58); } 50%{ box-shadow: 0 0 0 999px rgba(6,10,16,.46); } }
.ig-card {
  position: fixed;
  z-index: 1202;
  width: 300px;
  max-width: 92vw;
  background: var(--canvas);
  border: 1px solid var(--hairline);
  border-radius: 14px;
  padding: 14px 16px;
  box-shadow: var(--shadow-lg);
}
.ig-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: var(--ink); }
.ig-count { font-size: 11px; color: var(--stone); white-space: nowrap; }
.ig-desc { margin: 8px 0 10px; font-size: 12.5px; line-height: 1.65; color: var(--steel); }
.ig-foot { display: flex; justify-content: flex-end; gap: 6px; }
</style>
