import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { api, wsUrl } from '../lib/api'
import { ChatMarkdown, copyText } from './ChatMarkdown'
import { clearLocalChats, loadLocalChatsForImport } from '../lib/chatTabs'
import type {
  ApprovalPolicy,
  ChatImage,
  ChatMode,
  ChatMsg,
  ChatTab,
  PendingApproval,
  PresentRequest,
} from '../lib/chatTypes'
import { fileToCompressedChatImage, formatMb } from '../lib/chatImageCompress'
import { chatImageSrc } from '../lib/chatTypes'
import { useNotifyOptional } from '../lib/NotifyContext'
import { presentFromMessage, presentFromTool, presentLabel } from '../lib/present'
import { useSceneRefresh } from '../lib/sceneRefresh'
import {
  clearChatDraft,
  peekPendingCompose,
  readChatDraft,
  takePendingCompose,
  writeChatDraft,
} from '../lib/uiPrefs'
import {
  speakText,
  speechSupported,
  speechSynthesisSupported,
  startSpeechDictation,
  stopSpeaking,
  type SpeechHandle,
} from '../lib/speech'
import {
  formatMsgTime,
  formatToolDetail,
  polishThinking,
  prettyToolName,
} from '../lib/toolFormat'
import type { CursorModel, FsEntry, Project } from '../lib/types'
import {
  connStateLabel,
  connectWithReconnect,
  type WsConnState,
  type WsReconnectHandle,
} from '../lib/wsReconnect'
import { AtMentionPicker, detectAtMention, type AtPick } from './AtMentionPicker'
import { FilesTab } from './FilesTab'
import { IconBtn } from './IconBtn'
import { ProjectSelect } from './ProjectSelect'
import { ShellTab } from './ShellTab'

const MAX_DRAFT_CONTEXT = 12

const MODEL_STORAGE_KEY = 'hb-cursor-model'
const MODE_STORAGE_KEY = 'hb-cursor-mode'
const APPROVAL_STORAGE_KEY = 'hb-cursor-approval-policy'
/** Previous system default — treat as unset so Auto becomes the new default. */
const LEGACY_DEFAULT_MODELS = new Set(['composer-2.5', 'composer-2', 'composer-1.5'])
const CHAT_MODES: { id: ChatMode; label: string; title: string }[] = [
  { id: 'agent', label: 'Agent', title: 'Build and edit — full tools' },
  { id: 'ask', label: 'Ask', title: 'Read-only Q&A — no edits or shell' },
  { id: 'plan', label: 'Plan', title: 'Design first, implement after you approve' },
  { id: 'debug', label: 'Debug', title: 'Hypothesis-driven debugging' },
]
/** Work chat dock: '1' = open, anything else / missing = minimized (default). */
const DOCK_OPEN_KEY = 'hb-chat-dock-open'

export function readDockOpen(): boolean {
  try {
    return localStorage.getItem(DOCK_OPEN_KEY) === '1'
  } catch {
    return false
  }
}

export function writeDockOpen(open: boolean): void {
  try {
    localStorage.setItem(DOCK_OPEN_KEY, open ? '1' : '0')
  } catch {
    /* ignore */
  }
}

