<script setup>
// 交互式新手引导：欢迎导览 → 章节目录 → 分章节逐步实操。
//
// 为什么是「章节」而不是一条长链：应用现在是 6 个一级功能区（首页/音乐/视图/转译/资源中心/UTAU）
// 下的 15 个子页面，全部功能串起来有 80 多步。一条线性长链既跑不完、也没人愿意跑第二遍；
// 而实际上多数人只需要其中一两块（例如只学转录、或只学编辑）。因此改为：
//   welcome  欢迎导览（8 页，介绍功能区划分与本引导的用法）
//   catalog  章节目录（13 个章节，显示「已学完 / 未学」，可单章学，也可全部依次学）
//   ig       章节内的逐步实操（含上一步 / 下一步 / 跳过此步）
//
// 每一步都尽量指向界面上的真实元素（优先用 data-guide 锚点，其次是稳定的 class/id），
// 并在 L2 自动化里逐步走完全部步骤来保证不存在死链（见 docs/test-reports）。
import { ref, computed, nextTick, onBeforeUnmount } from 'vue';
import { useRoute } from 'vue-router';
import Icon from './Icon.vue';
import { useAppStore } from '../stores/app';
import { t } from '../core/i18n.js';

const app = useAppStore();
const state = app;
const bridge = window.fuBridge;
const route = useRoute();

const PROGRESS_KEY = 'fufumidi_guide_progress';

const WELCOME_STEPS = computed(() => [
  {
    ic: 'play2', title: t('欢迎使用 FuFumidi'),
    body: [
      t('转录、修正、编辑、播放、导出，全部在本机完成，不需要联网。'),
      t('本引导按功能分成 13 个章节，你可以只学需要的章节，之后随时回来继续。'),
    ],
  },
  {
    ic: 'home', title: t('首页：从这里开始'),
    body: [
      t('四张快捷卡片直达音乐 / 视图 / 转译 / 资源中心；「最近曲目」列出最近打开的曲子。'),
      t('「保存工程」会把当前曲目连同速度、循环、每轨音量与声像一起存成 .fufu 文件，下次「打开工程」原样恢复。'),
    ],
  },
  {
    ic: 'music', title: t('音乐：演奏 / 歌词 / 编辑'),
    body: [
      t('演奏页看钢琴卷帘预览与轨道混音；歌词页把歌词对齐到时间轴；编辑页是逐音符精修的主战场。'),
      t('三个页签都作用于当前载入的曲目。'),
    ],
  },
  {
    ic: 'viz', title: t('视图：可视化 / 分析 / 乐谱'),
    body: [
      t('可视化页有音符瀑布、频谱、示波器、实时和弦四块画面，并支持沉浸模式全屏观看。'),
      t('分析页给出调性、速度、音域、和弦与多种分布图；乐谱页可看五线谱 / 简谱 / 六线谱并导出 PDF。'),
    ],
  },
  {
    ic: 'transcribe', title: t('转译：转录 / 转换'),
    body: [
      t('转录页把音频转成 MIDI（通用识别 / 钢琴专用 / 音频处理三种模式，可批量排队）。'),
      t('转换页把 MIDI 导出为 WAV，或渲染成带可视化与字幕的 MP4 视频。'),
    ],
  },
  {
    ic: 'box', title: t('资源中心：模型 / 音色 / 资源管理'),
    body: [
      t('模型管理下载转录与人声分离的权重；音色工坊管理 SF2 音色库；资源管理检查 Python 依赖、GPU 加速与曲库文件。'),
      t('首次使用转录前，建议先到这里把模型与依赖装齐。'),
    ],
  },
  {
    ic: 'utau', title: t('UTAU：音MAD 制作'),
    body: [
      t('声库制作：上传音频自动切分音节、自动标注、导出 oto.ini 音源。'),
      t('曲谱与调声：把 MIDI 音符映射到音节；合成渲染：导出成品音频。'),
    ],
  },
  {
    ic: 'kbd', title: t('快捷键与命令面板'),
    body: [
      t('Space 播放/暂停、L 循环、M 节拍器、I 沉浸模式、Esc 退出沉浸、Ctrl+1~9 切换功能区。'),
      t('Ctrl+K 打开命令面板可直接搜索功能；F1 随时重新打开本引导。完整清单见「设置 → 快捷键」。'),
    ],
  },
]);

