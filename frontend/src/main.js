import { createApp } from 'vue';
import App from './App.vue';
import './styles.css';

// Electron 渲染进程桥接（preload 注入 window.fuBridge）；浏览器预览时为空实现
// SideBar 等组件通过 window.fuBridge 直接读取
const app = createApp(App);
app.mount('#app');
// 首屏落定后空闲预取最常切的四个分包；点导航时不再等 chunk 下载/解析。
// 不预取编辑页这类大包，避免抢首屏和低内存机器的资源。
const idle = (cb) => (typeof window.requestIdleCallback === 'function'
  ? window.requestIdleCallback(cb, { timeout: 1500 })
  : setTimeout(cb, 1200));
idle(() => {
  void import('./views/ViewMusic.vue');
  void import('./views/ViewConvert.vue');
  void import('./views/ViewViz.vue');
  void import('./views/ViewTranscode.vue');
});
