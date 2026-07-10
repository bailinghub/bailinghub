import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const hubDevTarget = process.env.VITE_BAILING_HUB_DEV_TARGET || 'http://127.0.0.1:18900';

// 构建产物进 hub 的 web/console/，由中枢静态托管（/console），服务器零构建。
export default defineConfig({
  base: '/console/',
  plugins: [vue()],
  build: {
    outDir: '../web/console',
    emptyOutDir: true,
    chunkSizeWarningLimit: 520,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-vue': ['vue', 'vue-router', 'pinia'],
          'vendor-element': ['element-plus', '@element-plus/icons-vue'],
          'vendor-mammoth': ['mammoth'],
          'vendor-turndown': ['turndown'],
        },
      },
    },
  },
  server: {
    // 本地开发默认代理到本机中枢；如需连远端实例，用 VITE_BAILING_HUB_DEV_TARGET 覆盖。
    proxy: {
      '/admin': { target: hubDevTarget, changeOrigin: true },
      '/kb': { target: hubDevTarget, changeOrigin: true },
      '/health': { target: hubDevTarget, changeOrigin: true },
    },
  },
});
