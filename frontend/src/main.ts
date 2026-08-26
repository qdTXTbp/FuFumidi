import { createApp } from 'vue';
import App from './App.vue';
import { pinia } from './stores/pinia';
import { router } from './router';
import './styles.css';

// Electron 渲染进程桥接（preload 注入 window.fuBridge）；浏览器预览时为空实现
// SideBar 等组件通过 window.fuBridge 直接读取
const app = createApp(App);
app.use(pinia);
app.use(router);
app.mount('#app');
