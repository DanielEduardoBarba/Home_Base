import type { NextConfig } from 'next'

/**
 * Static export → web/dist (via compress-export.mjs).
 * Prod: Bun serves dist with precompressed .br/.gz.
 * Dev: scripts/dev.mjs proxies /api + /ws to the API and UI to next dev.
 */
const nextConfig: NextConfig = {
  output: 'export',
  distDir: '.next',
  images: { unoptimized: true },
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  compiler: {
    removeConsole: process.env.NODE_ENV === 'production' ? { exclude: ['error', 'warn'] } : false,
  },
  experimental: {
    optimizePackageImports: [
      'react-markdown',
      '@uiw/react-codemirror',
      '@codemirror/lang-javascript',
      '@codemirror/lang-python',
      '@codemirror/lang-json',
      '@codemirror/lang-markdown',
      '@codemirror/lang-html',
      '@codemirror/lang-css',
    ],
  },
}

export default nextConfig
