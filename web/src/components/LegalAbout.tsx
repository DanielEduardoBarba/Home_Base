/** Compact About / Legal block for Settings and Login footer. */

const SITE = 'https://devcon1solutions.com'
const EMAIL = 'daniel@devcon1solutions.com'

export function LegalAbout({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <p className="text-[11px] text-mute text-center leading-relaxed px-2">
        MIT ·{' '}
        <a href={SITE} target="_blank" rel="noreferrer" className="underline underline-offset-2">
          DevCon1 Solutions
        </a>
        {' · '}
        <a href={`mailto:${EMAIL}`} className="underline underline-offset-2">
          {EMAIL}
        </a>
        <br />
        Provided AS IS — use at your own risk.
      </p>
    )
  }

  return (
    <section className="hb-surface p-3.5 space-y-2.5">
      <h2 className="hb-label">About & legal</h2>
      <p className="text-sm leading-relaxed">
        Home Base is released under the{' '}
        <span className="font-semibold">MIT License</span> by{' '}
        <a
          href={SITE}
          target="_blank"
          rel="noreferrer"
          className="text-sky underline underline-offset-2"
        >
          DevCon1 Solutions
        </a>
        .
      </p>
      <p className="text-xs text-mute leading-relaxed">
        Contact{' '}
        <a href={`mailto:${EMAIL}`} className="text-sky underline underline-offset-2">
          {EMAIL}
        </a>
        {' · '}
        <a href={SITE} target="_blank" rel="noreferrer" className="text-sky underline underline-offset-2">
          {SITE.replace(/^https:\/\//, '')}
        </a>
      </p>
      <p className="text-xs text-mute leading-relaxed border-t border-line pt-2.5">
        This software can control your shell, files, and screen remotely. It is
        provided <span className="font-semibold text-text">AS IS</span> with no
        warranty. DevCon1 Solutions accepts no liability. All use is entirely at
        your own risk.
      </p>
    </section>
  )
}
