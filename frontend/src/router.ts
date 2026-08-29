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
  { path: '/resources', name: 'resources', component: () => import('./views/ViewResources.vue') },
  { path: '/utau', name: 'utau', component: () => import('./views/ViewUtau.vue') },
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
