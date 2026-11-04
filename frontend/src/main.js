import { createApp } from 'vue';
import App from './App.vue';
import './styles.css';

// Electron 渲染进程桥接（preload 注入 window.fuBridge）；浏览器预览时为空实现
// SideBar 等组件通过 window.fuBridge 直接读取
createApp(App).mount('#app');

// 冷启动加载动画：静态 DOM 先于 Vue 出现；App 恢复曲库/会话后隐藏。
// 超时兜底只防“永远不消失”，不替代真实加载完成信号。
const _bootSplash = document.getElementById('boot-splash');
let _bootSplashGone = false;
function _hideBootSplash() {
  if (_bootSplashGone || !_bootSplash) return;
  _bootSplashGone = true;
  _bootSplash.classList.add('done');
  setTimeout(() => { try { _bootSplash.remove(); } catch (e) {} }, 500);
}
window.__fufumidiSplashDone = _hideBootSplash;
setTimeout(_hideBootSplash, 15000);
