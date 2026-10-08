import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { api } from './api'
import { playNotifyPing, unlockNotifyAudio } from './notifyAudio'
import {
  getNotifyPrefs,
  loadSeenToastIds,
  notificationPermission,
  requestNotificationPermission,
  saveSeenToastIds,
  setNotifyOs,
  setNotifySound,
  type NotifyPrefs,
} from './notifyPrefs'
import type { NotificationItem } from './types'
import { uid } from './id'

export type ToastItem = {
  id: string
  title: string
  body: string
  level: string
  category: string
  ts: number
}

type NotifyContextValue = {
  unread: number
  inbox: NotificationItem[]
  inboxOpen: boolean
  historyOpen: boolean
  toasts: ToastItem[]
  prefs: NotifyPrefs
  permission: NotificationPermission | 'unsupported'
  openInbox: () => void
  closeInbox: () => void
  toggleInbox: () => void
  openHistory: () => void
  closeHistory: () => void
  dismissToast: (id: string) => void
  refresh: () => Promise<void>
  markOne: (id: string) => Promise<void>
  markAll: () => Promise<void>
  /** Immediate toast + sound + OS (e.g. Cursor finished before poll). */
  ping: (opts: {
    title: string
    body?: string
    level?: string
    category?: string
  }) => void
  setSound: (on: boolean) => void
  setOs: (on: boolean) => void
  enableOsNotifications: () => Promise<NotificationPermission | 'unsupported'>
  unlockAudio: () => void
}

const NotifyContext = createContext<NotifyContextValue | null>(null)

const TOAST_MS = 5200
const LOCAL_SUPPRESS_MS = 20_000

function showOsNotification(item: {
  title: string
  body?: string
  tag?: string
}): void {
  if (typeof Notification === 'undefined') return
  if (Notification.permission !== 'granted') return
  try {
    const n = new Notification(item.title, {
      body: item.body || '',
      tag: item.tag || 'homebase',
      silent: false,
    })
    n.onclick = () => {
      try {
        window.focus()
      } catch {
        /* ignore */
      }
      n.close()
    }
  } catch {
    /* iOS Chrome / WKWebView may reject */
  }
}

