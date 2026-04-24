import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

function normalizeBasePath(path: string | undefined) {
  if (!path || path === '/') {
    return '/';
  }

  const withLeadingSlash = path.startsWith('/') ? path : `/${path}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '');

  return {
    base: normalizeBasePath(env.VITE_APP_BASE_PATH),
    plugins: [react()],
    build: {
      chunkSizeWarningLimit: 1500,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) {
              return;
            }
            if (id.includes('echarts')) {
              return 'vendor-echarts';
            }
            if (
              id.includes('antd') ||
              id.includes('@ant-design') ||
              id.includes('rc-') ||
              id.includes('@ctrl')
            ) {
              return 'vendor-antd';
            }
          },
        },
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: './src/test/setup.ts',
      css: true,
      globals: true,
    },
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:4300',
          changeOrigin: true,
        },
      },
    },
  };
});
