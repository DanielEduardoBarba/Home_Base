'use client'

import { useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }
}

function CodeBlock({ className, children }: { className?: string; children?: ReactNode }) {
  const text = String(children ?? '').replace(/\n$/, '')
  const lang = /language-([\w-]+)/.exec(className || '')?.[1] || ''
  const [copied, setCopied] = useState(false)
  return (
    <div className="hb-md-pre-wrap">
      <div className="hb-md-pre-bar">
        <span className="hb-md-pre-lang">{lang || 'code'}</span>
        <button
          type="button"
          className="hb-md-pre-copy"
          onClick={() => {
            void copyText(text).then((ok) => {
              if (!ok) return
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1200)
            })
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className={className}>
        <code className={className}>{text}</code>
      </pre>
    </div>
  )
}

export function ChatMarkdown({ text }: { text: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        components={{
          pre({ children }) {
            return <>{children}</>
          },
          code({ className, children, ...rest }) {
            const inline = !className && !String(children).includes('\n')
            if (inline) {
              return (
                <code className={className} {...rest}>
                  {children}
                </code>
              )
            }
            return <CodeBlock className={className}>{children}</CodeBlock>
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

export { copyText }
