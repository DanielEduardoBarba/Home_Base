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
