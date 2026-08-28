import { createApp } from 'vue';
import App from './App.vue';
import { vFocusTrap } from './directives/focusTrap.js';
import { pinia } from './stores/pinia';
import { router } from './router';
import { installTauriBridge } from './bridge/tauri';
import './styles.css';

// Tauri 环境：注入等价 window.fuBridge（分阶段迁移，未移植 IPC 返回占位）
installTauriBridge();

// Electron 渲染进程桥接（preload 注入 window.fuBridge）；浏览器预览时为空实现
// SideBar 等组件通过 window.fuBridge 直接读取
const app = createApp(App);
app.use(pinia);
app.use(router);
app.directive('focus-trap', vFocusTrap);
app.mount('#app');
