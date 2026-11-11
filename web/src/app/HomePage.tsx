'use client'

import { useEffect } from 'react'
import App from '../App'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { applyTheme, getStoredTheme } from '../lib/theme'
import { installViewportHeight } from '../lib/viewport'

export default function HomePage() {
  useEffect(() => {
    applyTheme(getStoredTheme())
    return installViewportHeight()
  }, [])

  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  )
}
