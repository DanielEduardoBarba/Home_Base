'use client'

import {
  LEGAL_DOC_VERSION,
  PRIVACY_POLICY,
  TERMS_OF_USE,
  type LegalSection,
} from '../lib/legalDocs'

export type LegalDocKind = 'terms' | 'privacy'

function DocBody({ sections }: { sections: LegalSection[] }) {
  return (
    <div className="space-y-5 text-sm leading-relaxed">
      {sections.map((s) => (
        <section key={s.heading} className="space-y-2">
          <h3 className="font-semibold text-text">{s.heading}</h3>
          {s.body.map((p, i) => (
            <p key={i} className="text-mute">
              {p}
            </p>
          ))}
        </section>
      ))}
    </div>
  )
}

/** Scrollable Terms / Privacy reader (Settings, Login links, LegalGate). */
export function LegalDocModal({
  kind,
  onClose,
}: {
  kind: LegalDocKind
  onClose: () => void
}) {
  const title = kind === 'terms' ? 'Terms of Use' : 'Privacy Policy'
  const sections = kind === 'terms' ? TERMS_OF_USE : PRIVACY_POLICY

  return (
    <div
      className="fixed inset-0 z-[80] hb-overlay backdrop-blur-sm flex items-end sm:items-center justify-center p-3 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="hb-legal-doc-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg max-h-[88dvh] hb-surface flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 p-4 border-b border-line shrink-0">
          <div>
            <h2 id="hb-legal-doc-title" className="font-display text-lg font-extrabold tracking-tight">
              {title}
            </h2>
            <p className="text-[11px] text-mute font-mono mt-0.5">Version {LEGAL_DOC_VERSION}</p>
          </div>
          <button
            type="button"
            className="hb-btn hb-btn-ghost !min-h-9 !px-3 text-sm shrink-0"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <div className="overflow-y-auto p-4 sm:p-5">
          <DocBody sections={sections} />
        </div>
      </div>
    </div>
  )
}
