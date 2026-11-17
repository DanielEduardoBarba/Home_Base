import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent,
  type WheelEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { api, wsUrl } from '../lib/api'
import {
  connectWithReconnect,
  type WsReconnectHandle,
} from '../lib/wsReconnect'

type FocusInfo = {
  editable?: boolean
  tag?: string
  role?: string
  type?: string
  name?: string
  valueLen?: number
}

type BrowserStatus = {
  running: boolean
  url?: string | null
  controller?: 'agent' | 'human' | null
  displayMode?: 'xvfb' | 'headless' | 'seat' | null
  display?: string | null
  askPending?: { id: string; prompt: string } | null
  viewport?: { width: number; height: number } | null
}

function controllerLabel(st: BrowserStatus): string {
  if (st.askPending) return 'Waiting on you'
  if (st.controller === 'human') return 'You have control'
  return 'AI driving'
}

function displayHint(st: BrowserStatus): string {
  if (st.displayMode === 'xvfb') return `Virtual display ${st.display || ''}`.trim()
  if (st.displayMode === 'headless') return 'Headless (no seat window)'
  if (st.displayMode === 'seat') return 'Seat desktop (fallback)'
  return ''
}

type ViewMode = 'inline' | 'fullscreen'

export function BrowserDock() {
  const [status, setStatus] = useState<BrowserStatus>({ running: false })
  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('inline')
  const [busy, setBusy] = useState(false)
  const [typeText, setTypeText] = useState('')
  const [typeOverlay, setTypeOverlay] = useState(false)
  const [pressEnterAfter, setPressEnterAfter] = useState(false)
  const [focusHint, setFocusHint] = useState<FocusInfo | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [okHint, setOkHint] = useState<string | null>(null)
  const inlineImgRef = useRef<HTMLImageElement | null>(null)
  const fullImgRef = useRef<HTMLImageElement | null>(null)
  const typeInputRef = useRef<HTMLTextAreaElement | null>(null)
  const frameBlobRef = useRef<string | null>(null)
  const handleRef = useRef<WsReconnectHandle | null>(null)

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const st = await api.browserStatus()
        if (!cancelled) {
          setStatus(st)
          setErr(null)
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      }
    }
    void poll()
    const t = window.setInterval(() => void poll(), 4000)
    return () => {
      cancelled = true
      window.clearInterval(t)
    }
  }, [])

  useEffect(() => {
    if (!status.running) {
      handleRef.current?.dispose()
      handleRef.current = null
      if (frameBlobRef.current) {
        URL.revokeObjectURL(frameBlobRef.current)
        frameBlobRef.current = null
      }
      setFrameUrl(null)
      setViewMode('inline')
      setTypeOverlay(false)
      setFocusHint(null)
      return
    }
    const handle = connectWithReconnect({
      url: () => wsUrl('/ws/browser'),
      onMessage: (ev) => {
        if (typeof ev.data !== 'string') return
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(ev.data) as Record<string, unknown>
        } catch {
          return
        }
        const type = String(msg.type || '')
        if (type === 'hello' || type === 'status') {
          setStatus((prev) => ({
            ...prev,
            running: Boolean(msg.running ?? prev.running),
            url: (msg.url as string | null | undefined) ?? prev.url,
            controller: (msg.controller as BrowserStatus['controller']) ?? prev.controller,
            displayMode: (msg.displayMode as BrowserStatus['displayMode']) ?? prev.displayMode,
            display: (msg.display as string | null | undefined) ?? prev.display,
            askPending:
              (msg.askPending as BrowserStatus['askPending']) ??
              (msg.askPending === null ? null : prev.askPending),
            viewport: (msg.viewport as BrowserStatus['viewport']) ?? prev.viewport,
          }))
          return
        }
        if (type === 'frame' && typeof msg.data === 'string') {
          try {
            const bin = atob(msg.data)
            const bytes = new Uint8Array(bin.length)
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
            const blob = new Blob([bytes], { type: 'image/jpeg' })
            const next = URL.createObjectURL(blob)
            if (frameBlobRef.current) URL.revokeObjectURL(frameBlobRef.current)
            frameBlobRef.current = next
            setFrameUrl(next)
            if (msg.url) {
              setStatus((prev) => ({ ...prev, url: String(msg.url) }))
            }
          } catch {
            /* ignore bad frame */
          }
        }
      },
    })
    handleRef.current = handle
    return () => {
      handle.dispose()
      if (handleRef.current === handle) handleRef.current = null
    }
  }, [status.running])

  useEffect(() => {
    return () => {
      if (frameBlobRef.current) URL.revokeObjectURL(frameBlobRef.current)
    }
  }, [])

  useEffect(() => {
    if (viewMode !== 'fullscreen') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (typeOverlay) {
          setTypeOverlay(false)
          return
        }
        setViewMode('inline')
      }
    }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [viewMode, typeOverlay])

  useEffect(() => {
    if (!typeOverlay) return
    const t = window.setTimeout(() => typeInputRef.current?.focus(), 40)
    return () => window.clearTimeout(t)
  }, [typeOverlay])

  if (!status.running) return null

  const human = status.controller === 'human' || Boolean(status.askPending)

  const normFromPointer = (
    e: PointerEvent<HTMLImageElement>,
    el: HTMLImageElement | null,
  ) => {
    if (!el) return null
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
    return { x, y }
  }

  const sendClick = (e: PointerEvent<HTMLImageElement>, el: HTMLImageElement | null) => {
    if (!human || busy) return
    const pt = normFromPointer(e, el)
    if (!pt) return
    e.preventDefault()
    void (async () => {
      setBusy(true)
      try {
        const res = (await api.browserInput({
          action: 'click',
          x: pt.x,
          y: pt.y,
        })) as {
          focus?: FocusInfo
          openTypeOverlay?: boolean
        }
        setErr(null)
        setOkHint(null)
        const focus = res.focus || null
        setFocusHint(focus)
        if (res.openTypeOverlay || focus?.editable) {
          setTypeOverlay(true)
          setTypeText('')
        }
      } catch (err) {
        setErr(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    })()
  }

  const sendWheel = (e: WheelEvent<HTMLImageElement>, el: HTMLImageElement | null) => {
    if (!human || busy) return
    e.preventDefault()
    const pt = normFromPointer(e as unknown as PointerEvent<HTMLImageElement>, el)
    void api
      .browserInput({
        action: 'scroll',
        x: pt?.x,
        y: pt?.y,
        deltaX: e.deltaX,
        deltaY: e.deltaY,
      })
      .catch((err) => setErr(err instanceof Error ? err.message : String(err)))
  }

  const toggleControl = async () => {
    setBusy(true)
    try {
      if (human && !status.askPending) {
        setStatus(await api.browserReleaseControl())
        setTypeOverlay(false)
        setFocusHint(null)
      } else {
        setStatus(await api.browserTakeControl())
      }
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const submitType = async (e?: FormEvent) => {
    e?.preventDefault()
    const text = typeText
    if (!text || busy) return
    setBusy(true)
    try {
      const res = (await api.browserInput({
        action: 'type',
        text,
        pressEnter: pressEnterAfter,
      })) as { chars?: number }
      setTypeText('')
      setErr(null)
      setOkHint(`Inserted ${res.chars ?? text.length} chars into Chrome`)
      setTypeOverlay(false)
    } catch (err) {
      setErr(err instanceof Error ? err.message : String(err))
      setOkHint(null)
    } finally {
      setBusy(false)
    }
  }

  const fieldLabel =
    focusHint?.name ||
    (focusHint?.tag ? `<${focusHint.tag}>` : null) ||
    'focused field'

  const actions = (
    <div className="flex items-center gap-1.5 shrink-0">
      <button
        type="button"
        className="hb-btn hb-btn-ghost !min-h-7 !px-2 text-[11px]"
        onClick={() => setViewMode((m) => (m === 'fullscreen' ? 'inline' : 'fullscreen'))}
        title={viewMode === 'fullscreen' ? 'Exit fullscreen (Esc)' : 'Fullscreen preview'}
      >
        {viewMode === 'fullscreen' ? 'Exit full' : 'Fullscreen'}
      </button>
      {!status.askPending && (
        <button
          type="button"
          disabled={busy}
          className="hb-btn hb-btn-ghost !min-h-7 !px-2 text-[11px] disabled:opacity-40"
          onClick={() => void toggleControl()}
          title="Who drives input — does not change view size"
        >
          {human ? 'Release' : 'Take control'}
        </button>
      )}
    </div>
  )

  const meta = (
    <div className="min-w-0 flex-1">
      <div className="text-[11px] font-semibold text-text truncate">
        Isolated Chrome · {controllerLabel(status)}
      </div>
      <div className="text-[10px] text-mute truncate">
        {status.url || 'about:blank'}
        {displayHint(status) ? ` · ${displayHint(status)}` : ''}
      </div>
    </div>
  )

  const typeCard = human ? (
    <form
      onSubmit={(e) => void submitType(e)}
      className={`hb-browser-typecard ${typeOverlay ? 'is-open' : ''}`}
    >
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="text-[10px] uppercase tracking-wide text-mute truncate">
          {typeOverlay || focusHint?.editable
            ? `Type into ${fieldLabel}`
            : 'Click a field in the preview, then type here'}
        </div>
        {typeOverlay && (
          <button
            type="button"
            className="text-[10px] text-mute hover:text-text"
            onClick={() => setTypeOverlay(false)}
          >
            Close
          </button>
        )}
      </div>
      <textarea
        ref={typeInputRef}
        value={typeText}
        onChange={(e) => setTypeText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void submitType()
          }
        }}
        rows={typeOverlay ? 3 : 1}
        placeholder="Text inserts into the Chrome field (Enter = insert)"
        className="w-full rounded-lg bg-panel border border-line px-2 py-1.5 text-[12px] outline-none focus:border-accent resize-y min-h-[2rem]"
        autoComplete="off"
      />
      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
        <label className="flex items-center gap-1.5 text-[10px] text-mute cursor-pointer select-none">
          <input
            type="checkbox"
            checked={pressEnterAfter}
            onChange={(e) => setPressEnterAfter(e.target.checked)}
          />
          Press Enter after insert
        </label>
        <div className="flex-1" />
        <button
          type="button"
          disabled={busy}
          className="hb-btn hb-btn-ghost !min-h-7 !px-2 text-[11px] shrink-0"
          onClick={() =>
            void api
              .browserInput({ action: 'key', key: 'Enter' })
              .catch((err) => setErr(err instanceof Error ? err.message : String(err)))
          }
        >
          Enter key
        </button>
        <button
          type="submit"
          disabled={busy || !typeText}
          className="hb-btn hb-btn-primary !min-h-7 !px-2.5 text-[11px] shrink-0 disabled:opacity-40"
        >
          Insert
        </button>
      </div>
    </form>
  ) : null

  const askBanner = status.askPending ? (
    <div className="rounded-lg border border-amber/40 bg-amber/10 px-2 py-1.5 text-[11px] text-text">
      {status.askPending.prompt}
    </div>
  ) : null

  const feedback = (
    <>
      {err && <div className="text-[10px] text-danger">{err}</div>}
      {okHint && !err && <div className="text-[10px] text-mute">{okHint}</div>}
    </>
  )

  const fullscreen =
    viewMode === 'fullscreen' && typeof document !== 'undefined'
      ? createPortal(
          <div
            className="hb-browser-fs"
            role="dialog"
            aria-modal="true"
            aria-label="Isolated Chrome fullscreen"
          >
            <div className="hb-browser-fs-bar">
              {meta}
              {actions}
            </div>
            <div className={`hb-browser-fs-stage ${human ? 'is-control' : ''}`}>
              {frameUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  ref={fullImgRef}
                  src={frameUrl}
                  alt="Isolated Chrome fullscreen"
                  className="hb-browser-fs-img"
                  draggable={false}
                  onPointerUp={(e) => sendClick(e, fullImgRef.current)}
                  onWheel={(e) => sendWheel(e, fullImgRef.current)}
                />
              ) : (
                <div className="text-[12px] text-mute">Waiting for live frames…</div>
              )}
            </div>
            <div className="hb-browser-fs-footer space-y-1.5">
              {askBanner}
              {typeCard}
              {feedback}
              <p className="text-[10px] text-mute m-0">
                Click a field → type card opens. Insert sends into Chrome (not this page). Esc closes.
              </p>
            </div>
          </div>,
          document.body,
        )
      : null

  return (
    <>
      <div className="hb-browser-inline hb-chat-enter mr-4">
        <div className="flex items-center gap-2 px-2.5 py-1.5 min-w-0">
          <button
            type="button"
            className="text-[10px] uppercase tracking-wide text-mute shrink-0"
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed}
          >
            {collapsed ? 'Show' : 'Hide'}
          </button>
          {meta}
          {actions}
        </div>
        {!collapsed && (
          <div className="px-2 pb-2 space-y-1.5">
            {askBanner}
            <div
              className={`hb-browser-inline-stage ${human ? 'is-control' : ''}`}
              role="button"
              tabIndex={0}
              title={human ? 'Drive here, or open Fullscreen' : 'Open fullscreen'}
              onClick={() => {
                if (!human) setViewMode('fullscreen')
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setViewMode('fullscreen')
                }
              }}
            >
              {frameUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  ref={inlineImgRef}
                  src={frameUrl}
                  alt="Isolated Chrome preview"
                  className="hb-browser-inline-img"
                  draggable={false}
                  onPointerUp={(e) => {
                    e.stopPropagation()
                    if (human) sendClick(e, inlineImgRef.current)
                    else setViewMode('fullscreen')
                  }}
                  onWheel={(e) => {
                    e.stopPropagation()
                    if (human) sendWheel(e, inlineImgRef.current)
                  }}
                />
              ) : (
                <div className="h-24 flex items-center justify-center text-[11px] text-mute">
                  Waiting for live frames…
                </div>
              )}
            </div>
            {feedback}
            {typeCard}
            {!human && (
              <p className="text-[10px] text-mute m-0">
                Tap preview or Fullscreen to enlarge. Take control → click a field → type card.
              </p>
            )}
          </div>
        )}
      </div>
      {fullscreen}
    </>
  )
}
