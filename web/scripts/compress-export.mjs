#!/usr/bin/env node
/**
 * next export → out/ → dist/ + precompressed .br / .gz for Bun static serving.
 * High compression for VPN / poor links (brotli q=11, gzip 9).
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, extname } from 'node:path'
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'out')
const DIST = join(ROOT, 'dist')

const COMPRESS_EXT = new Set([
  '.html',
  '.js',
  '.css',
  '.svg',
  '.json',
  '.txt',
  '.webmanifest',
  '.map',
  '.xml',
  // skip .woff2 — already compressed; recompress rarely helps VPN payloads
])

if (!existsSync(OUT)) {
  console.error('Error: next export out/ missing — did next build succeed?')
  process.exit(1)
}

rmSync(DIST, { recursive: true, force: true })
mkdirSync(DIST, { recursive: true })
cpSync(OUT, DIST, { recursive: true })

let files = 0
let bytesIn = 0
let bytesBr = 0
let bytesGz = 0

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      walk(p)
      continue
    }
    if (name.endsWith('.br') || name.endsWith('.gz')) continue
    const ext = extname(name).toLowerCase()
    if (!COMPRESS_EXT.has(ext)) continue
    if (st.size < 256) continue

    const buf = readFileSync(p)
    const gz = gzipSync(buf, { level: 9 })
    const br = brotliCompressSync(buf, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
        [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
      },
    })
    writeFileSync(p + '.gz', gz)
    writeFileSync(p + '.br', br)
    files += 1
    bytesIn += buf.length
    bytesGz += gz.length
    bytesBr += br.length
  }
}

walk(DIST)

const mb = (n) => (n / 1024 / 1024).toFixed(2)
console.log(
  `==> SPA export → dist/ (${files} compressed files · raw ${mb(bytesIn)} MiB · gzip ${mb(bytesGz)} · br ${mb(bytesBr)})`,
)