/** 一步 = 切到某页（parent + 可选 tab）→ 高亮某个选择器 → 用户看图或动手 */
const CHAPTERS = computed(() => [
  {
    id: 'start', ic: 'play2', name: t('快速上手'), desc: t('导入一首曲子、播放、认识三个区域'),
    steps: [
      { parent: 'home', selector: '[data-guide="quick-music"]', title: t('进入主要功能区'), desc: t('首页四张卡片分别进入音乐 / 视图 / 转译 / 资源中心。点这张卡片试试。'), action: true, validate: () => state.view === 'music' },
      { parent: 'music', tab: 'play', selector: '[data-guide="sidebar-import"]', title: t('导入曲目'), desc: t('点「导入 MIDI」选择文件，也可以直接把 .mid / 音频文件拖进窗口。'), manual: true },
      { parent: 'music', tab: 'play', selector: '.song-list', title: t('曲库列表'), desc: t('导入的曲子都在这里。单击选中、双击直接播放；右键有更多操作。'), manual: true, needSong: true },
      { parent: 'music', tab: 'play', selector: '.tp-play', title: t('播放 / 暂停'), desc: t('按 Space 或点这个按钮播放。播放中切到别的页面不会中断。'), manual: true },
      { parent: 'music', tab: 'play', selector: '#pb-progress', title: t('拖动进度'), desc: t('拖动进度条可跳转；左右方向键是快退 / 快进。'), manual: true },
      { parent: 'home', selector: '[data-guide="topbar-more"]', title: t('顶栏「更多」'), desc: t('这里能快速跳到转录、转换、分析、乐谱、快捷键等常用入口，不用先切到对应功能区。'), manual: true },
    ],
  },
  {
    id: 'library', ic: 'folder', name: t('曲库与歌单'), desc: t('整理、收藏、批量管理'),
    steps: [
      { parent: 'home', selector: '[data-guide="sidebar-views"]', title: t('四个智能视图'), desc: t('全部曲目 / 收藏 / 最近播放 / 最常播放，无需手动维护，按播放记录自动生成。'), manual: true },
      { parent: 'home', selector: '[data-guide="sidebar-playlists"]', title: t('歌单'), desc: t('点「MIDI 歌单」右侧的 ＋ 新建歌单；拖动歌单可调整顺序。'), manual: true },
      { parent: 'home', selector: '.song-item', title: t('曲目右键菜单'), desc: t('右键一首曲目：播放、添加到歌单、收藏、编辑信息、打开所在文件夹、批量管理、从歌单移除、删除（含本地文件）。'), manual: true, needSong: true },
      { parent: 'home', selector: '.song-list', title: t('批量管理'), desc: t('在曲目上右键选「批量管理」进入勾选模式：可全选、批量移到歌单、批量收藏、批量移除或删除。'), manual: true, needSong: true },
      { parent: 'home', selector: '.pl-search', title: t('搜索与整理'), desc: t('搜索框按名称过滤；右侧下拉可按艺术家 / 专辑 / 流派 / 文件夹重新排列列表。'), manual: true },
      { parent: 'home', selector: '.cloud-user', title: t('账号与云同步'), desc: t('左下角可登录账号做云同步；同步开关在「设置 → 云同步」里。'), manual: true },
    ],
  },
  {
    id: 'playback', ic: 'player', name: t('播放与音质'), desc: t('播放栏、节拍器、倍速、混音台、音效'),
    steps: [
      { parent: 'home', selector: '[data-guide="pb-mode"]', title: t('播放模式'), desc: t('顺序 / 随机 / 单曲循环 / 列表循环，点一次换一种。'), manual: true },
      { parent: 'home', selector: '[data-guide="pb-loop"]', title: t('循环区间'), desc: t('开启后只在选区（或整曲）内循环。编辑页还能设置精确的循环起止。'), manual: true },
      { parent: 'home', selector: '[data-guide="pb-metro"]', title: t('节拍器'), desc: t('跟着节拍练习或对拍；关闭后已排队的点击声会立刻取消。'), manual: true },
      { parent: 'home', selector: '#pb-tempo', title: t('播放速度'), desc: t('0.25× ~ 4× 变速播放，适合听清快速段落。加速即加速，与界面方向一致。'), manual: true },
      { parent: 'home', selector: '#pb-volume', title: t('音量'), desc: t('总音量；分轨音量与声像在混音台里调。'), manual: true },
      { parent: 'home', selector: '[data-guide="pb-mixer"]', title: t('打开混音台'), desc: t('点开混音台：每轨独奏 S / 静音 M / 音量 / 声像。点轨道上的音色名可以换音色。'), action: true, needSong: true,
        onEnter: () => { const b = document.querySelector('[data-guide="pb-mixer"]'); if (b && document.querySelector('.mix-track')) b.click(); } },
      { parent: 'home', selector: '.mix-track', title: t('分轨控制与换音色'), desc: t('音色按 MIDI 通道生效：同一通道上的多条轨会一起变；「恢复文件音色」可还原。'), manual: true, needSong: true },
      { parent: 'home', selector: '[data-guide="pb-fx"]', title: t('音效调节'), desc: t('打开音效面板：10 段均衡器、预设、低音增强、空间声（立体声展宽）。'), action: true,
        onEnter: () => { const b = document.querySelector('[data-guide="pb-fx"]'); if (b && document.querySelector('.eq-bands')) b.click(); } },
      { parent: 'home', selector: '.eq-bands', title: t('均衡器与低音增强'), desc: t('先勾选「启用音效」才生效；调节实时听到变化，设置会自动保存。'), manual: true },
      { parent: 'home', selector: '[data-guide="pb-bookmark"]', title: t('书签与睡眠定时'), desc: t('把当前进度存成书签便于来回跳；时钟图标可设置 15/30/60/90 分钟后自动停止播放。'), manual: true, needSong: true },
    ],
  },
  {
    id: 'viz', ic: 'viz', name: t('可视化与沉浸'), desc: t('四块画面 + 全屏沉浸观看'),
    steps: [
      // 先切到仪表盘布局：频谱/示波器/和弦三块画面只在仪表盘布局下渲染，
      // 若当前停在瀑布流布局，后面的三步会找不到目标（用户侧表现为「没找到这一步的目标」）。
      { parent: 'views', tab: 'viz', selector: '[data-guide="viz-modes"]', title: t('仪表盘布局'), desc: t('可视化页有两种布局：仪表盘（四块画面并列）与瀑布流（音符占满全屏）。先切到仪表盘。'), action: true },
      { parent: 'views', tab: 'viz', selector: '#vizRoll', title: t('音符瀑布'), desc: t('下落音符跟随播放滚动；音符越靠近击键线越亮，背景随音乐能量脉动。'), manual: true, needSong: true },
      { parent: 'views', tab: 'viz', selector: '#vizSpectrum', title: t('频谱瀑布'), desc: t('横向频段随时间的能量分布，用来观察高频与低频的起伏。'), manual: true, needSong: true },
      { parent: 'views', tab: 'viz', selector: '#vizScope', title: t('波形示波器'), desc: t('实时波形，可直观看到响度与动态。'), manual: true, needSong: true },
      { parent: 'views', tab: 'viz', selector: '#vizChord', title: t('实时和弦'), desc: t('跟随播放显示当前和弦名，适合边听边核对和声。'), manual: true, needSong: true },
      { parent: 'views', tab: 'viz', selector: '[data-guide="viz-waterfall"]', title: t('瀑布流布局与缩放'), desc: t('切到瀑布流后音符占满整个画面；顶部还能切换配色、缩放可视音域。'), action: true },
      { parent: 'views', tab: 'viz', selector: '[data-guide="viz-immersive"]', title: t('沉浸模式'), desc: t('点「沉浸模式」（或按 I）隐去顶栏、侧栏、播放栏，只剩画面；鼠标静止 3 秒控件自动淡出，按 Esc 退出。'), action: true,
        onEnter: () => { if (state.ui.immersive && typeof state.setImmersive === 'function') state.setImmersive(false); } },
    ],
  },
  {
    id: 'analyze', ic: 'analyze', name: t('数据分析'), desc: t('调性、速度、和弦与各类分布'),
    steps: [
      { parent: 'views', tab: 'analyze', selector: '.stat-grid', title: t('九张统计卡'), desc: t('调性、速度 BPM、拍号、音符总数、音域、最大复音、音符密度、音轨数、时长。'), manual: true, needSong: true },
      { parent: 'views', tab: 'analyze', selector: '.chord-chips', title: t('和弦统计'), desc: t('按小节统计最常用的和弦；点一个和弦会跳到编辑页对应位置。'), manual: true, needSong: true },
      { parent: 'views', tab: 'analyze', selector: '#azPitch', title: t('音高与力度分布'), desc: t('音高分布看音区是否合理，力度分布看演奏力度是否集中；鼠标悬停可读具体数值。'), manual: true, needSong: true },
      { parent: 'views', tab: 'analyze', selector: '#azDensity', title: t('时间线密度'), desc: t('看每个时间段的音符密集程度，用于判断哪里过密或过稀。'), manual: true, needSong: true },
      { parent: 'views', tab: 'analyze', selector: '#azCompare', title: t('音频 / MIDI 对齐对比'), desc: t('载入原音频后可对比识别结果与原始音频的节奏差异。'), manual: true, needSong: true },
    ],
  },
  {
    id: 'score', ic: 'score', name: t('乐谱'), desc: t('四种记谱 + 导出 PDF / PNG'),
    steps: [
      { parent: 'views', tab: 'score', selector: '.score-view', title: t('乐谱视图'), desc: t('自动按音域切换高低音谱号，并用 8va / 8vb / 15ma 避免加线过多。'), manual: true, needSong: true },
      { parent: 'views', tab: 'score', selector: '.score-toolbar', title: t('记谱模式与显示选项'), desc: t('可切换五线谱 / 简谱 / 吉他六线谱 / 贝斯四线谱，并控制简化记谱、自动连线、多轨显示。'), manual: true, needSong: true },
      { parent: 'views', tab: 'score', selector: '#abcScore', title: t('点击乐谱定位播放头'), desc: t('点乐谱上的任意音符即可把播放位置跳过去；开启「跟随播放」后乐谱会自动滚动。'), manual: true, needSong: true },
      { parent: 'views', tab: 'score', selector: '.score-legend', title: t('分屏与图例'), desc: t('可分屏对照查看，图例说明符号含义。'), manual: true, needSong: true },
      { parent: 'views', tab: 'score', selector: '.score-toolbar', title: t('导出乐谱'), desc: t('可导出 MusicXML、PNG（含分页打包）与 PDF；也能导入既有的 MusicXML。'), manual: true, needSong: true },
    ],
  },
  {
    id: 'edit', ic: 'edit', name: t('编辑与修正'), desc: t('钢琴卷帘逐音符精修（功能最多的一章）'),
    steps: [
      { parent: 'music', tab: 'edit', selector: '[data-guide="edit-canvas"]', title: t('钢琴卷帘'), desc: t('框选或点选音符；拖动移动位置，拖边缘改时值，Delete 删除。'), manual: true, needSong: true },
      { parent: 'music', tab: 'edit', selector: '.ed-toolbar-wrap', title: t('工具栏'), desc: t('选择 V / 画笔 B / 橡皮 E / 静音，以及撤销 Ctrl+Z、重做 Ctrl+Y、量化、复制粘贴等。'), manual: true, needSong: true },
      { parent: 'music', tab: 'edit', selector: '[data-guide="velocity-slider"]', title: t('音符检查器'), desc: t('选中音符后在这里精确改音高、力度、起点与长度；也可静音该音符。'), manual: true, needSong: true },
      { parent: 'music', tab: 'edit', selector: '[data-guide="edit-more"]', title: t('打开「更多」面板'), desc: t('常用操作在工具栏，低频但强力的工具收在这个「更多」面板里。点它展开。'), action: true, needSong: true,
        // 「更多」是开关式按钮：若用户上次已经展开过，这次点击反而会收起，后面的步骤就会
        // 「找不到目标」。所以进这步前先把它归位到关闭态，让点击的结果是确定的。
        onEnter: () => { if (document.querySelector('.ed-adv') && document.querySelector('[data-guide="edit-more"]')) document.querySelector('[data-guide="edit-more"]').click(); } },
      { parent: 'music', tab: 'edit', selector: '.ed-adv', title: t('高级工具面板'), desc: t('这里集中了：力度（渐强 / 渐弱 / 曲线 / 删短音 / 响度）、量化（网格 + Groove 模板，可提取自定义 Groove）、移调、音阶与调内编辑、和弦批量选择、BPM、智能伴奏、逻辑编辑器与宏、CC 泳道与踏板，以及原音频 / 视频对齐。'), manual: true, needSong: true },
      { parent: 'music', tab: 'edit', selector: '[data-guide="edit-chord-analyze"]', title: t('生成和弦轨'), desc: t('点「分析和弦」按小节识别和弦，卷帘下方会出现和弦轨（识别需要一点时间，稍等即可）。'), action: true, needSong: true },
      { parent: 'music', tab: 'edit', selector: '.chord-lane', title: t('和弦轨'), desc: t('和弦显示在卷帘下方，点任一小节可手改（如 C / Am7 / G7/B，留空恢复自动识别）。'), manual: true, needSong: true },
      { parent: 'music', tab: 'edit', selector: '.ed-insp', title: t('轨道音色与网格'), desc: t('同一面板下方还有：轨道选择与 GM 音色（含收藏 / 应用到全部非鼓轨 / 智能选音色），以及吸附值、音符着色方案、新建音符的默认力度。'), manual: true, needSong: true },
      { parent: 'music', tab: 'edit', selector: '.ed-mini', title: t('迷你图与缩放'), desc: t('底部迷你图显示整曲概览，点一下即跳转；可缩放或适应全曲。快捷键：Ctrl+滚轮缩放、Shift+滚轮横向平移、Alt+拖拽调力度。'), manual: true, needSong: true },
    ],
  },
  {
    id: 'lyrics', ic: 'music', name: t('歌词'), desc: t('对齐时间轴、批量处理、导出字幕'),
    steps: [
      { parent: 'music', tab: 'lyrics', selector: '.lyr-toolbar', title: t('歌词工具条'), desc: t('添加歌词、导入文本、批量替换、添加到所选音符、逐字拆分。'), manual: true, needSong: true },
      { parent: 'music', tab: 'lyrics', selector: '.lyr-timeline', title: t('时间轴对齐'), desc: t('像钢琴卷帘一样拖动歌词块对齐：Shift 吸附音符、Ctrl 吸附网格。'), manual: true, needSong: true },
      { parent: 'music', tab: 'lyrics', selector: '.lyr-list', title: t('逐行编辑'), desc: t('每行可改时间码与文本，也可单独保存或删除。'), manual: true, needSong: true },
      { parent: 'music', tab: 'lyrics', selector: '.lyr-toolbar', title: t('样式与卡拉OK'), desc: t('可调字号、颜色、描边、阴影，并开启逐字卡拉OK高亮。'), manual: true, needSong: true },
      { parent: 'music', tab: 'lyrics', selector: '.lyr-toolbar', title: t('导出字幕'), desc: t('可导出 LRC / SRT / TXT，配合视频导出使用。'), manual: true, needSong: true },
    ],
  },
  {
    id: 'transcribe', ic: 'transcribe', name: t('转录：音频转 MIDI'), desc: t('三种引擎、批量队列、参数与修正'),
    steps: [
      { parent: 'transcode', tab: 'transcribe', selector: '[data-guide="audio-drop"]', title: t('导入音频'), desc: t('拖入或点击选择 MP3 / WAV / FLAC / M4A 等；可一次选多个文件排队。'), manual: true },
      { parent: 'transcode', tab: 'transcribe', selector: '[data-guide="mode-universal"]', title: t('三种转录模式'), desc: t('通用识别适合任意歌曲；钢琴专用适合纯钢琴；音频处理先做人声分离再分别处理。'), manual: true },
      { parent: 'transcode', tab: 'transcribe', selector: '[data-guide="adv-panel"]', title: t('性能档位'), desc: t('最高质量 / 均衡 / 高性能。有独显时会推荐更快的档位，档位越高越慢但越细腻。'), manual: true },
      { parent: 'transcode', tab: 'transcribe', selector: '[data-guide="adv-panel"]', title: t('参数预设与任务模板'), desc: t('内置多套预设（钢琴快速琶音、人声主旋律、吉他拨弦等），也可保存自己的参数与任务模板。'), manual: true },
      { parent: 'transcode', tab: 'transcribe', selector: '[data-guide="adv-panel"]', title: t('高级参数'), desc: t('展开后可调阈值、最短音符、合并间隔、踏板、降噪、响度平衡、自动 BPM，以及低音增强。'), manual: true },
      { parent: 'transcode', tab: 'transcribe', selector: '[data-guide="start-transcribe"]', title: t('开始转录'), desc: t('点「开始转录」，全程本机离线运行，可在下方看到进度与日志。'), manual: true },
      { parent: 'transcode', tab: 'transcribe', selector: '.tr-adv', title: t('队列与中断控制'), desc: t('多文件队列可暂停 / 取消 / 重试 / 清空；转录出的 MIDI 会直接进入曲库。'), manual: true },
      { parent: 'transcode', tab: 'transcribe', selector: '[data-guide="adv-panel"]', title: t('智能修正'), desc: t('对识别结果做起音对齐、尾音修正、音高修正、清理微音符、力度与声部平衡，可载入修正结果。'), manual: true },
    ],
  },
  {
    id: 'convert', ic: 'convert', name: t('导出与转换'), desc: t('WAV 音频与可视化视频'),
    steps: [
      { parent: 'transcode', tab: 'convert', selector: '.convert-view', title: t('转换页'), desc: t('这里能把 MIDI 导出为音频，或渲染成带可视化与字幕的视频。'), manual: true },
      { parent: 'transcode', tab: 'convert', selector: '.conv-est', title: t('输出预估'), desc: t('导出前会估算文件大小与时长，避免渲染完才发现太大。'), manual: true, needSong: true },
      { parent: 'transcode', tab: 'convert', selector: '.conv-info-bar', title: t('音色风格与格式'), desc: t('内置 28 套音色风格；可选速度、采样率、渲染范围与输出音量。'), manual: true, needSong: true },
      { parent: 'transcode', tab: 'convert', selector: '.ve-preview-canvas', title: t('视频实时预览'), desc: t('导出前可实时预览画面：模板（仪表盘 / 瀑布流）、比例（16:9 / 9:16）、分辨率、帧率、质量。'), manual: true, needSong: true },
      { parent: 'transcode', tab: 'convert', selector: '.ve-opts', title: t('叠加项'), desc: t('可选择叠加进度条、实时和弦、时间码、歌词字幕与水印（可调透明度），也能设置背景色或背景图。'), manual: true, needSong: true },
      { parent: 'transcode', tab: 'convert', selector: '.convert-view', title: t('导出'), desc: t('「渲染并导出 WAV」出音频；「导出视频 MP4」出视频（环境中不支持时自动回退 WebM）。'), manual: true, needSong: true },
    ],
  },
  {
    id: 'resources', ic: 'box', name: t('资源中心'), desc: t('模型、音色库、依赖与 GPU'),
    steps: [
      { parent: 'resources', tab: 'model', selector: '.vm-tabs', title: t('模型管理'), desc: t('转录模型 / 人声分离 / 修复·VR 三类权重；卡片显示是否已安装、大小与最佳标记。'), manual: true },
      { parent: 'resources', tab: 'model', selector: '.vm-grid', title: t('下载与删除模型'), desc: t('点卡片查看详情后下载，可看进度与速度；装完新模型记得去「资源管理」补依赖。'), manual: true },
      { parent: 'resources', tab: 'model', selector: '[data-guide="vm-download-settings"]', title: t('下载渠道与 Token'), desc: t('下载设置里可选 HuggingFace 官方或 hf-mirror 镜像；下载需授权的模型时需要先填 Token，也能导入本地模型压缩包。'), manual: true },
      { parent: 'resources', tab: 'soundfonts', selector: '.sf-grid', title: t('音色工坊：内置精选音色'), desc: t('试听后可下载启用某个 SF2 音色库；「使用默认合成器」可切回内置音色。'), manual: true },
      { parent: 'resources', tab: 'soundfonts', selector: '.sf-card', title: t('当前音色与自定义导入'), desc: t('顶部显示当前使用的音色；「导入 .sf2 音色」可加入自己的音色并在「我的音色」中启用。'), manual: true },
      { parent: 'resources', tab: 'resources', selector: '.res-sec', title: t('资源管理：依赖与 GPU'), desc: t('检查并补全 Python 依赖与模型运行时；有独显时可在这里查看并安装 GPU 加速包。'), manual: true },
      { parent: 'resources', tab: 'resources', selector: '.res-sec', title: t('曲库体检与诊断'), desc: t('可做曲库文件体检、检测重复文件、清理无主文件；「导出诊断包」便于排查问题，配置也能导出 / 导入。'), manual: true },
    ],
  },
  {
    id: 'utau', ic: 'utau', name: t('UTAU 音MAD'), desc: t('声库制作 → 调声 → 合成渲染'),
    steps: [
      { parent: 'utau', selector: '[data-guide="utau-tab-voicebank"]', title: t('声库制作'), desc: t('三步走的起点：先做出声库，再调声，最后合成渲染。三个页签在这里切换。'), manual: true,
        // 页签是「记忆」的：上一轮停在哪个页签，重新进入这一章就还停在哪儿，而后面的步骤
        // 全都长在声库页签上。这里先把它切回声库页签（已经在该页签时点击是空操作），
        // 免得用户按着引导走却看不到下一步要讲的东西。
        onEnter: () => { const b = document.querySelector('[data-guide="utau-tab-voicebank"]'); if (b) b.click(); } },
      { parent: 'utau', selector: '.vb-toolbar', title: t('上传音频或录音'), desc: t('点「上传音频切分」选一个音源文件，也可以直接用麦克风录音。这是后面几步的前提。'), manual: true },
      { parent: 'utau', selector: '.vb-params', title: t('切分参数'), desc: t('按最小静音 / 最小音节 / 静音阈值自动切分；参数改动后可点「重新切分」。'), manual: true },
      { parent: 'utau', selector: '.vb-segs', title: t('片段列表与波形编辑器'), desc: t('切好后每个音节一块：点选后右侧出现波形，拖动 offset / overlap / preutterance / consonant / blank 五个标记校准边界。'), manual: true, requires: 'audio' },
      { parent: 'utau', selector: '.vb-head-actions', title: t('自动标注与导出音源'), desc: t('「自动标注全部」批量填好 oto 参数；「导出音源」生成 oto.ini 与 wav 目录，或「导出压缩包」一次打包。'), manual: true, requires: 'audio' },
      { parent: 'utau', selector: '[data-guide="utau-tab-score"]', title: t('曲谱与调声'), desc: t('左侧调声、右侧曲谱同屏：把 MIDI 音符映射到音节，逐音调整音高与时长。'), action: true },
      { parent: 'utau', selector: '[data-guide="utau-tab-render"]', title: t('合成渲染'), desc: t('按当前声库与调声结果合成音频并导出成品。'), action: true },
    ],
  },
  {
    id: 'settings', ic: 'palette', name: t('设置与个性化'), desc: t('外观、语言、快捷键与维护'),
    steps: [
      { parent: 'home', selector: '[data-guide="topbar-settings"]', title: t('打开设置'), desc: t('顶栏齿轮图标打开设置，也可用 Ctrl+K 搜索「设置」。'), action: true, validate: () => !!state.ui.settingsOpen, onEnter: () => { state.ui.settingsOpen = false; } },
      { parent: 'home', selector: '.ov-tab', title: t('设置分页'), desc: t('外观 / GPU / 功能 / 快捷键 / 插件 / 云同步 / 更新，共七页。'), manual: true, onEnter: () => { state.ui.settingsOpen = true; } },
      { parent: 'home', selector: '.ov-tab', title: t('外观与主题库'), desc: t('在「外观」页切换界面主题、强调色、字号与紧凑度；「主题库」里有更多配色方案。'), manual: true, onEnter: () => { state.ui.settingsOpen = true; } },
      { parent: 'home', selector: '.ov-tab', title: t('语言切换'), desc: t('支持简体中文 / 繁體中文 / English / 日本語，切换后立即生效。'), manual: true, onEnter: () => { state.ui.settingsOpen = true; } },
      { parent: 'home', selector: '.ov-tab', title: t('快捷键一览'), desc: t('「快捷键」页列出全部快捷键，并可将自定义的键位恢复默认。'), manual: true, onEnter: () => { state.ui.settingsOpen = true; } },
      { parent: 'home', selector: '.ov-tab', title: t('功能与维护'), desc: t('「功能」页可设置默认输出目录、MIDI 文件关联、清理失效曲目等维护操作；「插件」页管理扩展。'), manual: true, onEnter: () => { state.ui.settingsOpen = true; } },
      { parent: 'home', selector: '.tab[data-view="views"]', title: t('完成，收工'), desc: t('你已经走完 FuFumidi 的全部功能分区（共 13 章）。随时按 F1 重新打开本引导，或从首页「新手引导」卡片进入，按需重学某一章。'), manual: true, onEnter: () => { state.ui.settingsOpen = false; } },
    ],
  },
]);

