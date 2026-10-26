import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: 'src/client',
  plugins: [react(), tailwindcss()],
  // elkjs (graph layout) is a single ~1.4 MB lazy chunk loaded on the first DAG layout.
  build: { outDir: '../../dist/client', emptyOutDir: true, sourcemap: true, chunkSizeWarningLimit: 1600 },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:4270', changeOrigin: false } },
  },
})
