import { createApp } from 'vue';
import App from './App.vue';
import { vFocusTrap } from './directives/focusTrap.js';
import { pinia } from './stores/pinia';
import { router, prefetchHeavyViews } from './router';
import { installTauriBridge } from './bridge/tauri';
// ★ token 层必须在 styles.css **之前**：深色映射用属性选择器覆盖 :root，靠的就是后加载 + 更高优先级
import './styles/tokens.css';
import './styles.css';
// ★ 字体覆盖层必须在 styles.css **之后**：styles.css 自己定义了 --mono 与 body 的 font-family，
//   同优先级下后加载者赢（详见文件头注释里的实测记录）
import './styles/typography.css';
// ★ 控件契约层最后加载：它定义 9 类控件的形状（.fu-ctl/.fu-field/.fu-chip…），
//   视图里只保留语义偏差。详见 docs/DESIGN.md 第 3.5 节。
import './styles/controls.css';
// 品牌层：只做皮肤，不改变布局与业务逻辑
import './styles/brand.css';

/* 主题：深色主导（设计语言决定），浅色可选。
   ★ 必须走应用自己的键：theme.js 用 'fufumidi_theme' 存**主题 ID**、'fufumidi_mode' 存明暗模式。
     之前误用 'fufumidi_theme' 存 'dark'，等于把用户的主题选择覆盖成非法值（已修）。
   这里只在**用户从未选过**时把默认模式设成 dark，之后一律尊重用户选择（含跟随系统 'auto'）。 */
try {
  if (!localStorage.getItem('fufumidi_mode')) localStorage.setItem('fufumidi_mode', 'dark');
} catch (e) { /* 隐私模式：交给 theme.js 的默认值 */ }

// Tauri 环境：注入等价 window.fuBridge（分阶段迁移，未移植 IPC 返回占位）
installTauriBridge();

// Electron 渲染进程桥接（preload 注入 window.fuBridge）；浏览器预览时为空实现
// SideBar 等组件通过 window.fuBridge 直接读取
const app = createApp(App);
app.use(pinia);
app.use(router);
app.directive('focus-trap', vFocusTrap);
app.mount('#app');

/* 首屏已经可交互了，剩下的带宽/解析余量拿去预热重视图（见 router.ts 的注释）。
   实测收益：安装版「调教」页首次进入从 2586ms 降到百毫秒级 —— 用户点过去时分包已经在了。 */
prefetchHeavyViews();
