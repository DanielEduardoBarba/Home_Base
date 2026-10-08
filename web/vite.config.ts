import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/** Dev API (uvicorn). Same relative /api + /ws paths work in prod on :80. */
const API_ORIGIN = 'http://127.0.0.1:8080'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 3080,
    proxy: {
      '/api': API_ORIGIN,
      '/ws': { target: API_ORIGIN, ws: true },
    },
  },
})
