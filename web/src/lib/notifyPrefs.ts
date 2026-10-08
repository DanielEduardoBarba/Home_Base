const SOUND_KEY = 'hb-notify-sound'
const OS_KEY = 'hb-notify-os'
const SEEN_KEY = 'hb-notify-seen'

export type NotifyPrefs = {
  sound: boolean
  os: boolean
}

export function getNotifyPrefs(): NotifyPrefs {
  try {
    return {
      sound: localStorage.getItem(SOUND_KEY) !== '0',
      os: localStorage.getItem(OS_KEY) !== '0',
    }
  } catch {
    return { sound: true, os: true }
  }
}

export function setNotifySound(on: boolean): void {
  try {
    localStorage.setItem(SOUND_KEY, on ? '1' : '0')
  } catch {
    /* ignore */
  }
}

export function setNotifyOs(on: boolean): void {
  try {
    localStorage.setItem(OS_KEY, on ? '1' : '0')
  } catch {
    /* ignore */
  }
}

export function loadSeenToastIds(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw) as string[]
    return new Set(Array.isArray(arr) ? arr.slice(-500) : [])
  } catch {
    return new Set()
  }
}

export function saveSeenToastIds(ids: Set<string>): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...ids].slice(-500)))
  } catch {
    /* ignore */
  }
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  if (typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission
}

export async function requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof Notification === 'undefined') return 'unsupported'
  if (Notification.permission === 'granted') return 'granted'
  if (Notification.permission === 'denied') return 'denied'
  try {
    return await Notification.requestPermission()
  } catch {
    return Notification.permission
  }
}
