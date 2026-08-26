import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

// 构建产物输出到 ../renderer/dist（Electron 主进程从这里加载），
// 开发模式跑 Vite dev server（main.js 通过 FUFUMIDI_DEV_UI=1 加载）。
export default defineConfig({
  base: './',
  plugins: [vue()],
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
