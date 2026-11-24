/** Bytes sent to the PTY for the on-screen terminal key bar. */

export const TERM_ARROW_KEYS: { label: string; title: string; seq: string }[] = [
  { label: '↑', title: 'Up', seq: '\x1b[A' },
  { label: '↓', title: 'Down', seq: '\x1b[B' },
  { label: '←', title: 'Left', seq: '\x1b[D' },
  { label: '→', title: 'Right', seq: '\x1b[C' },
]

export const TERM_SYMBOL_KEYS: { label: string; title: string; seq: string }[] = [
  { label: '|', title: 'Pipe', seq: '|' },
  { label: '~', title: 'Tilde', seq: '~' },
  { label: '/', title: 'Slash', seq: '/' },
  { label: '-', title: 'Dash', seq: '-' },
]

/** A–Z for the Ctrl chord grid (iPhone Soft Keyboard has no Ctrl). */
export const TERM_CTRL_LETTERS: string[] = Array.from({ length: 26 }, (_, i) =>
  String.fromCharCode(65 + i),
)

/**
 * Map one typed character to a Ctrl sequence (ASCII C0).
 * Letters → Ctrl+A…Z; also @ [ \ ] ^ _ and ? (DEL).
 * Returns null when the character is not a Ctrl chord.
 */
export function toCtrlSequence(ch: string): string | null {
  if (ch.length !== 1) return null
  const code = ch.charCodeAt(0)
  // a–z / A–Z → 1..26
  if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
    return String.fromCharCode(code & 0x1f)
  }
  // Traditional terminal Ctrl punctuation (same as xterm)
  if (code >= 64 && code <= 95) {
    // @ A…Z [ \ ] ^ _  (A–Z already handled; @ and [\]^_ remain)
    return String.fromCharCode(code & 0x1f)
  }
  if (ch === '?') return '\x7f' // Ctrl+? → DEL
  return null
}
