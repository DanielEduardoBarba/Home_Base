export type ThemeMode = 'night' | 'day'

const STORAGE_KEY = 'hb-theme'
/** Manual top inset for iPhone island / notch — phone & tablet only (CSS gated). */
const SAFE_TOP_KEY = 'hb-safe-top'

export function getStoredTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'day' || v === 'night') return v
  } catch {
    /* ignore */
  }
  return 'night'
}

export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement
  root.dataset.theme = mode
  root.style.colorScheme = mode === 'day' ? 'light' : 'dark'
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) {
    meta.setAttribute('content', mode === 'day' ? '#f5f7fb' : '#05070c')
  }
}

export function setTheme(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    /* ignore */
  }
  applyTheme(mode)
}

export function getMobileSafeTop(): boolean {
  try {
    return localStorage.getItem(SAFE_TOP_KEY) === '1'
  } catch {
    return false
  }
}

export function applyMobileSafeTop(on: boolean = getMobileSafeTop()): void {
  document.documentElement.dataset.safeTop = on ? '1' : '0'
}

export function setMobileSafeTop(on: boolean): void {
  try {
    localStorage.setItem(SAFE_TOP_KEY, on ? '1' : '0')
  } catch {
    /* ignore */
  }
  applyMobileSafeTop(on)
}

/** Keys that are safe to wipe as client cache (keeps session + theme). */
export function listCacheKeys(): string[] {
  const keys: string[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k) continue
      if (
        k.startsWith('hb-cursor-') ||
        k === 'hb-cursor-model' ||
        k.startsWith('hb-files-') ||
        k.startsWith('hb-ui-')
      ) {
        keys.push(k)
      }
    }
  } catch {
    /* ignore */
  }
  return keys
}

export function clearAppCache(): { removed: number } {
  const keys = listCacheKeys()
  for (const k of keys) {
    try {
      localStorage.removeItem(k)
    } catch {
      /* ignore */
    }
  }
  return { removed: keys.length }
}
