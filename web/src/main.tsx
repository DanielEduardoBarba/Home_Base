import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { applyTheme, getStoredTheme } from './lib/theme'
import { installViewportHeight } from './lib/viewport'
import './index.css'

applyTheme(getStoredTheme())
installViewportHeight()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
