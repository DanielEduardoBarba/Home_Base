import zlib from 'node:zlib'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { compression, defineAlgorithm } from 'vite-plugin-compression2'

/** Dev API (uvicorn). Same relative /api + /ws paths work in prod on :8888. */
const API_ORIGIN = 'http://127.0.0.1:8080'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Emit .gz / .br beside assets; FastAPI serves them when Accept-Encoding matches
    compression({
      algorithms: [
        defineAlgorithm('gzip', { level: 9 }),
        defineAlgorithm('brotliCompress', {
          params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
        }),
      ],
      threshold: 256,
    }),
  ],
  build: {
    target: 'es2022',
    cssMinify: true,
    sourcemap: false,
    reportCompressedSize: true,
    chunkSizeWarningLimit: 600,
  },
  server: {
    // Bind all interfaces so phones / LAN clients can open http://<lan-ip>:3080
    host: '0.0.0.0',
    port: 3080,
    strictPort: true,
    // Allow LAN IPs and custom hostnames (Vite 6+ blocks unknown hosts by default)
    allowedHosts: true,
    proxy: {
      '/api': API_ORIGIN,
      '/ws': { target: API_ORIGIN, ws: true },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 3080,
    allowedHosts: true,
  },
})
