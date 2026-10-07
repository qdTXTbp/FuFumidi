/* 渲染进程里挂到 window 上的**内部钩子**（不是给用户/插件的公开 API）。
 *
 * 为什么要有这份声明：这些钩子是"跨模块的暗号" —— App.vue 挂、audio.js 与 stores 读，
 * 以前没有类型，读的地方一律报 TS2339（实测 6 处）。声明它们既消掉噪音，
 * 也让"谁在用什么全局"变成可 grep 的事实。
 *
 * 约定：新增此类钩子必须写进这里；对外能力一律走 window.fuBridge（见 docs/FOUNDATION.md 第 2 节）。
 */
interface Window {
  /** 曲目播放结束后的自动续播（App.vue 挂，audio.js 与 stores/app.ts 读） */
  __fufumidiAutoNext?: () => void;
  /** 睡眠淡出进行中（true 时音量控制不再覆盖） */
  __fufumidiSleepFade?: boolean;
  /** 淡出前的基准音量（音量滑杆的"用户意图值"） */
  __fufumidiBaseVol?: number;
  /** 验收钩子：仅当 localStorage.fufumidi_debug === '1' 时由各页面挂载 */
  __fufumidiDebug?: any;
  __singDebug?: any;
  __vbDebug?: any;
  __vbPanelDebug?: any;
  /** 变谱页 → 工作台的一次性底图交接（M0 收尾） */
  __fufumidiUnderlay?: string;
}