const TOTAL_STEPS = computed(() => CHAPTERS.value.reduce((a, c) => a + c.steps.length, 0));

// 已学完的章节（localStorage 持久化，跨启动保留）
const progress = ref(loadProgress());
function loadProgress() {
  try { return JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}') || {}; } catch (e) { return {}; }
}
function saveProgress() {
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress.value)); } catch (e) {}
}
const doneCount = computed(() => Object.keys(progress.value).filter((k) => progress.value[k]).length);

const mode = ref('welcome');            // welcome | catalog | ig
const welcomeIdx = ref(0);
const chapterIdx = ref(0);              // 当前章节在 CHAPTERS 中的下标
const stepIdx = ref(0);
const runAll = ref(false);              // 「全部依次学习」
const missing = ref(false);             // 当前步骤的目标没找到（如实提示，不再静默跳过）

const igEl = ref(null);
const highlightStyle = ref({});
const cardStyle = ref({});
let pollTimer = null;
let retryTimer = null;
let scrollHandler = null;
let actionOff = null;
let missingTimer = null;

const isLastWelcome = computed(() => welcomeIdx.value >= WELCOME_STEPS.value.length - 1);
const welcomeStep = computed(() => WELCOME_STEPS.value[welcomeIdx.value]);
const chapter = computed(() => CHAPTERS.value[chapterIdx.value] || null);
const igStep = computed(() => (chapter.value ? chapter.value.steps[stepIdx.value] : null));
// 目标找不到时给出**具体**原因：这一步依赖曲库里有曲目、或依赖先上传音频素材，
// 而不是笼统地说「可能功能变了」——那会让人以为是缺陷。
const missingHint = computed(() => {
  const st = igStep.value;
  if (!st) return '';
  if (st.requires === 'audio') return t('没找到这一步的目标：请先在「声库制作」上传音频或录音并完成切分，再点「重试」。');
  if (st.needSong) return t('没找到这一步的目标：请先在左侧曲库选中一首曲目，再点「重试」。');
  return t('没找到这一步的目标：可能该功能在当前版本已调整。可点「跳过此步」继续。');
});

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

