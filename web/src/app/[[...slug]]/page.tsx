import HomePage from '../HomePage'

/**
 * Optional catch-all so the static export's client router keeps deep links
 * like /work/files instead of sending them to the Next not-found page
 * (the Bun server already SPA-fallbacks unknown paths to index.html).
 */
export function generateStaticParams() {
  return [{ slug: [] }]
}

export default function Page() {
  return <HomePage />
}