export function NotifyProvider({ children }: { children: ReactNode }) {
  const [unread, setUnread] = useState(0)
  const [inbox, setInbox] = useState<NotificationItem[]>([])
  const [inboxOpen, setInboxOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [prefs, setPrefs] = useState<NotifyPrefs>(() => getNotifyPrefs())
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() =>
    notificationPermission(),
  )

  const seenRef = useRef<Set<string>>(loadSeenToastIds())
  const localPingAt = useRef<Map<string, number>>(new Map())
  const toastTimers = useRef<Map<string, number>>(new Map())
  const primedRef = useRef(false)
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
    const t = toastTimers.current.get(id)
    if (t) {
      window.clearTimeout(t)
      toastTimers.current.delete(id)
    }
  }, [])

  const present = useCallback(
    (item: {
      id: string
      title: string
      body?: string
      level?: string
      category?: string
    }) => {
      const level = item.level || 'info'
      const toast: ToastItem = {
        id: item.id,
        title: item.title,
        body: item.body || '',
        level,
        category: item.category || 'system',
        ts: Date.now(),
      }
      setToasts((prev) => [toast, ...prev.filter((t) => t.id !== toast.id)].slice(0, 4))
      const timer = window.setTimeout(() => dismissToast(toast.id), TOAST_MS)
      toastTimers.current.set(toast.id, timer)

      const p = prefsRef.current
      if (p.sound) playNotifyPing(level)
      if (p.os) {
        // Chrome desktop: works in-tab. iPhone: best with Add to Home Screen + permission.
        showOsNotification({
          title: item.title,
          body: item.body,
          tag: item.category || item.id,
        })
      }
    },
    [dismissToast],
  )

  const refresh = useCallback(async () => {
    try {
      const data = await api.notifications({ limit: 25, unreadOnly: true })
      setUnread(data.unread)
      setInbox(data.items)

      // First poll after mount: seed seen ids so we don't replay the whole inbox as toasts
      if (!primedRef.current) {
        primedRef.current = true
        let changed = false
        for (const item of data.items) {
          if (!seenRef.current.has(item.id)) {
            seenRef.current.add(item.id)
            changed = true
          }
        }
        if (changed) saveSeenToastIds(seenRef.current)
        return
      }

      const now = Date.now()
      const fresh = [...data.items].reverse()
      let changed = false
      for (const item of fresh) {
        if (seenRef.current.has(item.id)) continue
        seenRef.current.add(item.id)
        changed = true

        const cat = item.category || 'system'
        const lastLocal = localPingAt.current.get(cat) || 0
        if (now - lastLocal < LOCAL_SUPPRESS_MS) continue

        present(item)
      }
      if (changed) saveSeenToastIds(seenRef.current)
    } catch {
      /* ignore while logged out / offline */
    }
  }, [present])

  const ping = useCallback(
    (opts: { title: string; body?: string; level?: string; category?: string }) => {
      const category = opts.category || 'local'
      localPingAt.current.set(category, Date.now())
      const id = `local-${uid(10)}`
      seenRef.current.add(id)
      present({
        id,
        title: opts.title,
        body: opts.body,
        level: opts.level || 'info',
        category,
      })
    },
    [present],
  )

  useEffect(() => {
    void refresh()
    const t = window.setInterval(() => void refresh(), 4000)
    const onVis = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.clearInterval(t)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [refresh])

  const markOne = useCallback(
    async (id: string) => {
      await api.markRead([id])
      await refresh()
    },
    [refresh],
  )

  const markAll = useCallback(async () => {
    await api.markRead([], true)
    await refresh()
  }, [refresh])

  const unlockAudio = useCallback(() => {
    void unlockNotifyAudio()
  }, [])

  const openInbox = useCallback(() => {
    unlockAudio()
    setInboxOpen(true)
    void refresh()
  }, [refresh, unlockAudio])

  const closeInbox = useCallback(() => setInboxOpen(false), [])
  const toggleInbox = useCallback(() => {
    setInboxOpen((v) => {
      if (!v) {
        void unlockNotifyAudio()
        void refresh()
      }
      return !v
    })
  }, [refresh])

  const openHistory = useCallback(() => {
    setInboxOpen(false)
    setHistoryOpen(true)
  }, [])
  const closeHistory = useCallback(() => setHistoryOpen(false), [])

  const setSound = useCallback((on: boolean) => {
    setNotifySound(on)
    setPrefs((p) => ({ ...p, sound: on }))
    if (on) void unlockNotifyAudio()
  }, [])

  const setOs = useCallback((on: boolean) => {
    setNotifyOs(on)
    setPrefs((p) => ({ ...p, os: on }))
  }, [])

  const enableOsNotifications = useCallback(async () => {
    unlockAudio()
    const perm = await requestNotificationPermission()
    setPermission(perm)
    if (perm === 'granted') {
      setNotifyOs(true)
      setPrefs((p) => ({ ...p, os: true }))
    }
    return perm
  }, [unlockAudio])

  const value = useMemo<NotifyContextValue>(
    () => ({
      unread,
      inbox,
      inboxOpen,
      historyOpen,
      toasts,
      prefs,
      permission,
      openInbox,
      closeInbox,
      toggleInbox,
      openHistory,
      closeHistory,
      dismissToast,
      refresh,
      markOne,
      markAll,
      ping,
      setSound,
      setOs,
      enableOsNotifications,
      unlockAudio,
    }),
    [
      unread,
      inbox,
      inboxOpen,
      historyOpen,
      toasts,
      prefs,
      permission,
      openInbox,
      closeInbox,
      toggleInbox,
      openHistory,
      closeHistory,
      dismissToast,
      refresh,
      markOne,
      markAll,
      ping,
      setSound,
      setOs,
      enableOsNotifications,
      unlockAudio,
    ],
  )

  return <NotifyContext.Provider value={value}>{children}</NotifyContext.Provider>
}

export function useNotify(): NotifyContextValue {
  const ctx = useContext(NotifyContext)
  if (!ctx) throw new Error('useNotify outside NotifyProvider')
  return ctx
}

/** Safe for optional use (e.g. before auth). */
export function useNotifyOptional(): NotifyContextValue | null {
  return useContext(NotifyContext)
}
