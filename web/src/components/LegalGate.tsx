'use client'

import { useState } from 'react'
import { api } from '../lib/api'
import {
  LEGAL_DOC_VERSION,
  LEGAL_OPERATOR,
} from '../lib/legalDocs'
import { BrandTitle } from './BrandTitle'
import { LegalDocModal, type LegalDocKind } from './LegalDocModal'
import { useServerIdentity } from '../lib/serverIdentity'

/**
 * Hard gate — user cannot continue until they accept current Terms + Privacy.
 */
export function LegalGate({ onAccepted }: { onAccepted: () => void }) {
  const { displayName } = useServerIdentity()
  const [agreed, setAgreed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [doc, setDoc] = useState<LegalDocKind | null>(null)

  async function accept() {
    if (!agreed || busy) return
    setBusy(true)
    setError('')
    try {
      await api.acceptLegal(LEGAL_DOC_VERSION)
      onAccepted()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[70] bg-bg flex flex-col">
      <div className="flex-1 overflow-y-auto">
        <div className="hb-page !max-w-lg py-10 space-y-6">
          <div className="space-y-2 hb-enter">
            <div className="hb-brand-rule" />
            <p className="hb-label">Legal</p>
            <h1 className="font-display text-3xl font-extrabold tracking-tight leading-tight">
              <BrandTitle name={displayName} />
            </h1>
            <p className="text-mute text-sm leading-relaxed">
              Before you continue, you must agree to the Terms of Use and Privacy Policy.
              Home Base can control shell, files, and screen on this machine.
            </p>
          </div>

          <section className="hb-surface p-4 space-y-3 hb-enter">
            <h2 className="font-semibold text-sm">You acknowledge</h2>
            <ul className="text-sm text-mute space-y-2 list-disc pl-4 leading-relaxed">
              <li>
                The Software is provided <span className="text-text font-semibold">AS IS</span> with
                no warranty.
              </li>
              <li>
                You use it <span className="text-text font-semibold">entirely at your own risk</span>.
              </li>
              <li>
                {LEGAL_OPERATOR} and contributors accept{' '}
                <span className="text-text font-semibold">no liability</span> for loss, breach,
                misuse, or damage.
              </li>
              <li>
                You alone secure this host, credentials, VPN/tunnel, and who you share access with.
              </li>
              <li>Do not expose the Home Base HTTP port directly to the public Internet.</li>
            </ul>
            <div className="flex flex-wrap gap-x-4 gap-y-2 pt-1 text-sm">
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
              <span className="text-[11px] text-mute font-mono self-center">
                v{LEGAL_DOC_VERSION}
              </span>
            </div>
          </section>

          <label className="flex gap-3 items-start hb-surface p-4 cursor-pointer hb-enter">
            <input
              type="checkbox"
              className="mt-1 size-4 shrink-0 accent-[var(--accent)]"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
            />
            <span className="text-sm leading-relaxed">
              I have read and agree to the{' '}
              <button
                type="button"
                className="text-sky underline underline-offset-2"
                onClick={(e) => {
                  e.preventDefault()
                  setDoc('terms')
                }}
              >
                Terms of Use
              </button>{' '}
              and{' '}
              <button
                type="button"
                className="text-sky underline underline-offset-2"
                onClick={(e) => {
                  e.preventDefault()
                  setDoc('privacy')
                }}
              >
                Privacy Policy
              </button>
              . I understand Home Base is AS IS, I use it at my own risk, and I release{' '}
              {LEGAL_OPERATOR} and contributors from all liability to the maximum extent permitted
              by law.
            </span>
          </label>

          {error && <p className="text-danger text-sm">{error}</p>}

          <button
            type="button"
            className="hb-btn hb-btn-primary w-full !min-h-12 text-base disabled:opacity-40"
            disabled={!agreed || busy}
            onClick={() => void accept()}
          >
            {busy ? 'Saving…' : 'I agree — continue'}
          </button>
        </div>
      </div>

      {doc && <LegalDocModal kind={doc} onClose={() => setDoc(null)} />}
    </div>
  )
}
