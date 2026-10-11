#!/usr/bin/env node
/**
 * Dev front door on DEV_WEB_PORT (default 3081):
 *   /api + /ws  → HOMEBASE_PORT (8081)
 *   everything else → next dev (internal)
 * Same-origin relative paths work like production.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import httpProxy from 'http-proxy'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const WEB_PORT = Number(process.env.DEV_WEB_PORT || 3081)
const API_PORT = Number(process.env.HOMEBASE_PORT || 8081)
const NEXT_PORT = Number(process.env.NEXT_INTERNAL_PORT || WEB_PORT + 1000)
const API = `http://127.0.0.1:${API_PORT}`
const NEXT = `http://127.0.0.1:${NEXT_PORT}`

const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true })
proxy.on('error', (err, _req, res) => {
  if (res && typeof res.writeHead === 'function' && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/plain' })
    res.end(`proxy error: ${err.message}`)
  }
})

function isApi(url = '') {
  return url.startsWith('/api') || url.startsWith('/ws')
}

const next = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['next', 'dev', '-H', '127.0.0.1', '-p', String(NEXT_PORT)],
  {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, FORCE_COLOR: '1' },
  },
)

next.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})

const server = createServer((req, res) => {
  const target = isApi(req.url || '') ? API : NEXT
  proxy.web(req, res, { target })
})

server.on('upgrade', (req, socket, head) => {
  const target = isApi(req.url || '') ? API : NEXT
  proxy.ws(req, socket, head, { target })
})

server.listen(WEB_PORT, '0.0.0.0', () => {
  console.log(
    `[web] http://0.0.0.0:${WEB_PORT} → next :${NEXT_PORT} · /api|/ws → :${API_PORT}`,
  )
})

function shutdown(sig) {
  next.kill(sig)
  server.close()
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
