import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiPort = Number(env.PORT || 8787);
  return {
    plugins: [react()],
    // Only VITE_* vars could ever reach the browser; OFSD defines none, so keys stay server-side.
    envPrefix: 'VITE_',
    server: {
      port: 5173,
      open: true,
      proxy: { '/api': { target: `http://localhost:${apiPort}`, changeOrigin: true } },
    },
  };
});
