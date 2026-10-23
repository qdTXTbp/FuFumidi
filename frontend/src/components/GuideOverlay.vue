<script setup>
// 新手引导 v5：章节式学习（31 步 / 6 章），首次打开自动出现；完成进度持久化。
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from './Icon.vue';
import { useAppStore } from '../stores/app';
import { t } from '../core/i18n.js';

const state = useAppStore();
const SEEN_KEY = 'fufumidi_guide_ui4_seen';
const DONE_KEY = 'fufumidi_guide_done';
const PROGRESS_KEY = 'fufumidi_guide_v4_progress';
const mode = ref('catalog');
const chapterIdx = ref(0);
const stepIdx = ref(0);
const targetRect = ref(null);
const targetMissing = ref(false);
function loadDone() { try { const a = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
const doneChapters = ref(loadDone());

const CHAPTERS = computed(() => [
  {
    id: 'start', icon: 'home', title: t('第一章 · 入门'), desc: t('五项左轨、顶栏标签、首页入口与外观抽屉。'),
    steps: [
      { title: t('欢迎使用 FuFumidi'), desc: t('一处完成播放、转录、编辑与导出。跟着走一遍，知道每块在哪里。'), selector: '', route: '#/home' },
      { title: t('左侧轨道：五个入口'), desc: t('首页 / 音乐 / 工作台 / 创作 / 资源。底部是命令面板、外观、帮助、设置、侧栏与播放栏开关。'), selector: '.primary-rail', route: '#/home' },
      { title: t('顶栏与曲目标签'), desc: t('后退 / 前进；中间是打开中的曲目，可切换、关闭、拖动排序；超过 6 个自动折叠，右键可分组。'), selector: '.topbar', route: '#/home' },
      { title: t('首页：继续或开始'), desc: t('继续上次工程；右上角小立绘旁边是当前曲目卡片，右侧是系统状态与最近项目。'), selector: '.home-view', route: '#/home' },
      { title: t('外观与帮助'), desc: t('左侧底部的调色板打开外观抽屉；问号随时重开本引导，F1 也可以。'), selector: '.primary-rail [title="外观"]', route: '#/home' },
    ],
  },
  {
    id: 'library', icon: 'music', title: t('第二章 · 音乐与曲库'), desc: t('导入、歌单、曲目操作、演奏、可视化与乐谱。'),
    steps: [
      { title: t('曲库：导入与整理'), desc: t('图标导入；搜索、整理方式、筛选都在左侧。'), selector: '.sidebar-body', route: '#/home' },
      { title: t('歌单与快捷视图'), desc: t('歌单独立滚动；右键重命名 / 删除，拖动排序；全部 / 收藏 / 最近 / 最常用切换。'), selector: '[data-guide=\'sidebar-playlists\']', route: '#/home' },
      { title: t('曲目：点击与右键'), desc: t('单击选中、双击播放、右键管理；拖动排序，批量管理可多选。'), selector: '.song-list', route: '#/home' },
      { title: t('音乐：演奏 / 可视化 / 乐谱'), desc: t('音乐区分成三页：演奏看播放与混音，可视化看瀑布与频谱，乐谱看五线谱 / 总谱 / 简谱 / 六线谱。'), selector: '.pb-main', route: '#/music?tab=play' },
      { title: t('乐谱：工具栏与分屏'), desc: t('乐谱页不再有页头贴片：轨道、模式、预览 / PDF / 跟随播放 / 导入 / XML / PNG / 分屏都在工具栏；谱面可缩放。'), selector: '.score-toolbar', route: '#/music?tab=score' },
    ],
  },
  {
    id: 'playedit', icon: 'edit', title: t('第三章 · 编辑与工作台'), desc: t('钢琴卷帘、检查器、歌词、分析、编排与聚焦联动。'),
    steps: [
      { title: t('工作台：四个页签'), desc: t('编辑 / 歌词 / 分析 / 编排。演奏与可视化在「音乐」，不要在这里找。'), selector: '.gp-tab', route: '#/views?tab=edit' },
      { title: t('编辑器：工具与画布'), desc: t('选择 / 画笔 / 橡皮 / 静音 / 录音 / 步进；拖动移动音符，拖边缘改长度；滚轮缩放平移。'), selector: '[data-guide=\'edit-canvas\']', route: '#/views?tab=edit' },
      { title: t('检查器与高级工具'), desc: t('检查器改音高 / 力度 / 起点 / 长度；「更多」展开可拖动的高级工具浮层，里面有量化、移调、逻辑、宏与 CC 泳道。'), selector: '.ed-insp', route: '#/views?tab=edit' },
      { title: t('歌词：对齐与批量处理'), desc: t('导入 LRC、逐字拆分、拖时间轴对齐、批量替换，然后导出字幕或写回音符。'), selector: '.lyr-toolbar', route: '#/views?tab=lyrics' },
      { title: t('分析：调性、和弦与密度'), desc: t('一首歌的调性、和弦、音高 / 力度 / 密度报告；用统计结果判断改写方向。'), selector: '.page', route: '#/views?tab=analyze' },
      { title: t('编排：时间线与片段'), desc: t('轨道 M / S、吸附、复制、右键菜单、标记与区间；片段内会画 MIDI 音符缩略。'), selector: '[data-guide=\'arrange-canvas\']', route: '#/views?tab=arrange' },
      { title: t('编排 ↔ 编辑联动'), desc: t('双击编排片段会跳到编辑器，按轨道 ID / 名称定位，并选中片段范围内的音符。'), selector: '[data-guide=\'arrange-canvas\']', route: '#/views?tab=arrange' },
    ],
  },
  {
    id: 'create', icon: 'convert', title: t('第四章 · 创作'), desc: t('转录、转换、变谱、翻唱、调教都在创作区。'),
    steps: [
      { title: t('创作页签'), desc: t('转录 / 转换 / 变谱 / 翻唱 / 调教。先想清楚是「音频转谱」还是「谱转音频」，再选页签。'), selector: '.gp-tab', route: '#/transcode?tab=transcribe' },
      { title: t('转录：两栏工作区'), desc: t('左侧队列、右侧引擎与参数；不再三栏硬塞。'), selector: '.tr-view', route: '#/transcode?tab=transcribe' },
      { title: t('转录：队列与运行'), desc: t('队列独立滚动；选模型、性能档和高级参数后，右侧「运行」开始。运行中切页不会打断队列。'), selector: '.tr-drop-card', route: '#/transcode?tab=transcribe' },
      { title: t('转换：音频与视频并排'), desc: t('左边音频导出（格式 / 响度 / 分轨），右边视频导出（比例 / 帧率 / 质量）。'), selector: '.conv-duo', route: '#/transcode?tab=convert' },
      { title: t('翻唱：分离到混音'), desc: t('选歌 → 人声分离（可选）→ RVC 变声 → 混音导出；先确认模型与音色。'), selector: '.cv-wrap', route: '#/transcode?tab=cover' },
      { title: t('调教：选歌手与画音符'), desc: t('创作 · 调教页头集中打开工程 / 导入 MIDI；编辑器、声库、声库制作三段工作流，画完音符再渲染。'), selector: '.sing-page', route: '#/transcode?tab=singer' },
    ],
  },
  {
    id: 'resources', icon: 'box', title: t('第五章 · 资源与扩展'), desc: t('模型、插件、音色与存储，四件事都在资源中心。'),
    steps: [
      { title: t('模型管理'), desc: t('模型管理分转录 / 人声分离 / 修复·VR / 调教；调教下再分调教模型 / DiffSinger / UTAU / RVC。'), selector: '.vm-page', route: '#/resources?tab=models' },
      { title: t('插件中心'), desc: t('资源 → 插件中心：官方商店、已安装开关、插件日志与安装确认；插件目录可一键打开。'), selector: '.pc', route: '#/resources?tab=plugins' },
      { title: t('音色工坊'), desc: t('选择播放音色库（SF2 / 内置合成器），试听后一键应用；下载与导入也在这里。'), selector: '.sf-card', route: '#/resources?tab=soundfonts' },
      { title: t('存储治理'), desc: t('查看各分类占用与文件数；可重建缓存可清理，资产需显式勾选，曲库永远不动。'), selector: '.storage-panel', route: '#/resources?tab=storage' },
    ],
  },
  {
    id: 'appearance', icon: 'palette', title: t('第六章 · 外观与效率'), desc: t('主题、壁纸、任务中心小球、设置与快捷键。'),
    steps: [
      { title: t('外观抽屉'), desc: t('主题 / 深浅 / 强调色 / 字号 / 密度 / 缩放 / 语言 / 减弱动态，全部集中在左侧调色板打开的抽屉里。'), selector: '.wlib', route: '#/home', onEnter: () => { state.ui.appearanceOpen = true; } },
      { title: t('统一壁纸库'), desc: t('动态仓库 / 在线静态 / 本地文件夹三类；静态动态同网格，支持直链下载，外链文件夹只登记路径不复制。'), selector: '.wlib', route: '#/home', onEnter: () => { state.ui.appearanceOpen = true; } },
      { title: t('任务中心小球'), desc: t('右下角任务图标可拖动；拖到左右边缘自动收成侧边条，点击恢复，面板里也能隐藏到侧边。'), selector: '.task-center', route: '#/home' },
      { title: t('设置、音效与快捷键'), desc: t('设置里改 GPU / 功能 / 快捷键 / 更新；音效默认全 100%，可分类调音量；F1 随时重开本引导。'), selector: '[data-guide=\'topbar-settings\']', route: '#/home' },
    ],
  },
]);
const chapter = computed(() => CHAPTERS.value[chapterIdx.value] || CHAPTERS.value[0]);
const step = computed(() => chapter.value.steps[stepIdx.value] || chapter.value.steps[0]);
const overallDone = computed(() => doneChapters.value.length);
const overallPct = computed(() => Math.round((overallDone.value / CHAPTERS.value.length) * 100));
const isDone = (id) => doneChapters.value.includes(id);

let measureTimer = 0;
function measure() {
  clearTimeout(measureTimer);
  if (mode.value !== 'lesson' || !step.value.selector) { targetRect.value = null; targetMissing.value = false; return; }
  const el = document.querySelector(step.value.selector);
  if (!el) { targetRect.value = null; targetMissing.value = true; return; }
  try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' }); } catch (e) {}
  measureTimer = setTimeout(() => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) { targetRect.value = null; targetMissing.value = true; return; }
    targetRect.value = { left: r.left - 6, top: r.top - 6, width: r.width + 12, height: r.height + 12 };
    targetMissing.value = false;
  }, 240);
}
function goStep(n) {
  stepIdx.value = Math.max(0, Math.min(chapter.value.steps.length - 1, n));
  const s = step.value;
  if (s.route && location.hash !== s.route) { try { location.hash = s.route; } catch (e) {} }
  nextTick(() => setTimeout(measure, 520));
}
function openChapter(i) {
  chapterIdx.value = i; stepIdx.value = 0; mode.value = 'lesson';
  const s = chapter.value.steps[0];
  if (s.route && location.hash !== s.route) { try { location.hash = s.route; } catch (e) {} }
  nextTick(() => setTimeout(measure, 520));
}
function saveProgress() { try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(doneChapters.value)); } catch (e) {} }
function finishChapter() {
  const id = chapter.value.id;
  if (!doneChapters.value.includes(id)) { doneChapters.value.push(id); saveProgress(); }
  if (doneChapters.value.length >= CHAPTERS.value.length) { mode.value = 'complete'; targetRect.value = null; return; }
  mode.value = 'catalog'; targetRect.value = null;
}
function nextStep() { if (stepIdx.value >= chapter.value.steps.length - 1) finishChapter(); else goStep(stepIdx.value + 1); }
function prevStep() { if (stepIdx.value === 0) { mode.value = 'catalog'; targetRect.value = null; } else goStep(stepIdx.value - 1); }
function markSeen() {
  try { localStorage.setItem(SEEN_KEY, '1'); localStorage.setItem(DONE_KEY, '1'); } catch (e) {}
  try { window.fuBridge && window.fuBridge.saveSettings && window.fuBridge.saveSettings({ guide_done: true }); } catch (e) {}
}
function close() { markSeen(); state.ui.guideOpen = false; }
function startNext() { const i = CHAPTERS.value.findIndex((c) => !doneChapters.value.includes(c.id)); openChapter(i >= 0 ? i : 0); }
function onKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); close(); return; }
  if (mode.value === 'lesson') {
    if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); nextStep(); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); prevStep(); }
  }
}
onMounted(() => { window.addEventListener('keydown', onKey, true); window.addEventListener('resize', measure); });
onBeforeUnmount(() => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', measure); clearTimeout(measureTimer); });
</script>

<template>
  <Teleport to="body">
    <div class="guide-mask" :class="{ 'no-target': mode !== 'lesson' || !targetRect }" @click.self="close">
      <div v-if="mode === 'lesson' && targetRect" class="guide-ring" :style="{ left: targetRect.left + 'px', top: targetRect.top + 'px', width: targetRect.width + 'px', height: targetRect.height + 'px' }"></div>

      <section v-if="mode === 'catalog'" class="guide-card guide-catalog" role="dialog" aria-modal="true">
        <div class="guide-top">
          <div><span class="guide-eyebrow">FUFUMIDI GUIDE</span><h2>{{ t('新手引导') }}</h2></div>
          <button class="icon-btn" :title="t('跳过')" :aria-label="t('跳过')" @click="close"><Icon name="close" :size="16" /></button>
        </div>
        <p class="guide-lead">{{ t('按章节学习，覆盖全部功能区；随时可以回来继续。') }}</p>
        <div class="guide-overall"><i :style="{ width: overallPct + '%' }"></i></div>
        <div class="guide-overall-txt">{{ t('已完成') }} {{ overallDone }} / {{ CHAPTERS.length }} {{ t('章') }} · {{ overallPct }}%</div>
        <div class="guide-chapters">
          <button v-for="(c, i) in CHAPTERS" :key="c.id" class="guide-ch" :class="{ done: isDone(c.id) }" @click="openChapter(i)">
            <span class="guide-ch-ic"><Icon :name="c.icon" :size="17" /></span>
            <span class="guide-ch-copy"><b>{{ c.title }}</b><small>{{ c.desc }}</small></span>
            <span class="guide-ch-steps">{{ isDone(c.id) ? t('已完成') : c.steps.length + ' ' + t('步') }}</span>
            <Icon :name="isDone(c.id) ? 'check' : 'forward'" :size="13" />
          </button>
        </div>
        <div class="guide-bottom">
          <button class="btn ghost sm" @click="close">{{ t('稍后再说') }}</button>
          <button class="btn primary sm" @click="startNext">{{ overallDone ? t('继续学习') : t('开始学习') }} <Icon name="forward" :size="13" /></button>
        </div>
      </section>

      <section v-else-if="mode === 'lesson'" class="guide-card" role="dialog" aria-modal="true">
        <div class="guide-top">
          <button class="guide-back" @click="mode = 'catalog'; targetRect = null"><Icon name="back" :size="13" /> {{ t('章节') }}</button>
          <button class="icon-btn" :title="t('跳过')" :aria-label="t('跳过')" @click="close"><Icon name="close" :size="16" /></button>
        </div>
        <div class="guide-ch-line">{{ chapter.title }}<span>{{ stepIdx + 1 }} / {{ chapter.steps.length }}</span></div>
        <div class="guide-progress"><i v-for="(s, i) in chapter.steps" :key="i" :class="{ on: i === stepIdx, done: i < stepIdx }"></i></div>
        <div class="guide-step">
          <span class="guide-ico"><Icon :name="chapter.icon" :size="20" /></span>
          <div><h2>{{ step.title }}</h2><p>{{ step.desc }}</p></div>
        </div>
        <div class="guide-hint" v-if="targetMissing">{{ t('这一步的目标当前不在屏幕上，继续即可。') }}</div>
        <div class="guide-bottom">
          <span class="guide-count">{{ chapterIdx + 1 }} / {{ CHAPTERS.length }}</span>
          <div class="guide-actions">
            <button class="btn ghost sm" @click="prevStep">{{ stepIdx === 0 ? t('章节') : t('上一步') }}</button>
            <button v-if="stepIdx < chapter.steps.length - 1" class="btn primary sm" @click="nextStep">{{ t('下一步') }} <Icon name="forward" :size="13" /></button>
            <button v-else class="btn primary sm" @click="finishChapter">{{ t('完成本章') }} <Icon name="check" :size="13" /></button>
          </div>
        </div>
        <div class="guide-foot">{{ t('← → 切换 · Esc 跳过 · F1 随时重开') }}</div>
      </section>

      <section v-else class="guide-card guide-catalog" role="dialog" aria-modal="true">
        <div class="guide-done-ico"><Icon name="check" :size="28" /></div>
        <h2>{{ t('全部章节已完成') }}</h2>
        <p class="guide-lead">{{ t('你已经把主要功能区走了一遍；F1 可以随时重看任意章节。') }}</p>
        <div class="guide-bottom"><button class="btn ghost sm" @click="mode = 'catalog'; targetRect = null">{{ t('再看一遍') }}</button><button class="btn primary sm" @click="close">{{ t('开始使用') }}</button></div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.guide-mask { position: fixed; inset: 0; z-index: var(--z-overlay); background: transparent; }
.guide-mask.no-target { background: color-mix(in srgb, var(--canvas) 58%, transparent); }
.guide-ring { position: fixed; z-index: 1; border: 2px solid var(--accent-sky); border-radius: var(--r-md); pointer-events: none; box-shadow: 0 0 0 9999px color-mix(in srgb, var(--canvas) 58%, transparent), 0 0 0 3px color-mix(in srgb, var(--accent-sky) 16%, transparent), 0 0 30px color-mix(in srgb, var(--accent-sapphire) 28%, transparent); transition: left var(--motion-base) var(--ease-out), top var(--motion-base) var(--ease-out), width var(--motion-base) var(--ease-out), height var(--motion-base) var(--ease-out); }
.guide-card { position: fixed; z-index: 2; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(560px, calc(100vw - var(--sp-6) * 2)); max-height: 86vh; overflow-y: auto; padding: var(--sp-5); border: 1px solid color-mix(in srgb, var(--ornament) 46%, var(--hairline)); border-radius: var(--r-lg); background-color: color-mix(in srgb, var(--surface) 86%, transparent); backdrop-filter: var(--glass-blur); box-shadow: var(--sh-3); color: var(--text); }
.guide-top { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); }
.guide-eyebrow { color: var(--accent-sky); font: var(--fs-xs) var(--font-num); letter-spacing: .16em; }
.guide-top h2 { margin: var(--sp-1) 0 0; font-size: var(--fs-xl); letter-spacing: -.02em; }
.guide-lead { margin: var(--sp-3) 0 var(--sp-4); color: var(--text2); font-size: var(--fs-sm); line-height: 1.65; }
.guide-overall { height: 5px; border-radius: var(--r-pill); background: var(--surface-soft); overflow: hidden; }
.guide-overall i { display: block; height: 100%; background: linear-gradient(90deg, var(--accent-sapphire), var(--accent-sky)); border-radius: var(--r-pill); }
.guide-overall-txt { margin: var(--sp-2) 0 var(--sp-3); color: var(--text3); font: var(--fs-xs) var(--font-num); }
.guide-chapters { display: flex; flex-direction: column; gap: var(--sp-2); }
.guide-ch { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-2) var(--sp-3); border: 1px solid var(--hairline); border-radius: var(--r-md); background: color-mix(in srgb, var(--surface) 58%, transparent); color: var(--text); text-align: left; cursor: pointer; }
.guide-ch:hover { border-color: color-mix(in srgb, var(--accent-sky) 35%, var(--hairline)); background: color-mix(in srgb, var(--accent-sapphire) 8%, var(--surface)); }
.guide-ch.done { border-color: color-mix(in srgb, var(--accent-sky) 24%, var(--hairline)); }
.guide-ch-ic { width: 32px; height: 32px; border-radius: var(--r-sm); display: grid; place-items: center; flex: none; color: var(--accent-sky); background: color-mix(in srgb, var(--accent-sapphire) 12%, var(--surface)); }
.guide-ch-copy { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.guide-ch-copy b { font-size: var(--fs-sm); }
.guide-ch-copy small { color: var(--text3); font-size: var(--fs-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.guide-ch-steps { flex: none; color: var(--accent-sky); font: var(--fs-xs) var(--font-num); }
.guide-back { display: inline-flex; align-items: center; gap: var(--sp-1); border: 0; background: transparent; color: var(--text3); font-size: var(--fs-xs); cursor: pointer; padding: 0; }
.guide-ch-line { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); margin-top: var(--sp-2); color: var(--text2); font-size: var(--fs-xs); }
.guide-ch-line span { color: var(--text3); font-family: var(--font-num); }
.guide-progress { display: flex; gap: var(--sp-1); margin: var(--sp-3) 0 var(--sp-4); }
.guide-progress i { height: 2px; flex: 1; border-radius: var(--r-pill); background: color-mix(in srgb, var(--hairline) 80%, transparent); }
.guide-progress i.done { background: color-mix(in srgb, var(--accent-sky) 55%, transparent); }
.guide-progress i.on { background: var(--accent-sky); box-shadow: 0 0 10px color-mix(in srgb, var(--accent-sky) 45%, transparent); }
.guide-step { display: flex; align-items: flex-start; gap: var(--sp-3); }
.guide-ico { width: 40px; height: 40px; border-radius: var(--r-md); display: grid; place-items: center; flex: none; color: var(--accent-sky); background: color-mix(in srgb, var(--accent-sapphire) 16%, var(--surface)); border: 1px solid color-mix(in srgb, var(--accent-sky) 22%, var(--hairline)); }
.guide-step h2 { margin: 0 0 var(--sp-1); font-size: var(--fs-lg); }
.guide-step p { margin: 0; color: var(--text2); font-size: var(--fs-sm); line-height: 1.7; }
.guide-hint { margin-top: var(--sp-3); padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); background: color-mix(in srgb, var(--accent-sky) 8%, var(--surface)); color: var(--text3); font-size: var(--fs-xs); }
.guide-bottom { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); margin-top: var(--sp-5); }
.guide-count { color: var(--text3); font: var(--fs-xs) var(--font-num); }
.guide-actions { display: flex; align-items: center; gap: var(--sp-2); }
.guide-foot { margin-top: var(--sp-3); padding-top: var(--sp-3); border-top: 1px solid var(--hairline); color: var(--text3); font-size: var(--fs-xs); text-align: center; }
.guide-done-ico { width: 56px; height: 56px; margin: var(--sp-4) auto var(--sp-2); border-radius: 50%; display: grid; place-items: center; color: var(--accent-sky); background: color-mix(in srgb, var(--accent-sapphire) 16%, var(--surface)); border: 1px solid color-mix(in srgb, var(--accent-sky) 30%, var(--hairline)); }
.guide-catalog h2 { margin: var(--sp-1) 0; font-size: var(--fs-xl); }
@media (max-width: 760px) { .guide-card { width: calc(100vw - var(--sp-4) * 2); max-height: 80vh; padding: var(--sp-4); } }
</style>