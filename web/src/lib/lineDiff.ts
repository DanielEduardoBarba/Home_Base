/** Tiny line-oriented unified diff (no extra deps). */

export type DiffRow = {
  kind: 'same' | 'add' | 'del'
  text: string
  /** 1-based line numbers; null when not applicable */
  oldNo: number | null
  newNo: number | null
}

/** Longest common subsequence indices for line arrays (patience for medium files). */
function lcsIndex(a: string[], b: string[]): { ai: number; bi: number }[] {
  const n = a.length
  const m = b.length
  // Cap work for huge files — fall back to naive head/tail match.
  if (n * m > 400_000) {
    const pairs: { ai: number; bi: number }[] = []
    const lim = Math.min(n, m)
    let i = 0
    while (i < lim && a[i] === b[i]) {
      pairs.push({ ai: i, bi: i })
      i++
    }
    let aj = n - 1
    let bj = m - 1
    while (aj >= i && bj >= i && a[aj] === b[bj]) {
      pairs.push({ ai: aj, bi: bj })
      aj--
      bj--
    }
    return pairs.sort((x, y) => x.ai - y.ai)
  }
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] =
        a[i] === b[j]
          ? (dp[i + 1]![j + 1]! + 1)
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const pairs: { ai: number; bi: number }[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push({ ai: i, bi: j })
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++
    else j++
  }
  return pairs
}

export function lineDiff(before: string, after: string): DiffRow[] {
  const a = before.replace(/\r\n/g, '\n').split('\n')
  const b = after.replace(/\r\n/g, '\n').split('\n')
  // Drop trailing empty from split of trailing newline
  if (a.length && a[a.length - 1] === '') a.pop()
  if (b.length && b[b.length - 1] === '') b.pop()
  const pairs = lcsIndex(a, b)
  const rows: DiffRow[] = []
  let ai = 0
  let bi = 0
  let oldNo = 1
  let newNo = 1
  for (const p of pairs) {
    while (ai < p.ai) {
      rows.push({ kind: 'del', text: a[ai]!, oldNo: oldNo++, newNo: null })
      ai++
    }
    while (bi < p.bi) {
      rows.push({ kind: 'add', text: b[bi]!, oldNo: null, newNo: newNo++ })
      bi++
    }
    rows.push({ kind: 'same', text: a[ai]!, oldNo: oldNo++, newNo: newNo++ })
    ai++
    bi++
  }
  while (ai < a.length) {
    rows.push({ kind: 'del', text: a[ai]!, oldNo: oldNo++, newNo: null })
    ai++
  }
  while (bi < b.length) {
    rows.push({ kind: 'add', text: b[bi]!, oldNo: null, newNo: newNo++ })
    bi++
  }
  return rows
}

/** Reconstruct after-text from before + str-replace style edit when possible. */
export function applyReplace(
  before: string,
  oldStr: string,
  newStr: string,
): string | null {
  if (!oldStr) return null
  const idx = before.indexOf(oldStr)
  if (idx < 0) return null
  return before.slice(0, idx) + newStr + before.slice(idx + oldStr.length)
}
