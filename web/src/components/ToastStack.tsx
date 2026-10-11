import { useNotify } from '../lib/NotifyContext'

function levelDot(level: string): string {
  if (level === 'error') return 'bg-danger'
  if (level === 'warn') return 'bg-warn'
  if (level === 'success') return 'bg-ok'
  return 'bg-accent'
}

export function ToastStack() {
  const { toasts, dismissToast } = useNotify()
  if (!toasts.length) return null

  return (
    <div className="hb-toast-stack" aria-live="polite" aria-relevant="additions">
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          className="hb-toast"
          aria-label={`${t.title}. Dismiss`}
          title="Dismiss"
          onClick={() => {
            // Toast only — keep the item in Alerts; do not open the inbox modal
            dismissToast(t.id)
          }}
        >
          <span className={`hb-toast-dot ${levelDot(t.level)}`} />
          <span className="hb-toast-body">
            <span className="hb-toast-title">{t.title}</span>
            {t.body ? <span className="hb-toast-text">{t.body}</span> : null}
          </span>
        </button>
      ))}
    </div>
  )
}
