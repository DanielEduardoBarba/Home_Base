import HomePage from '../HomePage'

const KNOWN_SLUGS: string[][] = [
  [],
  ['home'],
  ['access'],
  ['agent'],
  ['vision'],
  ['settings'],
  ['view'],
  ['logs'],
  ['work'],
  ['work', 'apps'],
  ['work', 'shell'],
  ['work', 'files'],
  ['work', 'chat'],
  ['work', 'cursor'],
  ['homework'],
  ['homework', 'apps'],
  ['homework', 'shell'],
  ['homework', 'files'],
  ['homework', 'chat'],
  ['homework', 'view'],
  ['homework', 'logs'],
]

/**
 * Optional catch-all so the static export keeps deep links like /work/files.
 * Each known path is pre-rendered so the Next client router does not send
 * it back to /. The Bun server still SPA-fallbacks unknown paths.
 */
export function generateStaticParams() {
  return KNOWN_SLUGS.map((slug) => ({ slug }))
}

export default function Page() {
  return <HomePage />
}
