import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: 'src/client',
  plugins: [react(), tailwindcss()],
  build: { outDir: '../../dist/client', emptyOutDir: true, sourcemap: true },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:4270', changeOrigin: false } },
  },
})
