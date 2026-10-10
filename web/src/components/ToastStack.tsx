import { useNotify } from '../lib/NotifyContext'

function levelDot(level: string): string {
  if (level === 'error') return 'bg-danger'
  if (level === 'warn') return 'bg-warn'
  if (level === 'success') return 'bg-ok'
  return 'bg-accent'
}

export function ToastStack() {
  const { toasts, dismissToast, openInbox } = useNotify()
  if (!toasts.length) return null

  return (
    <div className="hb-toast-stack" aria-live="polite" aria-relevant="additions">
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          className="hb-toast"
          aria-label={`${t.title}. Open alerts`}
          title="Open alerts"
          onClick={() => {
            // Whole toast = dismiss (former X) + open notification center
            dismissToast(t.id)
            openInbox()
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
