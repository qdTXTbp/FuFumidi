import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';
import { readFileSync } from 'node:fs';

// P0-7：版本/构建时间只在**构建时**注入一次，前端不再各写一份版本号。
//   frontend/package.json 的 version 是唯一来源（发布脚本 npm version 会同步改它）。
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'));

// 构建产物输出到 ../renderer/dist（Electron 主进程从这里加载），
// 开发模式跑 Vite dev server（main.js 通过 FUFUMIDI_DEV_UI=1 加载）。
export default defineConfig({
  base: './',
  plugins: [vue()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL('../renderer/dist', import.meta.url)),
    emptyOutDir: true,
    target: 'es2020',
    rollupOptions: {
      output: {
        manualChunks: {
          vue: ['vue'],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
