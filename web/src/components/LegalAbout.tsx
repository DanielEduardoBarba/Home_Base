'use client'

import { useState } from 'react'
import {
  LEGAL_CONTACT_EMAIL,
  LEGAL_CONTACT_SITE,
  LEGAL_DOC_VERSION,
  LEGAL_OPERATOR,
} from '../lib/legalDocs'
import { LegalDocModal, type LegalDocKind } from './LegalDocModal'

/** Compact About / Legal block for Settings and Login footer. */
export function LegalAbout({ compact = false }: { compact?: boolean }) {
  const [doc, setDoc] = useState<LegalDocKind | null>(null)

  if (compact) {
    return (
      <>
        <p className="text-[11px] text-mute text-center leading-relaxed px-2">
          MIT ·{' '}
          <a href={LEGAL_CONTACT_SITE} target="_blank" rel="noreferrer" className="underline underline-offset-2">
            {LEGAL_OPERATOR}
          </a>
          {' · '}
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => setDoc('terms')}
          >
            Terms
          </button>
          {' · '}
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => setDoc('privacy')}
          >
            Privacy
          </button>
          <br />
          AS IS — use at your own risk · v{LEGAL_DOC_VERSION}
        </p>
        {doc && <LegalDocModal kind={doc} onClose={() => setDoc(null)} />}
      </>
    )
  }

  return (
    <>
      <section className="hb-surface p-3.5 space-y-2.5">
        <h2 className="hb-label">About & legal</h2>
        <p className="text-sm leading-relaxed">
          Home Base is released under the{' '}
          <span className="font-semibold">MIT License</span> by{' '}
          <a
            href={LEGAL_CONTACT_SITE}
            target="_blank"
            rel="noreferrer"
            className="text-sky underline underline-offset-2"
          >
            {LEGAL_OPERATOR}
          </a>
          .
        </p>
        <p className="text-xs text-mute leading-relaxed flex flex-wrap gap-x-3 gap-y-1">
          <button
            type="button"
            className="text-sky underline underline-offset-2"
            onClick={() => setDoc('terms')}
          >
            Terms of Use
          </button>
          <button
            type="button"
            className="text-sky underline underline-offset-2"
            onClick={() => setDoc('privacy')}
          >
            Privacy Policy
          </button>
          <span className="font-mono">v{LEGAL_DOC_VERSION}</span>
        </p>
        <p className="text-xs text-mute leading-relaxed">
          Contact{' '}
          <a href={`mailto:${LEGAL_CONTACT_EMAIL}`} className="text-sky underline underline-offset-2">
            {LEGAL_CONTACT_EMAIL}
          </a>
          {' · '}
          <a href={LEGAL_CONTACT_SITE} target="_blank" rel="noreferrer" className="text-sky underline underline-offset-2">
            {LEGAL_CONTACT_SITE.replace(/^https:\/\//, '')}
          </a>
        </p>
        <p className="text-xs text-mute leading-relaxed border-t border-line pt-2.5">
          This software can control your shell, files, and screen remotely. It is
          provided <span className="font-semibold text-text">AS IS</span> with no
          warranty. {LEGAL_OPERATOR} accepts no liability. All use is entirely at
          your own risk. You must accept the Terms and Privacy Policy to use Home Base.
        </p>
      </section>
      {doc && <LegalDocModal kind={doc} onClose={() => setDoc(null)} />}
    </>
  )
}