/* ---------------- 欢迎导览 ---------------- */
function goWelcomePrev() { if (welcomeIdx.value > 0) welcomeIdx.value--; }
function goWelcomeNext() {
  if (isLastWelcome.value) { mode.value = 'catalog'; }
  else welcomeIdx.value++;
}
function goCatalog() { cleanupIg(); mode.value = 'catalog'; }

/* ---------------- 章节目录 ---------------- */
function startChapter(i, all = false) {
  chapterIdx.value = i;
  stepIdx.value = 0;
  runAll.value = all;
  mode.value = 'ig';
  nextTick(renderIg);
}

/* ---------------- 实操引擎 ---------------- */
function cleanupIg() {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  if (missingTimer) { clearTimeout(missingTimer); missingTimer = null; }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (scrollHandler) { window.removeEventListener('scroll', scrollHandler, true); window.removeEventListener('resize', scrollHandler); scrollHandler = null; }
  if (actionOff) { actionOff(); actionOff = null; }
  if (igEl.value) { try { igEl.value.classList.remove('ig-target'); } catch (e) {} igEl.value = null; }
  missing.value = false;
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

function attachIg(el, st) {
  igEl.value = el;
  el.classList.add('ig-target');
  scrollHandler = () => updateHighlight();
  window.addEventListener('scroll', scrollHandler, true);
  window.addEventListener('resize', scrollHandler);
  try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' }); } catch (e) {}
  setTimeout(updateHighlight, 250);
  updateHighlight();
  if (st.action) {
    const handler = () => {
      // 延迟一拍再校验：Vue 的类名/状态更新是异步的，同步校验会读到旧状态
      setTimeout(() => { if (st.validate ? st.validate(el) : true) igNext(); }, 80);
    };
    el.addEventListener('click', handler);
    actionOff = () => el.removeEventListener('click', handler);
  } else if (st.waitFor) {
    pollTimer = setInterval(() => { if (st.waitFor()) igNext(); }, 300);
  }
}

/** 把页面切到该步所属的页（parent + 可选 tab）。返回 false 表示正在切换、需要重试 */
function gotoStepView(st) {
  if (!st.parent) return true;
  const wantTab = st.tab || '';
  const curTab = String(route.query.tab || '');
  if (state.view === st.parent && (!wantTab || curTab === wantTab)) return true;
  // 直接用父视图 + 显式 tab 写 hash：不能用 setView(子视图 id)，因为
  // resources 的 model / soundfonts 不是子视图（viewParentOf 会把它们判成 home）
  state.view = st.parent;
  app.syncHash(wantTab);
  return false;
}

function renderIg() {
  cleanupIg();
  const st = igStep.value;
  if (!st) { finishChapter(); return; }
  if (!gotoStepView(st)) {
    // 等路由与懒加载视图就位后重试
    retryTimer = setTimeout(renderIg, 90);
    return;
  }
  if (st.onEnter) { try { st.onEnter(); } catch (e) {} }
  const started = Date.now();
  const tryFind = () => {
    const el = typeof st.selector === 'string' ? document.querySelector(st.selector) : null;
    if (el) {
      // 换页/弹窗过渡期可能出现两个同名元素，取可见的那个，避免高亮落在隐藏节点上
      const vis = [...document.querySelectorAll(st.selector)].find((n) => n.getBoundingClientRect().width > 0);
      attachIg(vis || el, st);
      return;
    }
    if (Date.now() - started < 6000) {
      retryTimer = setTimeout(tryFind, 100);
      return;
    }
    // 不再静默跳过：把「没找到」如实显示出来，并给出可操作的两个出口。
    // 最常见的两种原因：目标需要先载入曲目，或该功能在当前版本被隐藏。
    missing.value = true;
    console.warn('[guide] target missing:', st.selector);
  };
  retryTimer = setTimeout(tryFind, 60);
}

function igNext() {
  const c = chapter.value;
  if (!c) { finishChapter(); return; }
  if (stepIdx.value >= c.steps.length - 1) { finishChapter(); return; }
  stepIdx.value++;
  nextTick(renderIg);
}
function igPrev() {
  if (stepIdx.value <= 0) return;
  stepIdx.value--;
  nextTick(renderIg);
}

/** 本章结束：记进度 → 全部依次学时自动进入下一章，否则回目录 */
function finishChapter() {
  const c = chapter.value;
  if (c) { progress.value[c.id] = true; saveProgress(); }
  const next = chapterIdx.value + 1;
  if (runAll.value && next < CHAPTERS.value.length) {
    app.toast(t('本章完成，继续下一章'), 'ok');
    startChapter(next, true);
    return;
  }
  cleanupIg();
  mode.value = 'catalog';
  app.toast(runAll.value ? t('恭喜！你已完成全部章节') : t('本章已学完'), 'ok');
  runAll.value = false;
}
function restartChapter() { stepIdx.value = 0; nextTick(renderIg); }

/* 欢迎页插画装饰 */
const notes = ['♪', '♫', '♩', '♬'];

onBeforeUnmount(cleanupIg);

// 诊断钩子（与 window.__fufumidiVizEnergy 同类）：供 L2 自动化逐步走完全部章节，
// 保证每一步的选择器都能解析到真实元素、不存在死链。只读，不改变行为。
if (typeof window !== 'undefined') {
  window.__fufumidiGuide = {
    chapters: () => CHAPTERS.value.map((c) => ({ id: c.id, name: c.name, steps: c.steps.map((s) => ({ selector: s.selector, title: s.title, action: !!s.action, parent: s.parent, tab: s.tab || '', needSong: !!s.needSong, requires: s.requires || '' })) })),
    state: () => ({
      mode: mode.value, chapterIdx: chapterIdx.value, stepIdx: stepIdx.value,
      chapterId: chapter.value ? chapter.value.id : null,
      selector: igStep.value ? igStep.value.selector : null,
      action: igStep.value ? !!igStep.value.action : false,
      missing: missing.value,
    }),
    open: () => { mode.value = 'catalog'; },
    start: (i) => startChapter(i, false),
  };
}
</script>

<template>
  <div class="overlay guide-overlay" v-focus-trap role="dialog" aria-modal="true" :aria-label="t('新手引导')" @click.self="skip" @keydown.esc="skip">
    <!-- 1. 欢迎导览 -->
    <div v-if="mode === 'welcome'" class="guide-card">
      <div class="guide-head">
        <span class="guide-count">{{ t('新手引导') }}</span>
        <button class="icon-btn" :title="t('关闭')" :aria-label="t('关闭')" @click="skip"><Icon name="plus" :size="16" style="transform:rotate(45deg)" /></button>
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
        <button class="guide-btn primary" @click="goWelcomeNext">{{ isLastWelcome ? t('选择要学的章节') : t('下一步') }}</button>
      </div>
    </div>

    <!-- 2. 章节目录 -->
    <div v-else-if="mode === 'catalog'" class="guide-card guide-catalog">
      <div class="guide-head">
        <span class="guide-count">{{ t('选择章节') }}</span>
        <span class="cat-progress">{{ t('已学完 ') }}{{ doneCount }} / {{ CHAPTERS.length }}</span>
        <button class="icon-btn" :title="t('关闭')" :aria-label="t('关闭')" @click="skip"><Icon name="plus" :size="16" style="transform:rotate(45deg)" /></button>
      </div>
      <p class="cat-intro">{{ t('共 13 个章节、') }}{{ TOTAL_STEPS }}{{ t(' 步，可只学需要的章节，进度会自动保存。') }}</p>
      <div class="cat-list">
        <button v-for="(c, i) in CHAPTERS" :key="c.id" class="cat-item" :class="{ done: progress[c.id] }" @click="startChapter(i)">
          <span class="ci-ic"><Icon :name="c.ic" :size="16" /></span>
          <span class="ci-main">
            <b>{{ c.name }}</b>
            <small>{{ c.desc }}</small>
          </span>
          <span class="ci-meta">
            <em v-if="progress[c.id]" class="ci-done">{{ t('已学完') }}</em>
            <em v-else>{{ c.steps.length }}{{ t(' 步') }}</em>
          </span>
        </button>
      </div>
      <div class="guide-foot">
        <button class="guide-btn ghost" @click="goCatalog(); welcomeIdx = 0; mode = 'welcome'">{{ t('重看欢迎导览') }}</button>
        <button class="guide-btn primary" @click="startChapter(0, true)">{{ t('全部依次学习') }}</button>
      </div>
    </div>

    <!-- 3. 章节内实操 -->
    <template v-else>
      <div class="ig-highlight" :style="highlightStyle"></div>
      <div class="ig-card" :style="cardStyle">
        <div class="ig-head">
          <b>{{ igStep ? igStep.title : t('完成') }}</b>
          <span class="ig-count">{{ chapter ? chapter.name : '' }} · {{ stepIdx + 1 }} / {{ chapter ? chapter.steps.length : 0 }}</span>
        </div>
        <p class="ig-desc">{{ igStep ? igStep.desc : '' }}</p>
        <p v-if="missing" class="ig-missing">{{ missingHint }}</p>
        <div class="ig-foot">
          <button class="guide-btn ghost" @click="skip">{{ t('退出引导') }}</button>
          <button class="guide-btn ghost" @click="igPrev" :style="{ visibility: stepIdx ? 'visible' : 'hidden' }">{{ t('上一步') }}</button>
          <button v-if="missing" class="guide-btn ghost" @click="renderIg">{{ t('重试') }}</button>
          <button class="guide-btn primary" @click="igNext">{{ missing ? t('跳过此步') : (igStep && igStep.action ? t('点高亮处继续') : t('下一步')) }}</button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.guide-art {
  position: relative;
  flex: none;
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
.guide-dots { display: flex; gap: 6px; margin-top: 14px; flex: none; }
.guide-dots i { width:8px; height:8px; border-radius:50%; background: var(--hairline); transition:.2s; }
.guide-dots i.on { background: var(--accent); transform: scale(1.25); }
.guide-overlay { background: rgba(6,10,16,.58); backdrop-filter: blur(2px); pointer-events: none; }
/* 交互式实操：挖洞遮罩由 .ig-highlight 的 999px box-shadow 负责，
   容器自身不再叠加磨砂/变暗——否则虚线框内的目标会被二次模糊与压暗
   （.overlay 基线的 backdrop-filter: blur(2px) 会穿透到洞内内容） */
.guide-overlay:has(.ig-highlight) { background: transparent; backdrop-filter: none; }
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
.ig-missing { margin: 0 0 10px; font-size: 12px; line-height: 1.6; color: var(--ink); background: color-mix(in srgb, var(--accent) 10%, transparent); border-left: 3px solid var(--accent); border-radius: 6px; padding: 7px 9px; }
.ig-foot { display: flex; justify-content: flex-end; gap: 6px; flex-wrap: wrap; }

/* 章节目录 */
.guide-catalog { width: 480px; max-width: 94vw; }
.cat-progress { margin-left: auto; margin-right: 8px; font-size: 11px; color: var(--stone); white-space: nowrap; }
.cat-intro { margin: 2px 0 12px; font-size: 12.5px; line-height: 1.6; color: var(--steel); }
.cat-list { display: flex; flex-direction: column; gap: 6px; max-height: 46vh; overflow-y: auto; padding-right: 2px; margin-bottom: 14px; }
.cat-item {
  display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
  padding: 9px 11px; border: 1px solid var(--hairline); border-radius: 10px;
  background: var(--surface); cursor: pointer; transition: .15s;
}
.cat-item:hover { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 6%, var(--surface)); }
.cat-item.done { opacity: .78; }
.ci-ic { flex: none; width: 26px; height: 26px; display: grid; place-items: center; border-radius: 8px; background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent); }
.ci-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.ci-main b { font-size: 13px; color: var(--ink); }
.ci-main small { font-size: 11.5px; color: var(--steel); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ci-meta { flex: none; font-size: 11px; color: var(--stone); }
.ci-meta em { font-style: normal; }
.ci-done { color: var(--accent); font-weight: 600; }
</style>