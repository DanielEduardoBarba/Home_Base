import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('AppsTab accessibility', () => {
  const src = readFileSync(join(import.meta.dir, 'AppsTab.tsx'), 'utf8')

  test('Run dropdown has accessible name', () => {
    expect(src).toMatch(/aria-label=["']Run action["']/)
  })

  test('HB-U-10: Ship dropdown has accessible name', () => {
    expect(src).toMatch(/aria-label=["']Ship action["']/)
  })

  test('HB-U-13: Unity card shows building / last build error', () => {
    expect(src).toMatch(/unityBuilding/)
    expect(src).toMatch(/\bbuilding\b/)
    expect(src).toMatch(/unityBuildError/)
    expect(src).toMatch(/toLocaleString/)
  })
})
