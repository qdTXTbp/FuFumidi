// Vue Router：视图哈希路由（Electron file:// 下使用 hash 历史）
import { createRouter, createWebHashHistory, RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/home' },
  { path: '/home', name: 'home', component: () => import('./views/ViewHome.vue') },
  { path: '/play', name: 'play', component: () => import('./views/ViewPlay.vue') },
  { path: '/lyrics', name: 'lyrics', component: () => import('./views/ViewLyrics.vue') },
  { path: '/edit', name: 'edit', component: () => import('./views/ViewEdit.vue') },
  { path: '/viz', name: 'viz', component: () => import('./views/ViewViz.vue') },
  { path: '/analyze', name: 'analyze', component: () => import('./views/ViewAnalyze.vue') },
  { path: '/score', name: 'score', component: () => import('./views/ViewScore.vue') },
  { path: '/transcribe', name: 'transcribe', component: () => import('./views/ViewTranscribe.vue') },
  { path: '/convert', name: 'convert', component: () => import('./views/ViewConvert.vue') },
  { path: '/music', name: 'music', component: () => import('./views/ViewMusic.vue') },
  { path: '/views', name: 'views', component: () => import('./views/ViewViews.vue') },
  { path: '/transcode', name: 'transcode', component: () => import('./views/ViewTranscode.vue') },
  { path: '/resources', name: 'resources', component: () => import('./views/ViewResources.vue') },
  { path: '/models', redirect: { path: '/resources', query: { tab: 'model' } } },
  { path: '/soundfonts', redirect: { path: '/resources', query: { tab: 'soundfonts' } } },
  // 调教：编辑器（选歌手 / 画音符 / 渲染）与声库（做 / 装 / 管）同页两页签。
  { path: '/singer', name: 'singer', component: () => import('./views/ViewSing.vue') },
  // 插件中心：应用内浏览/安装官方平台上的插件（不唤起浏览器）
  { path: '/plugins', name: 'plugins', component: () => import('./views/PluginCenter.vue') },
  // 声库原为独立页，已并入「调教」；旧地址保留为重定向，老书签 / 外部链接继续可用。
  { path: '/banks', redirect: { path: '/singer', query: { tab: 'banks' } } },
  // 声库制作（上传音频切分 / 录音 / oto 标注 / 导出声库）：
  // ★ 组件 ViewVoicebank.vue 一直都在，但合并板块后**没有任何路由指向它** ——
  //   调教页「UTAU 声库制作」的按钮又错接到了「下载声库」的列表上，于是功能看起来"缺失"。
  { path: '/voicebank', name: 'voicebank', component: () => import('./views/ViewVoicebank.vue') },
  // UTAU 与 DiffSinger 早已合并为同一板块：旧地址重定向过去并带上对应引擎
  { path: '/utau', redirect: { path: '/singer', query: { tab: 'editor' } } },
  { path: '/diffsinger', redirect: { path: '/singer', query: { tab: 'editor' } } },
  { path: '/:pathMatch(.*)*', redirect: '/home' },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});

export function viewFromPath(path: string): string {
  const seg = path.replace(/^\/+/, '').split('/')[0] || 'home';
  return seg;
}

export default router;
