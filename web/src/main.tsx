import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { applyTheme, getStoredTheme } from './lib/theme'
import { installViewportHeight } from './lib/viewport'
import './index.css'

applyTheme(getStoredTheme())
installViewportHeight()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
