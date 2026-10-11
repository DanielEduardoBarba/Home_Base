import { Component, type ErrorInfo, type ReactNode } from 'react'
import { clearAppCache } from '../lib/theme'

type Props = { children: ReactNode }
type State = { error: Error | null }

/**
 * Prevents a render crash from leaving only the themed body background
 * (empty #root) with no way to recover.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[hb] UI crash', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    const msg = this.state.error.message || String(this.state.error)
    return (
      <div className="hb-page min-h-[100dvh] flex flex-col items-center justify-center gap-4 text-center px-6">
        <h1 className="text-xl font-semibold text-ink">Something went wrong</h1>
        <p className="text-sm text-mute max-w-md">{msg}</p>
        <div className="flex flex-wrap gap-2 justify-center">
          <button
            type="button"
            className="hb-btn"
            onClick={() => {
              this.setState({ error: null })
              window.location.reload()
            }}
          >
            Reload
          </button>
          <button
            type="button"
            className="hb-btn hb-btn-ghost"
            onClick={() => {
              try {
                clearAppCache()
                localStorage.removeItem('hb-ui-tab')
                localStorage.removeItem('hb-chat-dock-open')
                sessionStorage.clear()
              } catch {
                /* ignore */
              }
              window.location.reload()
            }}
          >
            Reset UI prefs
          </button>
        </div>
      </div>
    )
  }
}