function MsgMeta({ at, align = 'start' }: { at?: number; align?: 'start' | 'end' }) {
  const t = formatMsgTime(at)
  if (!t) return null
  return (
    <time
      className={`hb-chat-meta block text-[11px] text-mute mt-1 font-mono tabular-nums ${
        align === 'end' ? 'text-right' : 'text-left'
      }`}
      dateTime={at ? new Date(at).toISOString() : undefined}
      title={at ? new Date(at).toISOString() : undefined}
    >
      {t}
    </time>
  )
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}m ${r}s`
}

function useNowTick(active: boolean, intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [active, intervalMs])
  return now
}

/** Collapsible thinking block — stays open for the latest turn, still user-togglable. */
function ThinkingDetails({
  streaming,
  preferOpen,
  className,
  summary,
  children,
}: {
  streaming: boolean
  preferOpen: boolean
  className: string
  summary: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(() => streaming || preferOpen)
  useEffect(() => {
    if (streaming || preferOpen) setOpen(true)
  }, [streaming, preferOpen])
  return (
    <details
      className={className}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      {summary}
      {children}
    </details>
  )
}

const LONG_PRESS_MS = 480

/** Long-press (or secondary click) a bubble to copy its text. */
function useLongPressCopy(getText: () => string, onCopied?: () => void) {
  const timer = useRef<number | null>(null)
  const moved = useRef(false)
  const clear = () => {
    if (timer.current != null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }
  const fire = () => {
    clear()
    const text = getText().trim()
    if (!text) return
    void copyText(text).then((ok) => {
      if (ok) onCopied?.()
    })
  }
  return {
    onPointerDown: (e: ReactPointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      moved.current = false
      clear()
      timer.current = window.setTimeout(fire, LONG_PRESS_MS)
    },
    onPointerMove: (e: ReactPointerEvent) => {
      if (Math.abs(e.movementX) + Math.abs(e.movementY) > 6) {
        moved.current = true
        clear()
      }
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
    onContextMenu: (e: ReactMouseEvent) => {
      e.preventDefault()
      fire()
    },
  }
}

function CopyFlash({ show }: { show: boolean }) {
  if (!show) return null
  return (
    <span className="hb-copy-flash" role="status">
      Copied
    </span>
  )
}

/** Inline phase chip: thinking / tool / writing / busy / done (+ live seconds while active). */
function MsgPhaseBadge({
  kind,
  startedAt,
  durationMs,
  live = false,
}: {
  kind: 'thinking' | 'tool' | 'busy' | 'writing' | 'done'
  startedAt?: number
  durationMs?: number
  live?: boolean
}) {
  const now = useNowTick(live)
  let elapsed = ''
  if (live && startedAt) {
    elapsed = formatElapsed(now - startedAt)
  } else if (durationMs != null && durationMs >= 0) {
    elapsed = formatElapsed(durationMs)
  }
  const label =
    kind === 'done'
      ? elapsed
        ? `done · ${elapsed}`
        : 'done'
      : elapsed
        ? `${kind} · ${elapsed}`
        : kind
  return (
    <span className={`hb-msg-badge hb-msg-badge-${kind}`} role="status">
      {live && kind !== 'done' ? <span className="hb-msg-badge-dot" aria-hidden /> : null}
      {label}
    </span>
  )
}

function MsgActions({
  actions,
}: {
  actions: { label: string; onClick: () => void; title?: string }[]
}) {
  if (!actions.length) return null
  return (
    <div className="hb-msg-actions">
      {actions.map((a) => (
        <button key={a.label} type="button" className="hb-msg-action" title={a.title} onClick={a.onClick}>
          {a.label}
        </button>
      ))}
    </div>
  )
}

function contextChipLabel(path: string): string {
  const parts = path.replace(/\/$/, '').split('/')
  return parts[parts.length - 1] || path
}

function todoStatusIcon(status: string): string {
  if (status === 'completed') return '✓'
  if (status === 'inProgress') return '▸'
  if (status === 'cancelled') return '×'
  return '○'
}

function MessageCard({
  m,
  onPresent,
  onCopy,
  onEdit,
  onRegenerate,
  onPlanAction,
  onApplyFix,
  canEdit,
  canRegenerate,
  preferThinkingOpen = false,
}: {
  m: ChatMsg
  onPresent?: (req: PresentRequest) => void
  onCopy?: (text: string) => void
  onEdit?: (text: string, contextPaths?: string[]) => void
  onRegenerate?: () => void
  onPlanAction?: (messageId: string, action: 'build' | 'cancel') => void
  onApplyFix?: (messageId: string, text: string) => void
  canEdit?: boolean
  canRegenerate?: boolean
  /** Keep the latest turn's logic expanded so mobile can still read it. */
  preferThinkingOpen?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const flashCopied = useCallback(() => {
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1100)
  }, [])
  const toolLabel = prettyToolName(m.tool?.name || 'tool')
  const toolDetail = formatToolDetail(m.tool?.name || '', m.tool?.detail)
  const copyBody = useMemo(() => {
    if (m.role === 'tool') {
      return [toolLabel, toolDetail].filter(Boolean).join('\n')
    }
    if (m.role === 'file') {
      return `${m.file?.action || 'file'} ${m.file?.path || ''}`.trim()
    }
    if (m.role === 'thinking') {
      return polishThinking(m.text || '')
    }
    if (m.role === 'todo' && m.todos?.length) {
      return m.todos.map((t) => `${todoStatusIcon(t.status)} ${t.content}`).join('\n')
    }
    return m.text || ''
  }, [m, toolDetail, toolLabel])
  const lp = useLongPressCopy(() => copyBody, flashCopied)

  if (m.role === 'user') {
    return (
      <div className="ml-6 min-w-0 max-w-full relative">
        <div
          className="hb-chat-user hb-chat-copyable rounded-2xl px-3.5 py-3 text-sm leading-relaxed shadow-sm whitespace-pre-wrap break-words"
          title="Hold to copy"
          {...lp}
        >
          {!!m.contextPaths?.length && (
            <div className="hb-chat-ctx-row mb-2">
              {m.contextPaths.map((p) => (
                <span key={p} className="hb-chat-ctx-chip" title={p}>
                  @{contextChipLabel(p)}
                </span>
              ))}
            </div>
          )}
          {!!m.images?.length && (
            <div className="hb-chat-img-row mb-2">
              {m.images.map((img, i) => (
                <a
                  key={`${img.name || 'img'}-${i}`}
                  href={chatImageSrc(img)}
                  target="_blank"
                  rel="noreferrer"
                  className="hb-chat-img-thumb"
                  title={img.name || 'Attached image'}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={chatImageSrc(img)} alt={img.name || 'attachment'} />
                </a>
              ))}
            </div>
          )}
          {m.text}
          <CopyFlash show={copied} />
        </div>
        <MsgMeta at={m.at} align="end" />
        <MsgActions
          actions={[
            ...(m.text && onCopy
              ? [{ label: 'Copy', onClick: () => onCopy(m.text || ''), title: 'Copy message' }]
              : []),
            ...(canEdit && onEdit && (m.text || m.contextPaths?.length)
              ? [
                  {
                    label: 'Edit',
                    onClick: () => onEdit(m.text || '', m.contextPaths),
                    title: 'Edit & resend',
                  },
                ]
              : []),
          ]}
        />
      </div>
    )
  }
  if (m.role === 'thinking') {
    const body = m.streaming ? m.text || '' : polishThinking(m.text || '')
    return (
      <div className="relative min-w-0 max-w-full" {...lp}>
        <ThinkingDetails
          streaming={!!m.streaming}
          preferOpen={preferThinkingOpen}
          className={`hb-chat-thinking hb-chat-bubble-inset hb-chat-copyable rounded-xl px-3 py-2 text-xs text-amber min-w-0 max-w-full${
            m.streaming ? ' hb-chat-thinking-live' : ''
          }`}
          summary={
            <summary className="cursor-pointer select-none list-none flex items-center gap-2 flex-wrap min-w-0">
              <MsgPhaseBadge
                kind={m.streaming ? 'thinking' : 'done'}
                startedAt={m.at}
                durationMs={m.durationMs}
                live={!!m.streaming}
              />
              {!m.streaming && (
                <span className="text-mute normal-case tracking-normal text-[11px]">
                  {preferThinkingOpen ? 'logic · tap to hide' : 'tap to expand'}
                </span>
              )}
              <MsgMeta at={m.at} />
            </summary>
          }
        >
          <div className="mt-1.5 whitespace-pre-wrap break-words leading-relaxed opacity-95 hb-chat-thinking-body">
            {body}
            {m.streaming && (
              <span className="hb-chat-caret" aria-hidden>
                ▍
              </span>
            )}
          </div>
        </ThinkingDetails>
        <CopyFlash show={copied} />
      </div>
    )
  }
  if (m.role === 'tool') {
    const hint = presentFromMessage(m) || presentFromTool(
      m.tool?.name || '',
      m.tool?.path,
      m.tool?.sessionId,
      {
        command: m.tool?.command,
        output: m.tool?.output,
        before: m.tool?.before,
        after: m.tool?.after,
      },
    )
    const status = m.tool?.status || 'running'
    const running = status === 'running' || status === 'pending'
    const clickable = Boolean(hint && onPresent && (status === 'completed' || status === 'error' || m.tool?.sessionId))
    return (
      <div className="hb-chat-bubble-inset min-w-0 max-w-full relative">
        <div
          className={`hb-chat-tool hb-chat-copyable rounded-xl px-3 py-2.5 text-xs${
            clickable ? ' hb-chat-tool--clickable' : ''
          }`}
          title={clickable ? 'Tap to open · hold to copy' : 'Hold to copy'}
          role={clickable ? 'button' : undefined}
          tabIndex={clickable ? 0 : undefined}
          onClick={
            clickable
              ? (e) => {
                  if ((e.target as HTMLElement).closest('button')) return
                  onPresent!(hint!)
                }
              : undefined
          }
          onKeyDown={
            clickable
              ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onPresent!(hint!)
                  }
                }
              : undefined
          }
          {...lp}
        >
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            <MsgPhaseBadge
              kind={running ? 'tool' : 'done'}
              startedAt={m.at}
              live={running}
            />
            <span className="text-violet font-semibold break-words min-w-0">{toolLabel}</span>
            <span
              className={
                status === 'completed'
                  ? 'text-ok'
                  : status === 'error'
                    ? 'text-danger'
                    : 'text-sky'
              }
            >
              {status === 'completed' ? 'done' : status === 'running' ? 'running…' : status}
            </span>
            {clickable && (
              <button
                type="button"
                className="ml-auto text-accent font-semibold hover:underline shrink-0"
                onClick={(e) => {
                  e.stopPropagation()
                  onPresent!(hint!)
                }}
              >
                {presentLabel(hint!)}
              </button>
            )}
          </div>
          {toolDetail && (
            <pre className="hb-chat-tool-detail mt-1.5 text-[11px] text-mute leading-snug">
              {toolDetail}
            </pre>
          )}
          <CopyFlash show={copied} />
        </div>
        <MsgMeta at={m.at} />
      </div>
    )
  }
  if (m.role === 'file') {
    const hint = presentFromMessage(m)
    const clickable = Boolean(hint && onPresent)
    return (
      <div className="hb-chat-bubble-inset min-w-0 max-w-full relative">
        <div
          className={`hb-chat-file hb-chat-copyable rounded-xl px-3 py-2.5 text-xs shadow-sm${
            clickable ? ' hb-chat-file--clickable' : ''
          }`}
          title={clickable ? 'Tap to open changes · hold to copy' : 'Hold to copy'}
          role={clickable ? 'button' : undefined}
          tabIndex={clickable ? 0 : undefined}
          onClick={
            clickable
              ? () => onPresent!(hint!)
              : undefined
          }
          onKeyDown={
            clickable
              ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onPresent!(hint!)
                  }
                }
              : undefined
          }
          {...lp}
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sky font-semibold uppercase text-[10px] tracking-wide shrink-0">
              {m.file?.action || 'file'}
            </span>
            <span className="text-text truncate flex-1 min-w-0 font-mono text-[11px]">
              {m.file?.path}
            </span>
            {clickable && (
              <button
                type="button"
                className="text-accent font-semibold shrink-0 hover:underline"
                onClick={(e) => {
                  e.stopPropagation()
                  onPresent!(hint!)
                }}
              >
                {presentLabel(hint!)}
              </button>
            )}
          </div>
          <CopyFlash show={copied} />
        </div>
        <MsgMeta at={m.at} />
      </div>
    )
  }
  if (m.role === 'todo') {
    const todos = m.todos || []
    return (
      <div className="hb-chat-bubble-inset min-w-0 max-w-full relative">
        <div className="hb-chat-todo hb-chat-copyable rounded-2xl px-3.5 py-3 text-sm shadow-sm" {...lp}>
          <div className="hb-msg-badge-row mb-2">
            <span className="hb-chat-card-eyebrow">Todos</span>
            <span className="text-mute text-[11px]">{m.text}</span>
          </div>
          <ul className="hb-chat-todo-list">
            {todos.map((t, i) => (
              <li key={t.id || `${i}-${t.content}`} data-status={t.status}>
                <span className="hb-chat-todo-mark" aria-hidden>
                  {todoStatusIcon(t.status)}
                </span>
                <span className={t.status === 'completed' || t.status === 'cancelled' ? 'opacity-60' : ''}>
                  {t.content}
                </span>
              </li>
            ))}
            {!todos.length && (
              <li className="text-mute text-xs">No tasks yet</li>
            )}
          </ul>
          <CopyFlash show={copied} />
        </div>
        <MsgMeta at={m.at} />
      </div>
    )
  }
  if (m.role === 'plan') {
    const state = m.planState || 'open'
    const open = state === 'open' || state === 'building'
    return (
      <div className="hb-chat-bubble-inset min-w-0 max-w-full relative">
        <div className="hb-chat-plan hb-chat-copyable rounded-2xl px-3.5 py-3 text-sm shadow-sm" {...lp}>
          <div className="hb-msg-badge-row mb-2">
            <span className="hb-chat-card-eyebrow">Plan</span>
            <span className="text-mute text-[11px] capitalize">{state}</span>
            {m.streaming && (
              <MsgPhaseBadge kind="writing" startedAt={m.at} live />
            )}
          </div>
          {m.streaming ? (
            <div className="whitespace-pre-wrap break-words">
              {m.text}
              <span className="hb-chat-caret" aria-hidden>
                ▍
              </span>
            </div>
          ) : (
            <ChatMarkdown text={m.text || ''} />
          )}
          {!m.streaming && open && onPlanAction && (
            <div className="hb-chat-plan-actions mt-3 flex gap-2">
              <button
                type="button"
                className="flex-1 rounded-lg hb-btn-primary text-xs font-semibold py-2 border-0"
                disabled={state === 'building'}
                onClick={() => onPlanAction(m.id, 'build')}
              >
                {state === 'building' ? 'Building…' : 'Build'}
              </button>
              <button
                type="button"
                className="flex-1 rounded-lg border border-danger/50 text-danger text-xs font-semibold py-2"
                disabled={state === 'building'}
                onClick={() => onPlanAction(m.id, 'cancel')}
              >
                Cancel
              </button>
            </div>
          )}
          <CopyFlash show={copied} />
        </div>
        <MsgMeta at={m.at} />
      </div>
    )
  }
  if (m.role === 'task') {
    const st = m.task?.status || m.tool?.status || 'running'
    const running = st === 'running' || st === 'pending'
    return (
      <div className="hb-chat-bubble-inset min-w-0 max-w-full relative">
        <div className="hb-chat-task hb-chat-copyable rounded-xl px-3 py-2.5 text-xs" {...lp}>
          <div className="flex items-center gap-2 flex-wrap">
            <MsgPhaseBadge kind={running ? 'tool' : 'done'} startedAt={m.at} live={running} />
            <span className="text-sky font-semibold">Task</span>
            <span className="text-mute">{m.task?.name || m.text}</span>
            <span className={running ? 'text-sky' : 'text-ok'}>{st}</span>
          </div>
          <CopyFlash show={copied} />
        </div>
        <MsgMeta at={m.at} />
      </div>
    )
  }
  if (m.role === 'mode_prompt') {
    const mp = m.modePrompt
    return (
      <div className="hb-chat-bubble-inset min-w-0 max-w-full relative">
        <div className="hb-chat-mode-prompt rounded-xl border border-amber/40 bg-amber/10 px-3 py-2.5 text-xs">
          <div className="font-semibold text-amber uppercase tracking-wide text-[10px] mb-1">
            Switch mode
          </div>
          <div className="text-text">
            Switch to <strong>{mp?.to || 'agent'}</strong>
            {mp?.reason ? ` — ${mp.reason}` : ''}
          </div>
          {mp?.status && mp.status !== 'pending' && (
            <div className="text-mute mt-1 capitalize">{mp.status}</div>
          )}
        </div>
        <MsgMeta at={m.at} />
      </div>
    )
  }
  if (m.role === 'status' || m.role === 'system') {
    const err =
      m.role === 'system' &&
      /^(error|⚠|connection lost|agent run)/i.test((m.text || '').trim())
    const done = m.role === 'status' && /^done\b/i.test((m.text || '').trim())
    return (
      <div
        className={`hb-chat-status hb-chat-copyable flex items-baseline gap-2 px-1 min-w-0 max-w-full relative ${
          err ? 'text-danger' : done ? 'text-mute' : 'text-mute'
        }`}
        title="Hold to copy"
        {...lp}
      >
        <span className="text-[11px] leading-snug whitespace-pre-wrap break-words flex-1 min-w-0">
          {m.text}
        </span>
        <MsgMeta at={m.at} />
        <CopyFlash show={copied} />
      </div>
    )
  }
  const modeChrome = m.role === 'ask' ? 'Ask' : m.role === 'debug' ? 'Debug' : null
  return (
    <div className="hb-chat-bubble-inset min-w-0 max-w-full relative">
      <div
        className={`hb-chat-assistant hb-chat-copyable rounded-2xl px-3.5 py-3 text-sm leading-relaxed shadow-sm${
          m.role === 'ask' ? ' hb-chat-ask' : m.role === 'debug' ? ' hb-chat-debug' : ''
        }`}
        title="Hold to copy"
        {...lp}
      >
        <div className="hb-msg-badge-row">
          {modeChrome && <span className="hb-chat-card-eyebrow">{modeChrome}</span>}
          <MsgPhaseBadge
            kind={m.streaming ? 'writing' : 'done'}
            startedAt={m.at}
            live={!!m.streaming}
          />
        </div>
        {m.streaming ? (
          <div className="whitespace-pre-wrap break-words">
            {m.text}
            <span className="hb-chat-caret" aria-hidden>
              ▍
            </span>
          </div>
        ) : (
          <ChatMarkdown text={m.text || ''} />
        )}
        {!m.streaming && m.role === 'debug' && onApplyFix && m.text && (
          <div className="hb-chat-plan-actions mt-3 flex gap-2">
            <button
              type="button"
              className="flex-1 rounded-lg hb-btn-primary text-xs font-semibold py-2 border-0"
              onClick={() => onApplyFix(m.id, m.text || '')}
              title="Continue in Agent to apply a fix"
            >
              Apply in Agent
            </button>
          </div>
        )}
        <CopyFlash show={copied} />
      </div>
      <MsgMeta at={m.at} />
      {!m.streaming && (
        <MsgActions
          actions={[
            ...(m.text && onCopy
              ? [{ label: 'Copy', onClick: () => onCopy(m.text || ''), title: 'Copy message' }]
              : []),
            ...(canRegenerate && onRegenerate
              ? [{ label: 'Retry', onClick: onRegenerate, title: 'Regenerate response' }]
              : []),
          ]}
        />
      )}
    </div>
  )
}


export function ChatPanel({
  projects,
  selectedId,
  onSelect,
  variant = 'page',
  onPresent,
  dockOpen: dockOpenProp,
  onDockOpenChange,
  agentChatId,
  onAgentBack,
  defaultCwd,
  defaultCwdLabel,
}: {
  projects: Project[]
  selectedId: string
  onSelect: (id: string) => void
  /** page = full Chat tab; dock = bottom-right Work panel; agent = Home Agent minimal */
  variant?: 'page' | 'dock' | 'agent'
  onPresent?: (req: PresentRequest) => void
  dockOpen?: boolean
  onDockOpenChange?: (open: boolean) => void
  /** Lock Home Agent to one chat tab. */
  agentChatId?: string
  onAgentBack?: () => void
  /** Absolute cwd for new chats when the caller skips the folder picker (e.g. Vision ~/.homebase). */
  defaultCwd?: string
  /** Primary new-chat button label when defaultCwd is set. */
  defaultCwdLabel?: string
}) {
  const project = projects.find((p) => p.id === selectedId) || projects[0]
  const isDock = variant === 'dock'
  const isAgent = variant === 'agent'

  const [tabs, setTabs] = useState<ChatTab[]>([])
  const [activeId, setActiveId] = useState('')
  const [input, setInput] = useState('')
  const [connState, setConnState] = useState<WsConnState>('connecting')
  const connStateRef = useRef<WsConnState>('connecting')
  const connected = connState === 'live'
  const [streaming, setStreaming] = useState(false)
  const [queuedCount, setQueuedCount] = useState(0)
  const [showJump, setShowJump] = useState(false)
  const [agentId, setAgentId] = useState<string | null>(null)
  const [editingLast, setEditingLast] = useState(false)
  const [draftImages, setDraftImages] = useState<ChatImage[]>([])
  const [draftContext, setDraftContext] = useState<string[]>([])
  /** Work dock: file/shell “Show” stays in the chat sheet (Home Agent–style). */
  const [dockPresent, setDockPresent] = useState<PresentRequest | null>(null)
  const [atMention, setAtMention] = useState<{ start: number; query: string } | null>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const MAX_DRAFT_IMAGES = 4
  const MAX_DRAFT_IMAGE_BYTES = 4 * 1024 * 1024
  const [error, setError] = useState('')
  const [models, setModels] = useState<CursorModel[]>([])
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([])
  const [mode, setMode] = useState<ChatMode>(() => {
    try {
      const saved = (localStorage.getItem(MODE_STORAGE_KEY) || 'agent') as ChatMode
      return CHAT_MODES.some((m) => m.id === saved) ? saved : 'agent'
    } catch {
      return 'agent'
    }
  })
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy>(() => {
    try {
      const saved = localStorage.getItem(APPROVAL_STORAGE_KEY) || 'ask'
      return saved === 'auto' ? 'auto' : 'ask'
    } catch {
      return 'ask'
    }
  })
  const [model, setModel] = useState(() => {
    try {
      const saved = localStorage.getItem(MODEL_STORAGE_KEY) || ''
      if (!saved || LEGACY_DEFAULT_MODELS.has(saved)) return ''
      return saved
    } catch {
      return ''
    }
  })
  const [defaultModel, setDefaultModel] = useState('auto')
  const [newOpen, setNewOpen] = useState(false)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [pickerDir, setPickerDir] = useState('')
  const [pickerEntries, setPickerEntries] = useState<FsEntry[]>([])
  const [pickingFolder, setPickingFolder] = useState(false)
  const [listening, setListening] = useState(false)
  /** Home Agent: mic session stays armed until user turns it off; replies are spoken. */
  const [voiceMode, setVoiceMode] = useState(false)
  const voiceModeRef = useRef(false)
  voiceModeRef.current = voiceMode
  const canTts = useMemo(() => speechSynthesisSupported(), [])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [activity, setActivity] = useState('')
  /** Durable agent phase for status chrome (survives brief empty activity). */
  const [agentPhase, setAgentPhase] = useState<
    'idle' | 'starting' | 'thinking' | 'tool' | 'streaming' | 'approval' | 'sudo' | 'done' | 'error' | 'busy'
  >('idle')
  const [runLog, setRunLog] = useState<string[]>([])
  /** Mobile-friendly progress drawer (runLog is title-only on desktop hover). */
  const [statusOpen, setStatusOpen] = useState(false)
  /** When the current agentPhase started — drives status-bar elapsed seconds. */
  const [phaseSince, setPhaseSince] = useState(() => Date.now())
  const [sudoOpen, setSudoOpen] = useState(false)
  const [sudoPassword, setSudoPassword] = useState('')
  const [sudoCommand, setSudoCommand] = useState('')
  const [sudoPromptLabel, setSudoPromptLabel] = useState('')
  const [sudoSessionId, setSudoSessionId] = useState<string | undefined>()
  const [sudoCallId, setSudoCallId] = useState<string | undefined>()
  const [sudoId, setSudoId] = useState('')
  const [sudoHasVault, setSudoHasVault] = useState(false)
  const [sudoRemember, setSudoRemember] = useState(false)
  const [sudoCachedTtl, setSudoCachedTtl] = useState(0)
  const [sudoBusy, setSudoBusy] = useState(false)
  const [dockOpenLocal, setDockOpenLocal] = useState(false)
  /** Keep dock mounted while exit animation plays. */
  const [dockMounted, setDockMounted] = useState(false)
  const [dockClosing, setDockClosing] = useState(false)

  useEffect(() => {
    const open = readDockOpen()
    setDockOpenLocal(open)
    setDockMounted(open)
  }, [])
  const canSpeak = useMemo(() => speechSupported(), [])

  const dockOpen = dockOpenProp ?? dockOpenLocal
  function setDockOpen(open: boolean) {
    if (open) {
      setDockMounted(true)
      setDockClosing(false)
    } else if (dockMounted) {
      // Start exit animation immediately (don't wait for useEffect)
      setDockClosing(true)
    }
    writeDockOpen(open)
    if (onDockOpenChange) onDockOpenChange(open)
    else setDockOpenLocal(open)
  }

  const notify = useNotifyOptional()
  const wsRef = useRef<WebSocket | null>(null)
  const wsHandleRef = useRef<WsReconnectHandle | null>(null)
  const dockRef = useRef<HTMLElement | null>(null)
  const dockOpenedAt = useRef(0)
  const bottomRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  /** Follow new messages only while the user is near the bottom. */
  const stickBottom = useRef(true)
  const activeIdRef = useRef(activeId)
  const importTried = useRef('')
  /** After this browser creates a chat, follow the server's new selection once. */
  const followServerActive = useRef(false)
  /** Vision (etc.): seed/select defaultCwd chat once per project+cwd after workspace load. */
  const defaultCwdSeeded = useRef('')
  const defaultCwdRef = useRef(defaultCwd || '')
  const defaultCwdLabelRef = useRef(defaultCwdLabel || '')
  defaultCwdRef.current = defaultCwd || ''
  defaultCwdLabelRef.current = defaultCwdLabel || ''
  const inputRef = useRef(input)
  inputRef.current = input
  const draftChatRef = useRef({ projectId: '', chatId: '' })
  /** Avoid re-applying the same pending compose seed twice. */
  const pendingComposeApplied = useRef('')
  const pendingComposeCreating = useRef('')
  const tabsRef = useRef(tabs)
  const speechRef = useRef<SpeechHandle | null>(null)
  const inputBeforeSpeech = useRef('')
  const streamingRef = useRef(false)
  const phaseRef = useRef(agentPhase)
  const notifyRef = useRef(notify)
  const doneClearTimer = useRef<number | null>(null)
  activeIdRef.current = activeId
  tabsRef.current = tabs
  streamingRef.current = streaming
  phaseRef.current = agentPhase
  connStateRef.current = connState
  notifyRef.current = notify

  function pushRunLog(line: string) {
    const stamp = new Date().toLocaleTimeString()
    const entry = `${stamp} ${line}`
    console.info('[cursor]', line)
    setRunLog((prev) => [...prev.slice(-40), entry])
  }

  function setPhase(
    phase: typeof agentPhase,
    label?: string,
  ) {
    if (phase !== phaseRef.current) {
      const live = new Set([
        'starting',
        'thinking',
        'tool',
        'streaming',
        'approval',
        'sudo',
        'busy',
      ])
      // Restart the clock for each live phase so thinking/busy seconds are honest
      if (live.has(phase)) setPhaseSince(Date.now())
    }
    setAgentPhase(phase)
    if (label !== undefined) setActivity(label)
  }

  const active = useMemo(
    () => tabs.find((t) => t.id === activeId) || tabs[0],
    [tabs, activeId],
  )

  useEffect(() => {
    if (!project) return
    setTabs([])
    setActiveId('')
    setInput('')
    setError('')
    setStreaming(false)
    setPhase('idle', '')
    setRunLog([])
    setStatusOpen(false)
    stickBottom.current = true
    importTried.current = ''
    followServerActive.current = false
  }, [project?.id])

  // Switching chats follows that chat's server run, not whatever the last tab was doing.
  useEffect(() => {
    const tab = tabsRef.current.find((t) => t.id === activeId)
    if (!tab) return
    setStreaming(!!tab.running)
    if (tab.running) setPhase('busy', 'agent working…')
    else setPhase('idle', '')
  }, [activeId])

  // Persist / restore composer drafts per chat (leave + come back keeps typing).
  useEffect(() => {
    const pid = project?.id || ''
    const cid = activeId || ''
    const prev = draftChatRef.current
    if (prev.projectId && prev.chatId && (prev.projectId !== pid || prev.chatId !== cid)) {
      writeChatDraft(prev.projectId, prev.chatId, inputRef.current)
    }
    draftChatRef.current = { projectId: pid, chatId: cid }
    if (!pid || !cid) {
      if (!cid) setInput('')
      return
    }
    // Skip stale chat ids left over during a project switch before activeId clears.
    if (tabsRef.current.length > 0 && !tabsRef.current.some((t) => t.id === cid)) return
    setInput(readChatDraft(pid, cid))
  }, [project?.id, activeId])

  useEffect(() => {
    if (!project?.id || !activeId) return
    const pid = project.id
    const cid = activeId
    const t = window.setTimeout(() => writeChatDraft(pid, cid, input), 220)
    return () => window.clearTimeout(t)
  }, [input, project?.id, activeId])

  // Entering a chat tab → jump to bottom and stick unless user scrolls away
  useEffect(() => {
    stickBottom.current = true
    const el = listRef.current
    if (el) {
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight
      })
    }
  }, [activeId])

  useEffect(() => {
    if (!stickBottom.current) return
    const el = listRef.current
    if (el) {
      // Instant while streaming so follow feels glued; smooth when settling
      el.scrollTo({
        top: el.scrollHeight,
        behavior: streaming ? 'auto' : 'smooth',
      })
    } else {
      bottomRef.current?.scrollIntoView({ behavior: streaming ? 'auto' : 'smooth' })
    }
  }, [active?.messages, streaming, activity, pendingApprovals.length, sudoOpen])

  // Sync dock mount when parent forces open (e.g. prop flip)
  useEffect(() => {
    if (!isDock) return
    if (dockOpen) {
      setDockMounted(true)
      setDockClosing(false)
      dockOpenedAt.current = Date.now()
    } else if (dockMounted && !dockClosing) {
      setDockClosing(true)
      setDockPresent(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount/closing flags are sync'd from dockOpen only
  }, [isDock, dockOpen])

  useEffect(() => {
    setDockPresent(null)
  }, [project?.id])

  // Force-unmount if animationend never fires (keeps FAB reachable; clears blank overlay)
  useEffect(() => {
    if (!isDock || !dockClosing) return
    const t = window.setTimeout(() => {
      setDockMounted(false)
      setDockClosing(false)
    }, 450)
    return () => clearTimeout(t)
  }, [isDock, dockClosing])

  // Work dock: click outside → minimize (debounce so open-click / near-miss don't bounce)
  useEffect(() => {
    if (!isDock || !dockOpen || dockClosing) return
    dockOpenedAt.current = Date.now()
    const onPointer = (ev: PointerEvent) => {
      if (Date.now() - dockOpenedAt.current < 350) return
      const el = dockRef.current
      const t = ev.target
      if (!(t instanceof Node)) return
      if (el?.contains(t)) return
      if (t instanceof Element && t.closest('.hb-chat-fab')) return
      // Ignore while a dock modal is open
      if (newOpen || deleteId || sudoOpen) return
      setDockOpen(false)
    }
    document.addEventListener('pointerdown', onPointer, true)
    return () => document.removeEventListener('pointerdown', onPointer, true)
  }, [isDock, dockOpen, dockClosing, newOpen, deleteId, sudoOpen])

  useEffect(() => {
    const pull = () => {
      void api
        .sudoStatus()
        .then((s) => {
          setSudoCachedTtl(s.ttlSec || 0)
          setSudoHasVault(Boolean(s.cached || s.persistent || s.sessionCached))
          if (s.askpassWaiting && s.pending) {
            setSudoOpen(true)
            setSudoId(String(s.pending.id || ''))
            setSudoCommand(String(s.pending.command || '').trim())
            setSudoPromptLabel(String(s.pending.prompt || '[sudo] password required'))
          }
        })
        .catch(() => undefined)
    }
    pull()
    const t = window.setInterval(() => {
      setSudoCachedTtl((v) => (v > 0 ? Math.max(0, v - 5) : 0))
      pull()
    }, 5000)
    return () => window.clearInterval(t)
  }, [])

  const refreshModels = useCallback(async () => {
    try {
      const data = await api.cursorModels()
      setModels(data.models || [])
      const def = data.default || 'auto'
      setDefaultModel(def)
      setModel((prev) => {
        const ids = new Set((data.models || []).map((m) => m.id))
        // Keep an explicit user pick; otherwise fall through to server default (Auto).
        if (prev && !LEGACY_DEFAULT_MODELS.has(prev) && ids.has(prev)) return prev
        return ''
      })
      if (data.error) setError(data.error)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useSceneRefresh(refreshModels)

  useEffect(() => {
    void refreshModels()
  }, [refreshModels])

  useEffect(() => {
    if (!project) return
    const projectId = project.id
    const handle = connectWithReconnect({
      url: () => wsUrl(`/ws/cursor?project=${encodeURIComponent(projectId)}`),
      onState: (s) => {
        const prev = connStateRef.current
        connStateRef.current = s
        setConnState(s)
        // The run stays on the server. Do not write a failure into the transcript.
        if (
          (s === 'reconnecting' || s === 'offline') &&
          prev === 'live' &&
          streamingRef.current
        ) {
          setPhase('busy', 'reconnecting — run continues on the server')
        }
      },
      onOpen: (ws) => {
        wsRef.current = ws
      },
      onMessage: (ev) => {
        try {
          const msg = JSON.parse(ev.data as string)
          const chatId = String(msg.chatId || '')
          const forActive = !chatId || chatId === activeIdRef.current
          if (msg.type === 'deleted') {
            const gone = String(msg.chatId || '')
            if (gone) {
              setTabs((prev) => prev.filter((t) => t.id !== gone))
              if (activeIdRef.current === gone) {
                const next = String(msg.activeId || '')
                setActiveId(next)
                setStreaming(false)
                setPhase('idle', '')
              }
            }
            return
          }
          if (msg.type === 'workspace') {
            const nextTabs = (Array.isArray(msg.tabs) ? msg.tabs : []) as ChatTab[]
            setTabs(nextTabs)
            const held = activeIdRef.current
            const follow = followServerActive.current
            followServerActive.current = false
            let nextActive =
              !follow && nextTabs.some((t) => t.id === held)
                ? held
                : String(msg.activeId || nextTabs[0]?.id || '')
            // Vision: prefer/create seat-user ~/.homebase chat once per connect.
            const seedCwd = (defaultCwdRef.current || '').replace(/\/+$/, '')
            if (seedCwd) {
              const seedKey = `${projectId}:${seedCwd}`
              if (defaultCwdSeeded.current !== seedKey) {
                const match = nextTabs.find(
                  (t) => (t.cwd || '').replace(/\/+$/, '') === seedCwd,
                )
                if (match) {
                  nextActive = match.id
                  if (wsRef.current?.readyState === WebSocket.OPEN) {
                    wsRef.current.send(
                      JSON.stringify({ type: 'select', chatId: match.id }),
                    )
                  }
                  defaultCwdSeeded.current = seedKey
                } else if (wsRef.current?.readyState === WebSocket.OPEN) {
                  followServerActive.current = true
                  wsRef.current.send(
                    JSON.stringify({
                      type: 'new',
                      cwd: seedCwd,
                      title: defaultCwdLabelRef.current || 'Vision',
                    }),
                  )
                  defaultCwdSeeded.current = seedKey
                }
              }
            }
            setActiveId(nextActive)
            const current = nextTabs.find((t) => t.id === nextActive) || nextTabs[0]
            const isRunning = !!current?.running
            setStreaming(isRunning)
            // Don't clobber a specific live phase (thinking/tool/writing) with generic busy.
            const specificLive = new Set([
              'thinking',
              'tool',
              'streaming',
              'starting',
              'approval',
              'sudo',
            ])
            if (isRunning) {
              if (!specificLive.has(phaseRef.current)) {
                setPhase('busy', 'agent working…')
              }
            } else if (
              phaseRef.current !== 'done' &&
              phaseRef.current !== 'error' &&
              phaseRef.current !== 'idle'
            ) {
              setPhase('idle', '')
            }
            if (msg.approvalPolicy === 'auto' || msg.approvalPolicy === 'ask') {
              setApprovalPolicy(msg.approvalPolicy)
            }
            if (Array.isArray(msg.pendingApprovals)) {
              setPendingApprovals(msg.pendingApprovals as PendingApproval[])
            }
            if (msg.configured === false) {
              setError(
                'Cursor key missing on this server. On the host, put CURSOR_API_KEY in .env then run ./build.sh --deploy (or restart homebased after syncing /var/lib/homebased/.env).',
              )
            }
            if (msg.importable === true) {
              if (importTried.current !== projectId) {
                const local = loadLocalChatsForImport(projectId)
                if (local) {
                  importTried.current = projectId
                  wsRef.current?.send(
                    JSON.stringify({
                      type: 'import',
                      tabs: local.tabs,
                      activeId: local.activeId,
                    }),
                  )
                } else {
                  clearLocalChats(projectId)
                }
              }
            } else {
              clearLocalChats(projectId)
            }
          } else if (msg.type === 'import-ack') {
            clearLocalChats(projectId)
          } else if (msg.type === 'tab' && msg.tab?.id) {
            const tab = msg.tab as ChatTab
            setTabs((prev) => {
              const idx = prev.findIndex((t) => t.id === tab.id)
              if (idx < 0) return [...prev, tab]
              const next = prev.slice()
              next[idx] = tab
              return next
            })
            if (tab.id === activeIdRef.current) {
              setStreaming(!!tab.running)
              if (!tab.running && phaseRef.current === 'busy') setPhase('idle', '')
            }
          } else if (msg.type === 'approval') {
            const ap: PendingApproval = {
              id: String(msg.id || ''),
              kind: String(msg.kind || 'tool'),
              tool: String(msg.tool || 'tool'),
              detail: String(msg.detail || ''),
              command: msg.command ? String(msg.command) : undefined,
              cwd: msg.cwd ? String(msg.cwd) : undefined,
              chatId: msg.chatId ? String(msg.chatId) : undefined,
              createdAt: typeof msg.createdAt === 'number' ? msg.createdAt : Date.now() / 1000,
            }
            if (ap.id) {
              setPendingApprovals((prev) =>
                prev.some((p) => p.id === ap.id) ? prev : [...prev, ap],
              )
            }
          } else if (msg.type === 'approval-resolved' || msg.type === 'approval-ack') {
            const id = String(msg.id || '')
            if (id) setPendingApprovals((prev) => prev.filter((p) => p.id !== id))
          } else if (msg.type === 'approval-policy') {
            if (msg.policy === 'auto' || msg.policy === 'ask') setApprovalPolicy(msg.policy)
          } else if (msg.type === 'run') {
            if (!forActive) return
            setStreaming(true)
            setPhase('starting', 'starting…')
            pushRunLog(`run started model=${msg.model || '?'} runId=${msg.runId || '?'}`)
            if (doneClearTimer.current) {
              window.clearTimeout(doneClearTimer.current)
              doneClearTimer.current = null
            }
          } else if (
            msg.type === 'text-delta' ||
            msg.type === 'text' ||
            msg.type === 'text-snapshot'
          ) {
            const chunk = String(msg.text || '')
            if (!chunk) return
            const cid = chatId || activeIdRef.current
            if (!cid) return
            if (forActive) {
              setStreaming(true)
              setPhase('streaming', 'writing…')
            }
            const replace = msg.type === 'text-snapshot'
            const textRole = (['ask', 'debug', 'plan', 'assistant'].includes(
              String(msg.role || ''),
            )
              ? String(msg.role)
              : 'assistant') as ChatMsg['role']
            setTabs((prev) =>
              prev.map((t) => {
                if (t.id !== cid) return t
                const messages = t.messages.slice()
                for (let i = messages.length - 1; i >= 0; i--) {
                  const m = messages[i]!
                  if (m.role === 'thinking' && m.streaming) {
                    messages[i] = { ...m, streaming: false }
                    break
                  }
                }
                const streamRoles = new Set(['assistant', 'ask', 'debug', 'plan'])
                // Only append onto a streaming answer if it is still the last bubble
                // (tools after it mean the next answer belongs at the bottom).
                const last = messages[messages.length - 1]
                const canContinue =
                  !!last && last.role === textRole && !!last.streaming
                if (!canContinue) {
                  for (let i = 0; i < messages.length; i++) {
                    const m = messages[i]!
                    if (streamRoles.has(m.role) && m.streaming) {
                      messages[i] = { ...m, streaming: false }
                    }
                  }
                }
                if (canContinue && last) {
                  messages[messages.length - 1] = {
                    ...last,
                    role: textRole,
                    text: replace ? chunk : `${last.text || ''}${chunk}`,
                    streaming: true,
                    at: Date.now(),
                    ...(textRole === 'plan'
                      ? { planState: last.planState || ('open' as const) }
                      : {}),
                  }
                } else {
                  messages.push({
                    id: `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
                    role: textRole,
                    text: chunk,
                    streaming: true,
                    at: Date.now(),
                    ...(textRole === 'plan' ? { planState: 'open' as const } : {}),
                  })
                }
                return { ...t, messages, running: true }
              }),
            )
          } else if (
            msg.type === 'thinking-delta' ||
            msg.type === 'thinking-snapshot'
          ) {
            const chunk = String(msg.text || '')
            if (!chunk) return
            const cid = chatId || activeIdRef.current
            if (!cid) return
            if (forActive) {
              setStreaming(true)
              setPhase('thinking', 'thinking…')
            }
            const replace = msg.type === 'thinking-snapshot'
            setTabs((prev) =>
              prev.map((t) => {
                if (t.id !== cid) return t
                const messages = t.messages.slice()
                let idx = -1
                for (let i = messages.length - 1; i >= 0; i--) {
                  if (messages[i]!.role === 'thinking' && messages[i]!.streaming) {
                    idx = i
                    break
                  }
                }
                if (idx < 0) {
                  messages.push({
                    id: `th-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
                    role: 'thinking',
                    text: chunk,
                    streaming: true,
                    at: Date.now(),
                  })
                } else {
                  const cur = messages[idx]!
                  messages[idx] = {
                    ...cur,
                    text: replace ? chunk : `${cur.text || ''}${chunk}`,
                    streaming: true,
                  }
                }
                return { ...t, messages, running: true }
              }),
            )
          } else if (msg.type === 'thinking-completed') {
            const cid = chatId || activeIdRef.current
            if (cid) {
              const ms = typeof msg.ms === 'number' ? msg.ms : undefined
              setTabs((prev) =>
                prev.map((t) => {
                  if (t.id !== cid) return t
                  const messages = t.messages.slice()
                  for (let i = messages.length - 1; i >= 0; i--) {
                    const m = messages[i]!
                    if (m.role === 'thinking' && m.streaming) {
                      messages[i] = {
                        ...m,
                        streaming: false,
                        durationMs: ms ?? m.durationMs,
                      }
                      break
                    }
                  }
                  return { ...t, messages }
                }),
              )
            }
            if (!forActive) return
            setPhase('streaming', '')
            pushRunLog('thinking done')
          } else if (msg.type === 'tool-delta') {
            const st = String(msg.status || '')
            const callId = msg.callId ? String(msg.callId) : ''
            const name = String(msg.name || 'tool')
            const detail = msg.detail != null ? String(msg.detail) : undefined
            const cid = chatId || activeIdRef.current
            if (cid) {
              setTabs((prev) =>
                prev.map((t) => {
                  if (t.id !== cid) return t
                  const messages = t.messages.slice()
                  // Seal open answers so follow-up text appears below this tool.
                  const answerRoles = new Set(['assistant', 'ask', 'debug', 'plan'])
                  for (let i = 0; i < messages.length; i++) {
                    const m = messages[i]!
                    if (answerRoles.has(m.role) && m.streaming) {
                      messages[i] = { ...m, streaming: false }
                    }
                  }
                  let idx = -1
                  if (callId) {
                    idx = messages.findIndex(
                      (m) => m.role === 'tool' && m.tool?.callId === callId,
                    )
                  }
                  const toolPatch = {
                    name,
                    status: st || 'running',
                    detail,
                    callId: callId || undefined,
                    sessionId: msg.sessionId ? String(msg.sessionId) : undefined,
                    path: msg.path != null ? String(msg.path) : undefined,
                    command: msg.command != null ? String(msg.command) : undefined,
                    output: msg.output != null ? String(msg.output) : undefined,
                    before: msg.before != null ? String(msg.before) : undefined,
                    after: msg.after != null ? String(msg.after) : undefined,
                  }
                  if (idx < 0) {
                    messages.push({
                      id: `tool-${callId || Date.now().toString(36)}`,
                      role: 'tool',
                      text: '',
                      at: Date.now(),
                      tool: toolPatch,
                    })
                  } else {
                    const cur = messages[idx]!
                    messages[idx] = {
                      ...cur,
                      at: Date.now(),
                      tool: {
                        ...cur.tool,
                        ...toolPatch,
                        name,
                        status: st || cur.tool?.status || 'running',
                        detail: detail ?? cur.tool?.detail,
                        callId: callId || cur.tool?.callId,
                        sessionId: msg.sessionId
                          ? String(msg.sessionId)
                          : cur.tool?.sessionId,
                        path: toolPatch.path ?? cur.tool?.path,
                        command: toolPatch.command ?? cur.tool?.command,
                        output: toolPatch.output ?? cur.tool?.output,
                        before: toolPatch.before ?? cur.tool?.before,
                        after: toolPatch.after ?? cur.tool?.after,
                      },
                    }
                  }
                  const filePayload = msg.file as
                    | { path?: string; action?: string; before?: string; after?: string }
                    | undefined
                  if (filePayload?.path && st === 'completed') {
                    messages.push({
                      id: `file-${callId || Date.now().toString(36)}`,
                      role: 'file',
                      text: '',
                      at: Date.now(),
                      file: {
                        path: String(filePayload.path),
                        action: String(filePayload.action || name),
                        before:
                          filePayload.before != null
                            ? String(filePayload.before)
                            : undefined,
                        after:
                          filePayload.after != null
                            ? String(filePayload.after)
                            : undefined,
                      },
                    })
                  }
                  return { ...t, messages, running: true }
                }),
              )
            }
            if (!forActive) return
            const toolLabel = prettyToolName(name)
            if (st === 'completed') {
              pushRunLog(`tool done · ${toolLabel}`)
              setPhase('streaming', '')
            } else if (st === 'error') {
              pushRunLog(`tool error · ${toolLabel}`)
              setPhase('error', `${toolLabel} failed`)
            } else {
              pushRunLog(`tool · ${toolLabel}`)
              setPhase('tool', `${toolLabel}…`)
            }
          } else if (msg.type === 'todo-delta') {
            const cid = chatId || activeIdRef.current
            const todos = Array.isArray(msg.todos) ? msg.todos : []
            if (cid && todos.length) {
              setTabs((prev) =>
                prev.map((t) => {
                  if (t.id !== cid) return t
                  const messages = t.messages.slice()
                  for (let i = 0; i < messages.length; i++) {
                    const m = messages[i]!
                    if (
                      (m.role === 'assistant' ||
                        m.role === 'ask' ||
                        m.role === 'debug' ||
                        m.role === 'plan') &&
                      m.streaming
                    ) {
                      messages[i] = { ...m, streaming: false }
                    }
                  }
                  const callId = msg.callId ? String(msg.callId) : ''
                  let idx = callId
                    ? messages.findIndex((m) => m.role === 'todo' && m.tool?.callId === callId)
                    : -1
                  if (idx < 0) {
                    idx = [...messages].reverse().findIndex((m) => m.role === 'todo')
                    if (idx >= 0) idx = messages.length - 1 - idx
                  }
                  const summary =
                    msg.detail != null
                      ? String(msg.detail)
                      : `${todos.filter((x: { status?: string }) => x.status === 'completed').length}/${todos.length} tasks`
                  const next = {
                    id: callId ? `todo-${callId}` : `todo-${Date.now().toString(36)}`,
                    role: 'todo' as const,
                    text: summary,
                    at: Date.now(),
                    todos: todos as ChatMsg['todos'],
                    tool: {
                      name: 'updateTodos',
                      status: String(msg.status || 'completed'),
                      detail: summary,
                      callId: callId || undefined,
                    },
                  }
                  if (idx < 0) messages.push(next)
                  else messages[idx] = { ...messages[idx]!, ...next, id: messages[idx]!.id }
                  return { ...t, messages, running: true }
                }),
              )
            }
            if (forActive) {
              pushRunLog('todos updated')
              setPhase('tool', 'todos…')
            }
          } else if (msg.type === 'plan-delta') {
            const cid = chatId || activeIdRef.current
            const plan = String(msg.plan || '')
            if (cid && plan.trim()) {
              setTabs((prev) =>
                prev.map((t) => {
                  if (t.id !== cid) return t
                  const messages = t.messages.slice()
                  const callId = msg.callId ? String(msg.callId) : ''
                  let idx = callId
                    ? messages.findIndex((m) => m.role === 'plan' && m.tool?.callId === callId)
                    : -1
                  if (idx < 0) {
                    idx = [...messages]
                      .reverse()
                      .findIndex((m) => m.role === 'plan' && (m.planState || 'open') === 'open')
                    if (idx >= 0) idx = messages.length - 1 - idx
                  }
                  const next: ChatMsg = {
                    id: callId ? `plan-${callId}` : `plan-${Date.now().toString(36)}`,
                    role: 'plan',
                    text: plan,
                    at: Date.now(),
                    planState: 'open',
                    tool: {
                      name: 'createPlan',
                      status: String(msg.status || 'completed'),
                      callId: callId || undefined,
                    },
                  }
                  if (idx < 0) messages.push(next)
                  else messages[idx] = { ...messages[idx]!, ...next, id: messages[idx]!.id }
                  return { ...t, messages, running: true }
                }),
              )
            }
            if (forActive) {
              pushRunLog('plan ready')
              setPhase('streaming', '')
            }
          } else if (msg.type === 'task-delta') {
            const cid = chatId || activeIdRef.current
            if (cid) {
              const callId = msg.callId ? String(msg.callId) : ''
              const detail = String(msg.detail || msg.taskName || 'Task')
              const st = String(msg.status || 'running')
              setTabs((prev) =>
                prev.map((t) => {
                  if (t.id !== cid) return t
                  const messages = t.messages.slice()
                  for (let i = 0; i < messages.length; i++) {
                    const m = messages[i]!
                    if (
                      (m.role === 'assistant' ||
                        m.role === 'ask' ||
                        m.role === 'debug' ||
                        m.role === 'plan') &&
                      m.streaming
                    ) {
                      messages[i] = { ...m, streaming: false }
                    }
                  }
                  let idx = callId
                    ? messages.findIndex((m) => m.role === 'task' && m.tool?.callId === callId)
                    : -1
                  const next: ChatMsg = {
                    id: callId ? `task-${callId}` : `task-${Date.now().toString(36)}`,
                    role: 'task',
                    text: detail,
                    at: Date.now(),
                    task: { status: st, name: String(msg.taskName || detail) },
                    tool: { name: 'task', status: st, detail, callId: callId || undefined },
                  }
                  if (idx < 0) messages.push(next)
                  else messages[idx] = { ...messages[idx]!, ...next, id: messages[idx]!.id }
                  return { ...t, messages, running: true }
                }),
              )
            }
            if (forActive) pushRunLog(`task · ${String(msg.taskName || msg.detail || 'subagent')}`)
          } else if (msg.type === 'mode') {
            const nextMode = String(msg.mode || '')
            if (CHAT_MODES.some((m) => m.id === nextMode)) {
              setMode(nextMode as ChatMode)
              try {
                localStorage.setItem(MODE_STORAGE_KEY, nextMode)
              } catch {
                /* ignore */
              }
            }
            const cid = chatId || (msg.chatId ? String(msg.chatId) : activeIdRef.current)
            if (cid) {
              setTabs((prev) =>
                prev.map((t) =>
                  t.id === cid ? { ...t, mode: nextMode as ChatMode } : t,
                ),
              )
            }
          } else if (msg.type === 'shell-delta') {
            const chunk = String(msg.text || '')
            if (msg.sudoPrompt || /\[sudo\]\s+password/i.test(chunk)) {
              setSudoOpen(true)
              const cleaned = chunk.replace(/\r/g, '')
              const forMatch = cleaned.match(/\[sudo\]\s+password for:\s*(.+)/i)
              const cmdHint =
                String(msg.command || msg.sudoCommand || '').trim() ||
                (forMatch?.[1] || '').trim() ||
                cleaned.trim().slice(0, 200)
              if (cmdHint) setSudoCommand(cmdHint)
              setSudoPromptLabel('[sudo] password required')
              if (msg.sessionId) setSudoSessionId(String(msg.sessionId))
              if (msg.callId) setSudoCallId(String(msg.callId))
              setPhase('sudo', 'sudo password needed…')
              pushRunLog('sudo password prompt detected')
            } else if (forActive && chunk.trim()) {
              pushRunLog(`shell · ${chunk.trim().slice(0, 80)}`)
            }
          } else if (msg.type === 'sudo-request') {
            setSudoOpen(true)
            setSudoId(String(msg.id || ''))
            setSudoCommand(String(msg.command || msg.detail || '').trim())
            setSudoPromptLabel(String(msg.prompt || '[sudo] password required'))
            setSudoHasVault(Boolean(msg.hasPersistent || msg.hasSession || msg.cached))
            if (msg.sessionId) setSudoSessionId(String(msg.sessionId))
            if (msg.callId) setSudoCallId(String(msg.callId))
            setPhase('sudo', 'sudo password needed…')
            pushRunLog(
              `sudo-request · ${String(msg.command || msg.prompt || 'elevated command').slice(0, 80)}`,
            )
          } else if (msg.type === 'sudo-ack') {
            setSudoBusy(false)
            if (msg.ok) {
              setSudoPassword('')
              setSudoOpen(false)
              setSudoCommand('')
              setSudoPromptLabel('')
              setSudoId('')
              setSudoCachedTtl(Number(msg.ttlSec) || (msg.cleared || msg.denied ? 0 : 300))
              setSudoHasVault(Boolean(msg.cached || msg.persistent) && !msg.cleared)
              pushRunLog(
                msg.cleared
                  ? 'sudo vault cleared'
                  : msg.denied
                    ? 'sudo denied'
                    : msg.allowed
                      ? 'sudo allowed (vault)'
                      : `sudo vaulted · ttl=${msg.ttlSec || '?'}s fed=${!!msg.fedSession}`,
              )
              setPhase(streamingRef.current ? 'tool' : 'idle', streamingRef.current ? 'continuing…' : '')
            } else {
              setError(String(msg.error || 'sudo failed'))
              pushRunLog(`sudo failed · ${msg.error || '?'}`)
            }
          } else if (msg.type === 'status-delta') {
            if (!forActive) return
            const label = String(msg.text || msg.phase || '')
              .replace(/-/g, ' ')
              .trim()
            if (label && !/^(token delta|turn ended)$/i.test(label)) {
              setPhase('streaming', label)
              pushRunLog(`status · ${label}`)
            }
          } else if (msg.type === 'done') {
            const err =
              String(msg.status || '').toLowerCase() === 'error' ||
              String(msg.status || '').toLowerCase() === 'failed'
            const cid = chatId || activeIdRef.current
            if (cid) {
              setTabs((prev) =>
                prev.map((t) => {
                  if (t.id !== cid) return t
                  return {
                    ...t,
                    running: false,
                    messages: t.messages.map((m) =>
                      m.streaming ? { ...m, streaming: false } : m,
                    ),
                  }
                }),
              )
            }
            if (forActive) {
              setStreaming(false)
              if (err) {
                const detail = `Agent run ended with error (${msg.status}) — you can continue this chat.`
                setError(detail)
                setPhase('error', 'error')
                pushRunLog(`done · error status=${msg.status}`)
                console.error('[cursor]', detail, msg)
              } else {
                setError('')
                setPhase('done', 'done')
                pushRunLog(`done · status=${msg.status || 'ok'}`)
                if (doneClearTimer.current) window.clearTimeout(doneClearTimer.current)
                doneClearTimer.current = window.setTimeout(() => {
                  setPhase('idle', '')
                  doneClearTimer.current = null
                }, 2500)
              }
            }
            if (notifyRef.current) {
              const tab = tabsRef.current.find((t) => t.id === (chatId || activeIdRef.current))
              const label = tab?.title || 'Chat'
              notifyRef.current.ping({
                title: err ? 'Cursor finished with error' : 'Cursor finished',
                body: `${label} is ready to check`,
                level: err ? 'error' : 'success',
                category: 'cursor',
              })
            }
            // Home Agent talk mode: speak the assistant reply (works without mic).
            if (!err && voiceModeRef.current && forActive) {
              const tab = tabsRef.current.find((t) => t.id === (chatId || activeIdRef.current))
              const lastAssistant = [...(tab?.messages || [])]
                .reverse()
                .find((m) => m.role === 'assistant' && (m.text || '').trim())
              if (lastAssistant?.text) {
                try {
                  speakText(lastAssistant.text)
                } catch (e) {
                  console.error('[home-agent] speak failed', e)
                }
              }
            }
          } else if (msg.type === 'error') {
            const detail = String(msg.error || 'Agent error')
            const stuckBusy =
              !!msg.busy || /already has active run|stuck run/i.test(detail)
            const tip = stuckBusy
              ? `${detail} — press Stop, then send again.`
              : `${detail} — chat is still open; you can send again.`
            if (forActive) {
              // Keep Stop visible for stuck SDK runs (Home Base lock may already be clear).
              if (stuckBusy) {
                setStreaming(true)
                setTabs((prev) =>
                  prev.map((t) =>
                    t.id === (chatId || activeIdRef.current) ? { ...t, running: true } : t,
                  ),
                )
                setPhase('busy', 'stuck — press Stop')
              } else {
                setStreaming(false)
                setPhase('error', 'error')
              }
              setError(tip)
              pushRunLog(`error · ${detail}`)
              console.error('[cursor]', tip, msg)
            }
            if (!stuckBusy && notifyRef.current) {
              notifyRef.current.ping({
                title: 'Cursor error',
                body: tip.slice(0, 160),
                level: 'error',
                category: 'cursor',
              })
            }
          } else if (msg.type === 'cancelled') {
            if (!forActive) return
            setQueuedCount(0)
            const cid = chatId || activeIdRef.current
            if (msg.ok === false) {
              setError(
                'No live run on the server. Send again — orphaned agent runs are cleared automatically.',
              )
              setStreaming(false)
              setPhase('idle', '')
              if (cid) {
                setTabs((prev) =>
                  prev.map((t) => (t.id === cid ? { ...t, running: false } : t)),
                )
              }
              return
            }
            pushRunLog('stop requested — run is ending on the server')
            setPhase('busy', 'stopping…')
            // Orphan-only cancels never emit done — clear chrome if still stopping.
            window.setTimeout(() => {
              if (phaseRef.current !== 'busy') return
              const tab = tabsRef.current.find((t) => t.id === cid)
              if (tab?.running) return // live run will clear via done/tab
              setStreaming(false)
              setPhase('idle', '')
              setError('')
            }, 2000)
          } else if (msg.type === 'queued') {
            if (!forActive) return
            setQueuedCount(Number(msg.position) || 0)
            pushRunLog(`queued · #${msg.position || '?'} ${String(msg.prompt || '').slice(0, 40)}`)
            setPhase('busy', `queued (#${msg.position || '?'})`)
          } else if (msg.type === 'agent') {
            if (!forActive) return
            if (msg.agentId) setAgentId(String(msg.agentId))
          }
        } catch {
          /* ignore */
        }
      },
    })
    wsHandleRef.current = handle

    return () => {
      handle.dispose()
      if (wsHandleRef.current === handle) wsHandleRef.current = null
      wsRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id])


  function chooseModel(id: string) {
    setModel(id)
    try {
      localStorage.setItem(MODEL_STORAGE_KEY, id)
    } catch {
      /* ignore */
    }
  }

  function chooseMode(next: ChatMode) {
    setMode(next)
    try {
      localStorage.setItem(MODE_STORAGE_KEY, next)
    } catch {
      /* ignore */
    }
  }

  function chooseApprovalPolicy(next: ApprovalPolicy) {
    setApprovalPolicy(next)
    try {
      localStorage.setItem(APPROVAL_STORAGE_KEY, next)
    } catch {
      /* ignore */
    }
    wsRef.current?.send(JSON.stringify({ type: 'approval_policy', policy: next }))
  }

  function decideApproval(id: string, decision: 'allow' | 'deny') {
    wsRef.current?.send(
      JSON.stringify({
        type: 'approve',
        id,
        decision,
        allow: decision === 'allow',
        denied: decision === 'deny',
      }),
    )
    setPendingApprovals((prev) => prev.filter((p) => p.id !== id))
  }

  function planAction(messageId: string, action: 'build' | 'cancel') {
    if (!active?.id || !socketOpen()) return
    wsRef.current?.send(
      JSON.stringify({
        type: 'plan_action',
        chatId: active.id,
        messageId,
        action,
        model,
      }),
    )
    if (action === 'build') chooseMode('agent')
  }

  function applyFixFromDebug(_messageId: string, text: string) {
    chooseMode('agent')
    if (!active?.id || !socketOpen() || !text.trim()) return
    wsRef.current?.send(
      JSON.stringify({
        type: 'send',
        chatId: active.id,
        prompt:
          'Apply a fix based on this debug finding. Prefer a concrete patch over further diagnosis.\n\n' +
          text.trim(),
        model,
        mode: 'agent',
      }),
    )
  }

  function socketOpen() {
    return !!wsRef.current && wsRef.current.readyState === WebSocket.OPEN
  }

  function createChat(cwd = '', title?: string) {
    if (!socketOpen()) {
      setError('Reconnecting to the server — try again in a moment.')
      return
    }
    const resolvedCwd = (cwd || defaultCwd || '').trim()
    const resolvedTitle =
      title ||
      (resolvedCwd && defaultCwd && resolvedCwd === defaultCwd.trim()
        ? defaultCwdLabel || 'Vision'
        : '')
    followServerActive.current = true
    wsRef.current?.send(
      JSON.stringify({ type: 'new', cwd: resolvedCwd, title: resolvedTitle || '' }),
    )
    setNewOpen(false)
    setPickingFolder(false)
  }

  function confirmDelete() {
    if (!deleteId || !socketOpen()) {
      setDeleteId(null)
      return
    }
    wsRef.current?.send(JSON.stringify({ type: 'delete', chatId: deleteId }))
    setDeleteId(null)
  }

  async function openFolderPicker() {
    if (!project) return
    setPickingFolder(true)
    setPickerDir('')
    const data = await api.fsList(project.id, '')
    setPickerEntries(data.entries.filter((e) => e.type === 'dir'))
  }

  async function browsePicker(path: string) {
    if (!project) return
    setPickerDir(path)
    const data = await api.fsList(project.id, path)
    setPickerEntries(data.entries.filter((e) => e.type === 'dir'))
  }

  async function fileToChatImage(file: File): Promise<ChatImage | null> {
    const mime = (file.type || '').toLowerCase()
    if (!/^image\/(png|jpe?g|gif|webp)$/.test(mime)) {
      setError('Only PNG, JPEG, GIF, or WebP images are supported.')
      return null
    }
    const result = await fileToCompressedChatImage(file, MAX_DRAFT_IMAGE_BYTES)
    if (!result) {
      setError(
        file.size > MAX_DRAFT_IMAGE_BYTES
          ? 'Could not shrink that image enough to attach (4 MB max).'
          : 'Could not read that image.',
      )
      return null
    }
    if (result.toBytes < result.fromBytes && result.fromBytes > MAX_DRAFT_IMAGE_BYTES) {
      notify?.ping({
        title: 'Sorry — image was reduced',
        body: `From ${formatMb(result.fromBytes)} to ${formatMb(result.toBytes)} so it could attach.`,
        level: 'info',
        category: 'chat-image',
      })
    }
    return result.image
  }

  async function addDraftFiles(files: FileList | File[] | null) {
    if (!files?.length) return
    const list = Array.from(files)
    const next = [...draftImages]
    for (const file of list) {
      if (next.length >= MAX_DRAFT_IMAGES) {
        setError(`At most ${MAX_DRAFT_IMAGES} images per message.`)
        break
      }
      const img = await fileToChatImage(file)
      if (img) next.push(img)
    }
    setDraftImages(next)
  }

  function removeDraftImage(idx: number) {
    setDraftImages((prev) => prev.filter((_, i) => i !== idx))
  }

  function syncAtMention(value: string, caret: number) {
    setAtMention(detectAtMention(value, caret))
  }

  function addContextPath(pick: AtPick) {
    setDraftContext((prev) => {
      if (prev.includes(pick.path)) return prev
      if (prev.length >= MAX_DRAFT_CONTEXT) {
        setError(`At most ${MAX_DRAFT_CONTEXT} @ context paths per message.`)
        return prev
      }
      return [...prev, pick.path]
    })
    if (atMention) {
      const before = input.slice(0, atMention.start)
      const after = input.slice(atMention.start + 1 + atMention.query.length)
      const next = `${before}${after.replace(/^\s/, '')}`
      setInput(next)
      const caret = before.length
      requestAnimationFrame(() => {
        const ta = textareaRef.current
        if (ta) {
          ta.focus()
          ta.setSelectionRange(caret, caret)
        }
      })
    }
    setAtMention(null)
  }

  function removeDraftContext(path: string) {
    setDraftContext((prev) => prev.filter((p) => p !== path))
  }

  function insertAtMention() {
    const ta = textareaRef.current
    const start = ta?.selectionStart ?? input.length
    const end = ta?.selectionEnd ?? start
    const next = `${input.slice(0, start)}@${input.slice(end)}`
    setInput(next)
    const caret = start + 1
    setAtMention({ start, query: '' })
    requestAnimationFrame(() => {
      ta?.focus()
      ta?.setSelectionRange(caret, caret)
    })
  }

  function send(
    e?: FormEvent,
    opts?: { prompt?: string; replaceLastUser?: boolean; skipOptimistic?: boolean },
  ) {
    e?.preventDefault()
    const images = draftImages
    const contextPaths = draftContext
    let prompt = (opts?.prompt ?? input).trim()
    if (!prompt && images.length) {
      prompt =
        images.length === 1
          ? 'Please look at the attached image.'
          : `Please look at the ${images.length} attached images.`
    }
    if (!prompt && contextPaths.length) {
      prompt =
        contextPaths.length === 1
          ? 'Please review the attached file.'
          : `Please review the ${contextPaths.length} attached paths.`
    }
    if ((!prompt && !images.length && !contextPaths.length) || !active) return
    if (!socketOpen()) {
      setError('Reconnecting to the server — try again in a moment.')
      return
    }
    const replaceLastUser = opts?.replaceLastUser ?? editingLast
    setError('')
    const queueing = streaming && !replaceLastUser
    if (!queueing) {
      setStreaming(true)
      setPhase('starting', 'starting…')
      setRunLog([])
    } else {
      setPhase('busy', 'queued…')
    }
    pushRunLog(
      `${queueing ? 'queue' : 'send'} · mode=${mode} model=${model || defaultModel}${
        replaceLastUser ? ' · edit' : ''
      }${images.length ? ` · ${images.length} img` : ''}${
        contextPaths.length ? ` · ${contextPaths.length} @` : ''
      }`,
    )
    setSettingsOpen(false)
    stickBottom.current = true
    setShowJump(false)
    setEditingLast(false)
    setAtMention(null)
    if (!opts?.prompt) {
      setInput('')
      if (project?.id && active.id) clearChatDraft(project.id, active.id)
    }
    setDraftImages([])
    setDraftContext([])
    // Voice mode: pause mic while sending, then resume listen if mic works.
    if (isAgent && voiceModeRef.current) {
      stopListening()
      if (canSpeak) {
        window.setTimeout(() => {
          if (voiceModeRef.current) beginListen('')
        }, 400)
      }
    }
    const chatId = active.id
    if (!opts?.skipOptimistic && !queueing) {
      setTabs((prev) =>
        prev.map((t) => {
          if (t.id !== chatId) return t
          let messages = t.messages
          if (replaceLastUser) {
            let lastUser = -1
            for (let i = messages.length - 1; i >= 0; i--) {
              if (messages[i]!.role === 'user') {
                lastUser = i
                break
              }
            }
            if (lastUser >= 0) messages = messages.slice(0, lastUser)
          }
          return {
            ...t,
            running: true,
            messages: [
              ...messages,
              {
                id: `pending-${Date.now()}`,
                role: 'user',
                text: prompt,
                at: Date.now(),
                ...(images.length ? { images } : {}),
                ...(contextPaths.length ? { contextPaths } : {}),
              },
            ],
          }
        }),
      )
    }
    wsRef.current?.send(
      JSON.stringify({
        type: 'send',
        prompt,
        model: model || defaultModel,
        mode,
        approvalPolicy,
        chatId: active.id,
        cwd: active.cwd || undefined,
        replaceLastUser,
        queueIfBusy: true,
        images: images.map((img) => ({
          mimeType: img.mimeType,
          data: img.data,
          name: img.name,
          width: img.width,
          height: img.height,
        })),
        contextPaths,
      }),
    )
  }

  // Add-app → Ask Chat: seed (and optionally send) once the project socket is live.
  useEffect(() => {
    if (!project?.id || !connected) return
    const pending = peekPendingCompose()
    if (!pending || pending.projectId !== project.id) return
    const applyKey = `${pending.projectId}:${pending.text.slice(0, 48)}`
    if (pendingComposeApplied.current === applyKey) return

    if (!activeId) {
      if (pendingComposeCreating.current !== applyKey && socketOpen()) {
        pendingComposeCreating.current = applyKey
        followServerActive.current = true
        wsRef.current?.send(
          JSON.stringify({
            type: 'new',
            cwd: '',
            title: pending.title || 'Wire app',
          }),
        )
      }
      return
    }

    const taken = takePendingCompose(project.id)
    if (!taken) return
    pendingComposeApplied.current = applyKey
    pendingComposeCreating.current = ''
    setInput(taken.text)
    writeChatDraft(project.id, activeId, taken.text)
    if (taken.autoSend) {
      window.setTimeout(() => {
        if (!socketOpen() || streamingRef.current) return
        send(undefined, { prompt: taken.text })
        clearChatDraft(project.id, activeId)
        setInput('')
      }, 180)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- send/socketOpen close over latest active chat
  }, [project?.id, connected, activeId])

  function cancel() {
    if (!active) return
    pushRunLog('stop requested')
    setQueuedCount(0)
    setError('')
    // Keep Stop/busy chrome until the server acks; hide only on done/cancelled/idle.
    setStreaming(true)
    setPhase('busy', 'stopping…')
    wsRef.current?.send(JSON.stringify({ type: 'cancel', chatId: active.id }))
  }

  function regenerate() {
    if (!active || !socketOpen() || streaming) return
    setError('')
    setStreaming(true)
    setPhase('starting', 'regenerating…')
    stickBottom.current = true
    pushRunLog('regenerate')
    wsRef.current?.send(
      JSON.stringify({
        type: 'regenerate',
        chatId: active.id,
        model: model || defaultModel,
        mode,
      }),
    )
  }

  function editLastUser(text: string, contextPaths?: string[]) {
    setInput(text)
    setDraftContext(contextPaths ? [...contextPaths] : [])
    setEditingLast(true)
    setSettingsOpen(false)
    setAtMention(null)
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (atMention) {
        e.preventDefault()
        setAtMention(null)
        return
      }
      const canStop =
        streaming ||
        !!active?.running ||
        agentPhase === 'busy' ||
        /stuck run|already has active run|press Stop/i.test(error)
      if (canStop) {
        e.preventDefault()
        cancel()
      } else if (editingLast) {
        setEditingLast(false)
      } else if (settingsOpen) {
        setSettingsOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, editingLast, settingsOpen, active?.id, atMention, agentPhase, error, active?.running])

  // Outside click / tap dismisses the chat options sheet (gear).
  useEffect(() => {
    if (!settingsOpen) return
    const onPointer = (e: PointerEvent) => {
      const t = e.target
      if (!(t instanceof Element)) return
      if (t.closest('.hb-chat-sheet, .hb-chat-opt-btn')) return
      setSettingsOpen(false)
    }
    document.addEventListener('pointerdown', onPointer, true)
    return () => document.removeEventListener('pointerdown', onPointer, true)
  }, [settingsOpen])

  // Restore mode/model when switching chats (per-tab when server has them).
  useEffect(() => {
    const tab = tabs.find((t) => t.id === activeId)
    if (!tab) return
    if (tab.mode && CHAT_MODES.some((m) => m.id === tab.mode)) {
      setMode(tab.mode as ChatMode)
    }
    if (tab.model) setModel(tab.model)
    setAgentId(tab.agentId || null)
  }, [activeId])

  function jumpToBottom() {
    stickBottom.current = true
    setShowJump(false)
    const el = listRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  function copyMessage(text: string) {
    void copyText(text)
  }

  function submitSudo(e?: FormEvent) {
    e?.preventDefault()
    const pw = sudoPassword
    if (!pw || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    setSudoBusy(true)
    pushRunLog(
      sudoRemember
        ? 'saving encrypted sudo password (not logged)'
        : 'submitting sudo password (not logged)',
    )
    wsRef.current.send(
      JSON.stringify({
        type: 'sudo',
        password: pw,
        persistent: sudoRemember,
        id: sudoId || undefined,
        sessionId: sudoSessionId,
        callId: sudoCallId,
        chatId: activeIdRef.current,
      }),
    )
  }

  function allowSavedSudo() {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    setSudoBusy(true)
    pushRunLog('allowing vaulted sudo for this command')
    wsRef.current.send(JSON.stringify({ type: 'sudo_allow', id: sudoId || undefined }))
  }

  function denySudoPrompt() {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'sudo_deny', id: sudoId || undefined }))
    } else {
      void api.denySudo(sudoId || undefined).catch(() => undefined)
    }
    setSudoOpen(false)
    setSudoPassword('')
    setSudoCommand('')
    setSudoPromptLabel('')
    setSudoId('')
    setPhase(streamingRef.current ? 'tool' : 'idle', streamingRef.current ? 'continuing…' : '')
  }

  function clearSudoVault() {
    wsRef.current?.send(JSON.stringify({ type: 'sudo_clear_persistent' }))
    setSudoCachedTtl(0)
    setSudoHasVault(false)
    setSudoOpen(false)
    setSudoPassword('')
  }

  function presentFromChat(req: PresentRequest) {
    pushRunLog(`present · ${req.scene}${req.path ? ` ${req.path}` : ''}`)
    // Message/tool “Show” sets minimal — keep it inside the Work chat dock.
    // Settings Apps/Files/Sessions omit minimal → real Work navigation.
    if (
      isDock &&
      (req.scene === 'shell' || req.scene === 'files') &&
      req.minimal === true
    ) {
      setDockPresent({ ...req, minimal: true })
      setDockOpen(true)
      return
    }
    setDockPresent(null)
    onPresent?.(req)
    if (isDock) setDockOpen(false)
  }

  const listenGen = useRef(0)

  function stopListening() {
    listenGen.current += 1
    const handle = speechRef.current
    speechRef.current = null
    setListening(false)
    handle?.stop()
  }

  function beginListen(prefix?: string) {
    const gen = ++listenGen.current
    const prev = speechRef.current
    speechRef.current = null
    setListening(false)
    prev?.stop()
    notify?.unlockAudio()
    // Freeze composer prefix for the whole listen session — speech.ts owns the
    // cumulative transcript so words append instead of overwriting / doubling.
    inputBeforeSpeech.current = (prefix ?? input).trim()
    const applySpeech = (text: string) => {
      if (gen !== listenGen.current) return
      const base = inputBeforeSpeech.current
      setInput(base ? `${base} ${text}` : text)
    }
    const handle = startSpeechDictation({
      onPartial: applySpeech,
      onFinal: applySpeech,
      onError: (message) => {
        if (gen !== listenGen.current) return
        if (isAgent) reportAgentIssue(message)
        else setError(message)
      },
      onEnd: () => {
        if (gen !== listenGen.current) return
        speechRef.current = null
        setListening(false)
        // Home Agent voice mode: engine ended — keep mode on, restart if still armed.
        if (voiceModeRef.current && isAgent) {
          window.setTimeout(() => {
            if (voiceModeRef.current && listenGen.current === gen) beginListen()
          }, 250)
        }
      },
      lang: 'en-US',
    })
    if (!handle) return
    if (gen !== listenGen.current) {
      handle.stop()
      return
    }
    speechRef.current = handle
    setListening(true)
    setError('')
  }

  function reportAgentIssue(message: string, level: 'error' | 'warn' = 'error') {
    const text = message.trim()
    if (!text) return
    setError(text)
    console.error('[home-agent]', text)
    try {
      notify?.ping({
        title: level === 'error' ? 'Agent error' : 'Agent',
        body: text.slice(0, 200),
        level,
        category: 'home-agent',
      })
    } catch {
      /* ignore */
    }
  }

  function toggleListen() {
    if (isAgent) {
      if (voiceMode) {
        setVoiceMode(false)
        voiceModeRef.current = false
        stopListening()
        stopSpeaking()
        return
      }
      // Talk mode always arms TTS for replies. Mic listen is optional.
      setVoiceMode(true)
      voiceModeRef.current = true
      notify?.unlockAudio()
      if (canSpeak) {
        beginListen()
      } else {
        stopListening()
        reportAgentIssue(
          'Microphone dictation unavailable here — Talk will still speak AI replies.',
          'warn',
        )
      }
      return
    }
    if (listening) {
      stopListening()
      return
    }
    beginListen()
  }

  useEffect(() => {
    return () => {
      listenGen.current += 1
      speechRef.current?.stop()
      stopSpeaking()
    }
  }, [])

  function resetChat() {
    if (!active || !socketOpen()) return
    wsRef.current?.send(JSON.stringify({ type: 'reset', chatId: active.id }))
  }

  // Hooks must run before any early return (oxlint rules-of-hooks).
  const statusPhasePre =
    pendingApprovals.length > 0
      ? 'approval'
      : sudoOpen
        ? 'sudo'
        : connState === 'reconnecting' || connState === 'connecting'
          ? 'starting'
          : connState === 'offline'
            ? 'error'
            : agentPhase
  const statusLivePre =
    streaming ||
    statusPhasePre === 'thinking' ||
    statusPhasePre === 'busy' ||
    statusPhasePre === 'streaming' ||
    statusPhasePre === 'tool' ||
    statusPhasePre === 'starting' ||
    statusPhasePre === 'approval' ||
    statusPhasePre === 'sudo'
  const statusNow = useNowTick(statusLivePre)

  // Home Agent: keep the locked chat selected once the workspace arrives.
  useEffect(() => {
    if (!isAgent || !agentChatId || !tabs.some((t) => t.id === agentChatId)) return
    if (activeId === agentChatId) return
    followServerActive.current = false
    setActiveId(agentChatId)
    if (socketOpen()) {
      wsRef.current?.send(JSON.stringify({ type: 'select', chatId: agentChatId }))
    }
  }, [isAgent, agentChatId, tabs, activeId])

  if (!project) {
    return (
      <div
        className={
          isDock ? 'hb-chat-dock-body' : isAgent ? 'h-full flex flex-col min-h-0' : 'h-full flex flex-col min-h-0 hb-with-nav'
        }
      >
        <p className="hb-page text-mute text-sm">
          {projects.length === 0 ? 'No projects loaded yet.' : 'Select a project.'}
        </p>
      </div>
    )
  }

  const modelOptions =
    models.length > 0
      ? models
      : [
          {
            id: model || defaultModel || 'auto',
            displayName:
              (model || defaultModel || 'auto').toLowerCase() === 'auto'
                ? 'Auto'
                : model || defaultModel || 'auto',
            description: '',
          },
        ]

  const cwdLabel = active?.cwd
    ? active.cwd.split('/').filter(Boolean).slice(-2).join('/')
    : project.name
  const pendingDelete = tabs.find((t) => t.id === deleteId)

  const modals = (
    <>
      {newOpen && (
        <div className="fixed inset-0 z-50 hb-overlay backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
          <div className="w-full max-w-md hb-surface p-4 space-y-3 max-h-[80vh] flex flex-col">
            {!pickingFolder ? (
              <>
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold text-sm">New chat</h2>
                  <button type="button" className="text-mute text-sm" onClick={() => setNewOpen(false)}>
                    Close
                  </button>
                </div>
                <button
                  type="button"
                  className="hb-btn hb-btn-primary w-full !min-h-11"
                  onClick={() => createChat()}
                >
                  {defaultCwd
                    ? defaultCwdLabel || `Vision workspace (${defaultCwd})`
                    : `Whole app (${project.name})`}
                </button>
                <button
                  type="button"
                  className="hb-btn hb-btn-ghost w-full !min-h-11"
                  onClick={() => void openFolderPicker()}
                >
                  Pick a folder…
                </button>
              </>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2">
                  <h2 className="font-semibold text-sm">Choose folder</h2>
                  <button
                    type="button"
                    className="text-mute text-sm"
                    onClick={() => setPickingFolder(false)}
                  >
                    Back
                  </button>
                </div>
                <p className="text-[11px] font-mono text-mute truncate">
                  {pickerDir ? `./${pickerDir}` : './'}
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="hb-btn hb-btn-ghost text-xs flex-1"
                    disabled={!pickerDir}
                    onClick={() => {
                      const parent = pickerDir.split('/').slice(0, -1).join('/')
                      void browsePicker(parent)
                    }}
                  >
                    Up
                  </button>
                  <button
                    type="button"
                    className="hb-btn hb-btn-primary text-xs flex-1"
                    onClick={() =>
                      createChat(
                        pickerDir,
                        pickerDir ? `./${pickerDir.split('/').pop()}` : 'New chat',
                      )
                    }
                  >
                    Start here
                  </button>
                </div>
                <ul className="flex-1 overflow-y-auto space-y-1">
                  {pickerEntries.map((e) => (
                    <li key={e.path}>
                      <button
                        type="button"
                        className="w-full text-left rounded-lg border border-line px-3 py-2.5 text-sm hover:border-sky/50 hover:bg-sky/10"
                        onClick={() => void browsePicker(e.path)}
                      >
                        <span className="text-sky font-mono text-xs mr-2">▸</span>
                        {e.name}
                      </button>
                    </li>
                  ))}
                  {pickerEntries.length === 0 && (
                    <li className="text-mute text-xs py-4 text-center">No subfolders</li>
                  )}
                </ul>
              </>
            )}
          </div>
        </div>
      )}

      {deleteId && pendingDelete && (
        <div className="fixed inset-0 z-50 hb-overlay backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
          <div className="w-full max-w-sm hb-surface p-4 space-y-4">
            <h2 className="font-semibold text-sm">Delete this chat?</h2>
            <p className="text-sm text-mute leading-relaxed">
              <span className="text-text font-medium">{pendingDelete.title}</span>
              {pendingDelete.cwd ? (
                <span className="font-mono text-sky"> · ./{pendingDelete.cwd}</span>
              ) : null}
              <br />
              This chat will be removed on the server for every browser. This cannot be undone.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                className="hb-btn hb-btn-ghost flex-1"
                onClick={() => setDeleteId(null)}
              >
                Cancel
              </button>
              <button type="button" className="hb-btn hb-btn-danger flex-1" onClick={confirmDelete}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )

  const header = isAgent ? (
    <div className="hb-agent-bar shrink-0">
      <button type="button" className="hb-btn hb-btn-ghost text-sm" onClick={() => onAgentBack?.()}>
        ← Chats
      </button>
      <div className="min-w-0 flex-1">
        <h1 className="hb-agent-bar-title truncate">{active?.title || 'Chat'}</h1>
        <p className="text-mute text-xs truncate">
          <span className={connected ? 'text-ok' : 'text-amber'}>{connStateLabel(connState)}</span>
          {' · '}
          <span className="text-sky">{cwdLabel}</span>
        </p>
      </div>
      {streaming && (
        <button type="button" className="hb-btn hb-btn-ghost text-sm text-danger" onClick={() => cancel()}>
          Stop
        </button>
      )}
      <button
        type="button"
        className="hb-agent-alerts"
        onClick={() => {
          notify?.unlockAudio()
          if (notify?.toggleInbox) notify.toggleInbox()
          else window.dispatchEvent(new Event('hb-open-inbox'))
        }}
        aria-label={
          notify && notify.unread > 0 ? `Alerts, ${notify.unread} unread` : 'Alerts'
        }
        title="Alerts"
      >
        <svg className="hb-status-alerts-icon" viewBox="0 0 24 24" aria-hidden>
          <path d="M15 17.5H5.5a1.5 1.5 0 0 1-1.3-2.25C5.3 13.4 6 11.8 6 10a6 6 0 1 1 12 0c0 1.8.7 3.4 1.8 5.25A1.5 1.5 0 0 1 18.5 17.5H15z" />
          <path d="M10 17.5v.75a2 2 0 0 0 4 0v-.75" />
        </svg>
        {!!notify?.unread && (
          <span className="hb-status-badge">{notify.unread > 9 ? '9+' : notify.unread}</span>
        )}
      </button>
    </div>
  ) : (
    <div className={`shrink-0 ${isDock ? 'hb-chat-dock-chrome' : 'hb-chrome'}`}>
      <div className={`${isDock ? 'px-3 py-2 space-y-2' : 'hb-chrome-inner space-y-2'}`}>
        {!isDock && (
          <div className="flex gap-2 items-center">
            <ProjectSelect
              projects={projects}
              selectedId={project.id}
              onSelect={onSelect}
              className="flex-1 !min-h-10 !py-2 text-sm"
            />
            <button
              type="button"
              title={connected ? 'Cursor agent socket live' : 'Tap to reconnect'}
              onClick={() => {
                if (!connected) wsHandleRef.current?.reconnect()
              }}
              className={`text-[10px] shrink-0 px-2 py-1 rounded-md border font-semibold ${
                connected
                  ? 'text-ok border-ok/30 bg-ok/10'
                  : connState === 'reconnecting' || connState === 'connecting'
                    ? 'text-amber border-amber/30 bg-amber/10'
                    : 'text-danger border-danger/30 bg-danger/10'
              }`}
            >
              {connStateLabel(connState)}
            </button>
          </div>
        )}

        <div className="flex items-center gap-1.5 relative">
          <div className="flex-1 min-w-0 flex items-center gap-1.5 overflow-x-auto pb-0.5">
            {tabs.map((t) => (
              <div
                key={t.id}
                className={`flex items-center rounded-lg border shrink-0 ${
                  t.id === activeId
                    ? 'border-accent/50 bg-accent/12'
                    : 'border-line bg-panel-2'
                }`}
              >
                <button
                  type="button"
                  onClick={() => {
                    setActiveId(t.id)
                    wsRef.current?.send(JSON.stringify({ type: 'select', chatId: t.id }))
                  }}
                  className="px-2.5 py-1.5 text-[11px] font-semibold max-w-[7.5rem] truncate"
                  title={t.cwd ? `Folder: ${t.cwd}` : `App: ${project.name}`}
                >
                  {t.title}
                </button>
                <button
                  type="button"
                  className="pr-2 pl-0.5 text-mute hover:text-danger text-sm leading-none"
                  onClick={() => setDeleteId(t.id)}
                  aria-label={`Delete ${t.title}`}
                  disabled={tabs.length <= 1}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <IconBtn
            label="New chat"
            variant="primary"
            className="!w-9 !h-9 !min-w-9"
            onClick={() => {
              setNewOpen(true)
              setPickingFolder(false)
            }}
          />
        </div>

        <div className="flex items-center gap-2 text-[11px] min-w-0">
          <span className="text-mute truncate min-w-0">
            <span className="text-sky font-medium">{cwdLabel}</span>
          </span>
          {isDock && (
            <button
              type="button"
              title={connected ? 'Cursor agent socket live' : 'Tap to reconnect'}
              onClick={() => {
                if (!connected) wsHandleRef.current?.reconnect()
              }}
              className={`text-[10px] shrink-0 px-1.5 py-0.5 rounded border font-semibold ml-auto ${
                connected
                  ? 'text-ok border-ok/30 bg-ok/10'
                  : connState === 'reconnecting' || connState === 'connecting'
                    ? 'text-amber border-amber/30 bg-amber/10'
                    : 'text-danger border-danger/30 bg-danger/10'
              }`}
            >
              {connStateLabel(connState)}
            </button>
          )}
          {!isDock && (
            <button
              type="button"
              className="text-accent font-semibold shrink-0 ml-auto"
              onClick={() => {
                setNewOpen(true)
                setPickingFolder(false)
              }}
            >
              Folder…
            </button>
          )}
        </div>
      </div>
    </div>
  )

  const modeMeta = CHAT_MODES.find((m) => m.id === mode) || CHAT_MODES[0]
  const modelLabel =
    modelOptions.find((m) => m.id === (model || defaultModel))?.displayName ||
    model ||
    defaultModel ||
    'Auto'

  const statusPhase = statusPhasePre
  const statusLive = statusLivePre
  const statusElapsedLabel = statusLive ? formatElapsed(statusNow - phaseSince) : ''
  const statusBadgeKind =
    statusPhase === 'done'
      ? 'done'
      : statusPhase === 'error'
        ? 'error'
        : statusPhase === 'thinking'
          ? 'thinking'
          : statusPhase === 'streaming'
            ? 'writing'
            : statusPhase === 'tool'
              ? 'tool'
              : statusPhase === 'starting'
                ? 'starting'
                : statusPhase === 'approval'
                  ? 'approval'
                  : statusPhase === 'sudo'
                    ? 'sudo'
                    : statusPhase === 'busy'
                      ? 'busy'
                      : streaming
                        ? 'busy'
                        : ''
  const statusBadgeText =
    statusBadgeKind === 'done'
      ? 'done'
      : statusBadgeKind === 'error'
        ? 'error'
        : statusBadgeKind && statusElapsedLabel
          ? `${statusBadgeKind} · ${statusElapsedLabel}`
          : statusBadgeKind

  const statusLabel =
    pendingApprovals.length > 0
      ? 'waiting for approval…'
      : sudoOpen
        ? 'sudo password needed…'
        : connState === 'reconnecting'
          ? streaming
            ? 'reconnecting — run continues on the server'
            : 'reconnecting…'
          : connState === 'connecting'
            ? 'connecting…'
            : connState === 'offline'
              ? 'offline'
              : activity ||
                (statusPhase === 'done'
                  ? 'done'
                  : statusPhase === 'error'
                    ? 'error'
                    : statusPhase === 'thinking'
                      ? 'thinking…'
                      : statusPhase === 'tool'
                        ? 'running tools…'
                        : statusPhase === 'streaming'
                          ? 'writing…'
                          : statusPhase === 'starting'
                            ? 'starting…'
                            : statusPhase === 'busy'
                              ? 'agent working…'
                              : streaming
                                ? 'agent working…'
                                : connected
                                  ? 'ready'
                                  : connStateLabel(connState))

  const messages = (
    <div
      ref={listRef}
      className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden overscroll-contain px-3 py-3 space-y-3"
      onScroll={(e) => {
        const el = e.currentTarget
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 72
        stickBottom.current = nearBottom
        setShowJump(!nearBottom && el.scrollHeight > el.clientHeight + 120)
      }}
    >
      {!active && (
        <p className="text-mute text-xs">Loading workspace…</p>
      )}
      {active && active.messages.length === 0 && (
        <div className="mt-2 max-w-md space-y-2">
          <p className="text-text font-semibold text-sm">
            {isAgent ? 'Agent' : isDock ? 'Work chat' : 'Local Cursor agent'}
          </p>
          <p className="text-mute text-xs leading-relaxed">
            {isAgent
              ? 'Type a message, or tap the mic for talk mode — green Confirm sends, and replies are spoken while talk mode stays on.'
              : 'Server-backed chats stream like Cursor IDE. Queue follow-ups while it runs, Esc to stop, Edit/Retry on messages, Copy on bubbles and code blocks. Gear → mode, model, tool approvals.'}
          </p>
        </div>
      )}
      {active?.messages.map((m, i, arr) => {
        const lastUserIdx = (() => {
          for (let j = arr.length - 1; j >= 0; j--) if (arr[j]!.role === 'user') return j
          return -1
        })()
        const lastAssistantIdx = (() => {
          for (let j = arr.length - 1; j >= 0; j--) {
            const r = arr[j]!.role
            if (r === 'assistant' || r === 'ask' || r === 'debug' || r === 'plan') return j
          }
          return -1
        })()
        const lastThinkingIdx = (() => {
          for (let j = arr.length - 1; j >= 0; j--) if (arr[j]!.role === 'thinking') return j
          return -1
        })()
        // Keep the latest turn's logic open so phone view still shows progress/reasoning.
        const preferThinkingOpen =
          m.role === 'thinking' && i === lastThinkingIdx && lastUserIdx >= 0 && i > lastUserIdx
        return (
          <MessageCard
            key={m.id}
            m={m}
            onPresent={onPresent ? presentFromChat : undefined}
            onCopy={copyMessage}
            onEdit={(text) => {
              editLastUser(text)
            }}
            onRegenerate={regenerate}
            onPlanAction={planAction}
            onApplyFix={applyFixFromDebug}
            canEdit={!streaming && i === lastUserIdx}
            canRegenerate={!streaming && i === lastAssistantIdx && lastUserIdx >= 0}
            preferThinkingOpen={preferThinkingOpen}
          />
        )
      })}
      {showJump && (
        <div className="hb-chat-jump">
          <button type="button" onClick={jumpToBottom}>
            Jump to latest
          </button>
        </div>
      )}
      {pendingApprovals.map((ap) => {
        const modeSwitch = ap.kind === 'mode_switch'
        return (
          <div
            key={ap.id}
            className="rounded-xl border border-amber/40 bg-amber/10 px-3 py-2.5 space-y-2 mr-4 hb-chat-enter"
          >
            <div className="flex items-center gap-2 text-xs font-semibold">
              <span className="text-amber uppercase tracking-wide text-[10px]">
                {modeSwitch ? 'Switch mode' : 'Pending approval'}
              </span>
              <span className="font-mono text-text">
                {modeSwitch ? ap.tool : ap.tool}
              </span>
            </div>
            <pre className="hb-chat-tool-detail text-[11px] text-mute max-h-28">
              {modeSwitch
                ? ap.detail || `Switch to ${ap.tool}?`
                : formatToolDetail(ap.tool, ap.command || ap.detail || ap.tool)}
            </pre>
            <div className="flex gap-2">
              <button
                type="button"
                className="flex-1 rounded-lg hb-btn-primary text-xs font-semibold py-1.5 border-0"
                onClick={() => decideApproval(ap.id, 'allow')}
              >
                {modeSwitch ? 'Switch' : 'Allow'}
              </button>
              <button
                type="button"
                className="flex-1 rounded-lg border border-danger/50 text-danger text-xs font-semibold py-1.5"
                onClick={() => decideApproval(ap.id, 'deny')}
              >
                {modeSwitch ? 'Stay' : 'Deny'}
              </button>
            </div>
          </div>
        )
      })}
      {sudoOpen && (
        <form
          onSubmit={submitSudo}
          className="rounded-xl border border-amber/45 bg-amber/10 px-3 py-2.5 space-y-2 mr-4 hb-chat-enter"
        >
          <div className="flex items-center gap-2 text-xs font-semibold flex-wrap">
            <span className="text-amber uppercase tracking-wide text-[10px]">Sudo</span>
            <span className="text-mute font-normal">
              Encrypted at rest · never used without your OK
            </span>
          </div>
          {(sudoCommand || sudoPromptLabel) && (
            <div className="rounded-lg bg-panel-2/80 border border-line/80 px-2.5 py-2">
              <div className="text-[10px] uppercase tracking-wide text-mute mb-1">
                Needs elevation for
              </div>
              <pre className="hb-chat-tool-detail text-[11px] text-text whitespace-pre-wrap break-words m-0 max-h-24 overflow-y-auto">
                {sudoCommand || sudoPromptLabel}
              </pre>
            </div>
          )}
          {sudoHasVault && (
            <button
              type="button"
              disabled={sudoBusy}
              onClick={allowSavedSudo}
              className="w-full rounded-lg hb-btn-primary text-xs font-semibold py-2 border-0 disabled:opacity-40"
            >
              {sudoBusy ? 'Allowing…' : 'Allow saved password'}
            </button>
          )}
          <input
            type="password"
            value={sudoPassword}
            onChange={(e) => setSudoPassword(e.target.value)}
            autoComplete="current-password"
            placeholder={sudoHasVault ? 'Or enter a different password' : 'sudo password'}
            className="w-full rounded-lg bg-panel-2 border border-line px-3 py-2 text-sm outline-none focus:border-accent"
            autoFocus={!sudoHasVault}
          />
          <label className="flex items-center gap-2 text-[11px] text-mute cursor-pointer select-none">
            <input
              type="checkbox"
              checked={sudoRemember}
              onChange={(e) => setSudoRemember(e.target.checked)}
              className="rounded border-line"
            />
            Save encrypted (still requires Allow each time)
          </label>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={sudoBusy || !sudoPassword}
              className="flex-1 rounded-lg hb-btn-primary text-xs font-semibold py-1.5 border-0 disabled:opacity-40"
            >
              {sudoBusy ? 'Sending…' : sudoRemember ? 'Save & use' : 'Use once'}
            </button>
            <button
              type="button"
              className="rounded-lg border border-danger/40 text-danger text-xs font-semibold px-3 py-1.5"
              onClick={denySudoPrompt}
            >
              Deny
            </button>
          </div>
        </form>
      )}
      {error && <p className="text-sm text-danger hb-chat-enter">{error}</p>}
      <div ref={bottomRef} />
    </div>
  )

  const recentRunLog = runLog.slice(-8)
  const statusBar = (
    <div className={`hb-chat-status-wrap shrink-0 ${statusPhase}`}>
      <div
        className={`hb-chat-status ${statusPhase}`}
        title={recentRunLog.join('\n') || statusLabel}
        role="status"
        aria-live="polite"
      >
        <button
          type="button"
          className="hb-chat-status-main"
          aria-expanded={statusOpen}
          aria-label={statusOpen ? 'Hide run progress' : 'Show run progress'}
          onClick={() => setStatusOpen((o) => !o)}
        >
          <span className={`hb-chat-status-dot ${statusPhase}`} aria-hidden />
          <span className="hb-chat-status-label truncate">{statusLabel}</span>
          {statusBadgeText && (
            <span
              className={`hb-chat-status-badge${
                statusBadgeKind === 'done'
                  ? ' is-done'
                  : statusBadgeKind === 'error'
                    ? ' is-error'
                    : statusBadgeKind === 'thinking'
                      ? ' is-thinking'
                      : statusBadgeKind === 'tool'
                        ? ' is-tool'
                        : statusBadgeKind === 'writing'
                          ? ' is-writing'
                          : ' is-busy'
              }`}
            >
              {statusBadgeKind && statusBadgeKind !== 'done' && statusBadgeKind !== 'error' ? (
                <span className="hb-msg-badge-dot" aria-hidden />
              ) : null}
              {statusBadgeText}
            </span>
          )}
          <span className={`hb-chat-status-chevron${statusOpen ? ' open' : ''}`} aria-hidden>
            ▾
          </span>
        </button>
        {sudoCachedTtl > 0 && (
          <button
            type="button"
            className="hb-chat-status-sudo"
            title="Clear vaulted sudo password"
            onClick={clearSudoVault}
          >
            sudo {Math.ceil(sudoCachedTtl / 60)}m
          </button>
        )}
        {!sudoOpen && (
          <button
            type="button"
            className="hb-chat-status-action"
            title="Enter sudo password for agent shell"
            onClick={() => setSudoOpen(true)}
          >
            Sudo…
          </button>
        )}
      </div>
      {statusOpen && (
        <div className="hb-chat-status-log" role="log" aria-label="Run progress">
          {recentRunLog.length === 0 ? (
            <p className="hb-chat-status-log-empty">
              {streaming ? 'Waiting for the next step…' : 'No recent steps — send a message to start.'}
            </p>
          ) : (
            <ul>
              {recentRunLog.map((line, idx) => (
                <li key={`${idx}-${line.slice(0, 24)}`}>{line}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )

  const composer = (
    <form
      onSubmit={send}
      className={`hb-chat-composer shrink-0 border-t border-line px-3 pt-2 pb-3 space-y-2 relative ${
        isDock ? 'rounded-b-2xl' : ''
      }`}
    >
      {settingsOpen && (
        <>
          <button
            type="button"
            className="hb-chat-sheet-scrim"
            aria-label="Close chat options"
            onClick={() => setSettingsOpen(false)}
          />
          <div
            className="hb-chat-sheet"
            role="dialog"
            aria-label="Chat options"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="hb-chat-sheet-handle" aria-hidden />
            <p className="text-[10px] uppercase tracking-wider text-mute font-semibold px-0.5">
              Mode
            </p>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Mode">
              {CHAT_MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  title={m.title}
                  disabled={streaming}
                  onClick={() => chooseMode(m.id)}
                  className={`px-2.5 py-1.5 rounded-lg text-[11px] font-semibold border transition-colors disabled:opacity-40 ${
                    mode === m.id
                      ? 'border-accent/50 bg-accent/15 text-accent'
                      : 'border-line bg-panel-2 text-mute hover:text-text'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 pt-1">
              <label className="text-[10px] uppercase tracking-wider text-mute font-semibold shrink-0">
                Model
              </label>
              <select
                value={model || defaultModel}
                onChange={(e) => chooseModel(e.target.value)}
                disabled={streaming}
                className="hb-select py-1.5 text-[11px] min-w-0 flex-1"
                aria-label="Model"
              >
                {modelOptions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              title={
                approvalPolicy === 'ask'
                  ? 'Tools/shell require Allow before running (safer)'
                  : 'Tools run automatically (like trusted IDE workspace)'
              }
              disabled={streaming}
              onClick={() => chooseApprovalPolicy(approvalPolicy === 'ask' ? 'auto' : 'ask')}
              className={`w-full px-3 py-2 rounded-lg text-[11px] font-semibold border text-left disabled:opacity-40 ${
                approvalPolicy === 'ask'
                  ? 'border-amber/40 bg-amber/10 text-amber'
                  : 'border-ok/40 bg-ok/10 text-ok'
              }`}
            >
              {approvalPolicy === 'ask' ? 'Ask before tools' : 'Auto-run tools'}
            </button>
            {onPresent && (
              <div className="flex flex-wrap gap-1.5 pt-0.5">
                <button
                  type="button"
                  className="hb-chat-present-btn"
                  onClick={() => {
                    presentFromChat({ scene: 'shell', newShell: true })
                    setSettingsOpen(false)
                  }}
                >
                  + Shell
                </button>
                <button
                  type="button"
                  className="hb-chat-present-btn"
                  onClick={() => {
                    presentFromChat({ scene: 'apps' })
                    setSettingsOpen(false)
                  }}
                >
                  Apps
                </button>
                <button
                  type="button"
                  className="hb-chat-present-btn"
                  onClick={() => {
                    presentFromChat({ scene: 'files' })
                    setSettingsOpen(false)
                  }}
                >
                  Files
                </button>
                <button
                  type="button"
                  className="hb-chat-present-btn"
                  onClick={() => {
                    presentFromChat({ scene: 'shell' })
                    setSettingsOpen(false)
                  }}
                >
                  Sessions
                </button>
              </div>
            )}
            {!isDock && (
              <button
                type="button"
                onClick={() => {
                  setSettingsOpen(false)
                  void resetChat()
                }}
                disabled={streaming || !active?.messages.length}
                className="text-[11px] text-mute hover:text-danger px-1 py-1 disabled:opacity-30 text-left"
                title="Clear messages and start a fresh agent for this tab"
              >
                Clear chat
              </button>
            )}
          </div>
        </>
      )}

      <div className="flex items-center gap-1.5 min-w-0">
        <button
          type="button"
          className={`hb-chat-opt-btn ${settingsOpen ? 'hb-chat-opt-btn-open' : ''}`}
          aria-expanded={settingsOpen}
          aria-label="Chat options"
          title="Mode, model, tools"
          onClick={() => setSettingsOpen((o) => !o)}
        >
          <svg viewBox="0 0 24 24" className="hb-chat-opt-icon" aria-hidden>
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
        <div className="hb-chat-opt-chips min-w-0 flex-1">
          <span className="hb-chat-opt-chip" title={modeMeta.title}>
            <svg viewBox="0 0 16 16" aria-hidden>
              <path
                d="M3 11.5 8 3l5 8.5H3z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
            </svg>
            {modeMeta.label}
          </span>
          <span className="hb-chat-opt-chip" title="Model">
            <svg viewBox="0 0 16 16" aria-hidden>
              <circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <circle cx="8" cy="8" r="1.6" fill="currentColor" />
            </svg>
            <span className="truncate max-w-[7rem]">{modelLabel}</span>
          </span>
          <span
            className={`hb-chat-opt-chip ${
              approvalPolicy === 'ask' ? 'hb-chat-opt-chip-warn' : 'hb-chat-opt-chip-ok'
            }`}
            title={approvalPolicy === 'ask' ? 'Ask before tools' : 'Auto-run tools'}
          >
            <svg viewBox="0 0 16 16" aria-hidden>
              {approvalPolicy === 'ask' ? (
                <path
                  d="M8 2.5a3.5 3.5 0 0 0-3.5 3.5V8H3.5v5.5h9V8H11.5V6A3.5 3.5 0 0 0 8 2.5zm-2 5.5V6a2 2 0 1 1 4 0v2H6z"
                  fill="currentColor"
                />
              ) : (
                <path
                  d="M3.5 8.2 6.2 11l6.3-6.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
            </svg>
            {approvalPolicy === 'ask' ? 'Ask' : 'Auto'}
          </span>
        </div>
      </div>

      {(queuedCount > 0 || editingLast) && (
        <p className="hb-chat-queue">
          {editingLast
            ? 'Editing last message — Send replaces it (Esc cancels edit)'
            : `${queuedCount} follow-up${queuedCount === 1 ? '' : 's'} queued · Esc stops`}
        </p>
      )}
      {agentId && (
        <p className="hb-chat-queue font-mono truncate" title={agentId}>
          agent {agentId.slice(0, 12)}…
        </p>
      )}
      {!!draftContext.length && (
        <div className="hb-chat-ctx-row">
          {draftContext.map((p) => (
            <span key={p} className="hb-chat-ctx-chip hb-chat-ctx-draft" title={p}>
              @{contextChipLabel(p)}
              <button
                type="button"
                className="hb-chat-ctx-x"
                aria-label={`Remove ${p}`}
                onClick={() => removeDraftContext(p)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {!!draftImages.length && (
        <div className="hb-chat-img-row">
          {draftImages.map((img, i) => (
            <div key={`draft-${i}`} className="hb-chat-img-thumb hb-chat-img-draft">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={chatImageSrc(img)} alt={img.name || 'attachment'} />
              <button
                type="button"
                className="hb-chat-img-x"
                aria-label="Remove image"
                onClick={() => removeDraftImage(i)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        className="hidden"
        onChange={(e) => {
          void addDraftFiles(e.target.files)
          e.target.value = ''
        }}
      />
      {isAgent && (
        <div className="hb-agent-talk-row">
          <span className="hb-agent-talk-hint truncate">
            {voiceMode
              ? listening
                ? 'Listening… tap Confirm to send'
                : canSpeak
                  ? 'Talk on — speak, then Confirm'
                  : canTts
                    ? 'Talk on — AI replies will be spoken'
                    : 'Talk on'
              : canTts
                ? 'Type below, or turn Talk on (speaks replies)'
                : 'Type below, or turn Talk on'}
          </span>
          <button
            type="button"
            className={`hb-agent-talk-btn ${voiceMode ? 'hb-agent-talk-btn--on' : ''}`}
            aria-pressed={voiceMode}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              toggleListen()
            }}
            title={
              voiceMode
                ? 'Turn off talk mode'
                : canSpeak
                  ? 'Talk — dictate + speak replies'
                  : 'Talk — speak AI replies (mic unavailable)'
            }
          >
            <svg viewBox="0 0 24 24" className="hb-mic-icon" aria-hidden>
              {voiceMode ? (
                <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
              ) : (
                <>
                  <path
                    d="M12 3.5a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0v-5a3 3 0 0 0-3-3z"
                    fill="currentColor"
                  />
                  <path
                    d="M7 11a5 5 0 0 0 10 0M12 16v3.5M9 19.5h6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                  />
                </>
              )}
            </svg>
            <span>{voiceMode ? 'Talk on' : 'Talk'}</span>
          </button>
        </div>
      )}
      <div
        className="flex gap-2 items-stretch"
        onDragOver={(e) => {
          if ([...e.dataTransfer.types].includes('Files')) e.preventDefault()
        }}
        onDrop={(e) => {
          if (![...e.dataTransfer.types].includes('Files')) return
          e.preventDefault()
          void addDraftFiles(e.dataTransfer.files)
        }}
      >
        <div className="hb-chat-compose-field flex-1 min-w-0 relative">
          {project && atMention && (
            <AtMentionPicker
              projectId={project.id}
              rootPath={active?.cwd || ''}
              query={atMention.query}
              open
              onSelect={addContextPath}
              onClose={() => setAtMention(null)}
            />
          )}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              const v = e.target.value
              setInput(v)
              if (editingLast && !v.trim()) setEditingLast(false)
              syncAtMention(v, e.target.selectionStart ?? v.length)
            }}
            onSelect={(e) => {
              const t = e.currentTarget
              syncAtMention(t.value, t.selectionStart ?? t.value.length)
            }}
            rows={2}
            placeholder={
              listening || (isAgent && voiceMode)
                ? 'Listening… speak in English'
                : streaming
                  ? `Queue follow-up (${cwdLabel})…`
                  : editingLast
                    ? 'Edit last message…'
                    : draftImages.length || draftContext.length
                      ? 'Add a note (optional)…'
                      : `Message (@ for files · ${cwdLabel})…`
            }
            className={`hb-chat-textarea w-full rounded-xl bg-panel-2 border px-3 py-2.5 text-sm resize-none outline-none focus:border-accent ${
              listening || (isAgent && voiceMode) ? 'border-accent/60' : 'border-line'
            }`}
            enterKeyHint="send"
            autoComplete="off"
            onFocus={() => {
              window.scrollTo(0, 0)
              requestAnimationFrame(() => window.scrollTo(0, 0))
            }}
            onPaste={(e) => {
              const files = [...e.clipboardData.items]
                .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
                .map((it) => it.getAsFile())
                .filter((f): f is File => !!f)
              if (files.length) {
                e.preventDefault()
                void addDraftFiles(files)
              }
            }}
            onKeyDown={(e) => {
              if (atMention && (e.key === 'Enter' || e.key === 'Tab' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                // AtMentionPicker handles these in capture phase.
                return
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (listening) stopListening()
                send(e)
              }
            }}
          />
          <div className="hb-chat-compose-tools">
            <button
              type="button"
              className="hb-at-btn"
              aria-label="Attach file context"
              title="@ attach file context"
              onClick={insertAtMention}
            >
              @
            </button>
            <button
              type="button"
              className="hb-attach-btn"
              aria-label="Attach image"
              title="Attach image (or paste / drop)"
              onClick={() => imageInputRef.current?.click()}
            >
              <svg viewBox="0 0 24 24" className="hb-attach-icon" aria-hidden>
                <path
                  d="M8.5 13.5 11 11l2.5 2.5L17 10l3 3v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-1.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <rect
                  x="3"
                  y="5"
                  width="18"
                  height="14"
                  rx="2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                />
              </svg>
            </button>
            {!isAgent && canSpeak && (
              <button
                type="button"
                onClick={toggleListen}
                disabled={streaming}
                className={`hb-mic-btn ${listening ? 'hb-mic-btn-live' : ''}`}
                aria-pressed={listening}
                aria-label={listening ? 'Stop dictation' : 'Dictate in English'}
                title={listening ? 'Stop' : 'Speak (English → text)'}
              >
                <svg viewBox="0 0 24 24" className="hb-mic-icon" aria-hidden>
                  {listening ? (
                    <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
                  ) : (
                    <>
                      <path
                        d="M12 3.5a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0v-5a3 3 0 0 0-3-3z"
                        fill="currentColor"
                      />
                      <path
                        d="M7 11a5 5 0 0 0 10 0M12 16v3.5M9 19.5h6"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.75"
                        strokeLinecap="round"
                      />
                    </>
                  )}
                </svg>
              </button>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <button
            type="submit"
            disabled={
              !connected || (!input.trim() && !draftImages.length && !draftContext.length)
            }
            className={`rounded-xl font-semibold px-4 py-2.5 text-sm disabled:opacity-40 border-0 ${
              isAgent && voiceMode
                ? 'hb-agent-confirm'
                : 'hb-btn-primary'
            }`}
          >
            {isAgent && voiceMode
              ? 'Confirm'
              : streaming && !editingLast
                ? 'Queue'
                : editingLast
                  ? 'Resend'
                  : 'Send'}
          </button>
          {(streaming ||
            !!active?.running ||
            agentPhase === 'busy' ||
            /stuck run|already has active run|press Stop/i.test(error)) && (
            <button
              type="button"
              onClick={cancel}
              className="rounded-xl border border-danger/50 text-danger text-xs py-2 font-semibold"
              title="Stop (Esc)"
            >
              Stop
            </button>
          )}
        </div>
      </div>
    </form>
  )

  // Dock: FAB when fully closed; keep panel mounted while closing for exit animation
  if (isDock && !dockMounted) {
    return (
      <button
        type="button"
        className="hb-chat-fab"
        onClick={() => setDockOpen(true)}
        aria-label="Open chat"
      >
        <svg className="hb-nav-icon" viewBox="0 0 24 24" aria-hidden>
          <path d="M5 4.5 19 12 5 19.5V4.5z" />
        </svg>
        <span>Chat</span>
        {streaming && <span className="hb-chat-fab-dot" />}
        {(agentPhase === 'error' || agentPhase === 'sudo') && (
          <span className="hb-chat-fab-dot hb-chat-fab-dot-warn" />
        )}
      </button>
    )
  }

  if (isDock) {
    const panelOpen = dockOpen && !dockClosing
    const presentTitle = !dockPresent
      ? ''
      : dockPresent.scene === 'shell'
        ? dockPresent.command
          ? 'Command'
          : 'Shell'
        : dockPresent.before != null || dockPresent.after != null
          ? 'Changes'
          : 'File'
    return (
      <>
        <button
          type="button"
          className={`hb-chat-dock-scrim${dockClosing ? ' hb-chat-dock-leaving' : ''}`}
          aria-label="Minimize chat"
          onClick={() => setDockOpen(false)}
        />
        <aside
          ref={dockRef}
          className={`hb-chat-dock${dockClosing ? ' hb-chat-dock-leaving' : ''}`}
          aria-label="Work chat"
          data-open={panelOpen ? '1' : '0'}
          onAnimationEnd={(e) => {
            if (!dockClosing) return
            if (e.target !== e.currentTarget) return
            setDockMounted(false)
            setDockClosing(false)
          }}
        >
          <div
            className={`flex-1 min-h-0 flex flex-col${
              dockPresent ? ' invisible pointer-events-none absolute inset-0' : ''
            }`}
            aria-hidden={!!dockPresent}
          >
            {modals}
            {header}
            {messages}
            {statusBar}
            {composer}
          </div>
          {dockPresent && project && (
            <div className="absolute inset-0 z-20 flex flex-col min-h-0 bg-[var(--hb-bg)]">
              <div className="hb-agent-bar hb-agent-bar--minimal shrink-0">
                <button
                  type="button"
                  className="hb-btn hb-btn-ghost text-sm"
                  onClick={() => setDockPresent(null)}
                >
                  ← Chat
                </button>
                <span className="hb-agent-bar-title truncate">{presentTitle}</span>
              </div>
              <div className="flex-1 min-h-0">
                {dockPresent.scene === 'shell' ? (
                  <ShellTab
                    projects={projects}
                    selectedId={project.id}
                    onSelect={onSelect}
                    embedded
                    minimal
                    replayCommand={dockPresent.command || null}
                    replayOutput={dockPresent.output || null}
                    attachSessionIds={dockPresent.sessionIds || null}
                    startShellKey={dockPresent.newShell ? Date.now() : 0}
                    onClearAttach={() => undefined}
                  />
                ) : (
                  <FilesTab
                    projects={projects}
                    selectedId={project.id}
                    onSelect={onSelect}
                    embedded
                    minimal
                    focusPath={dockPresent.path || null}
                    diffBefore={dockPresent.before ?? null}
                    diffAfter={dockPresent.after ?? null}
                    diffAction={dockPresent.action || null}
                    onFocusPathConsumed={() => undefined}
                  />
                )}
              </div>
            </div>
          )}
        </aside>
      </>
    )
  }

  return (
    <div className={`h-full flex flex-col min-h-0${isAgent ? '' : ' hb-with-nav'}`}>
      {modals}
      {header}
      {messages}
      {statusBar}
      {isAgent && error ? (
        <p className="px-3 py-1 text-[0.7rem] text-danger shrink-0">{error}</p>
      ) : null}
      {composer}
    </div>
  )
}
