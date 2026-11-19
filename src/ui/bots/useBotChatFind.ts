// Find in a bot's chat, ported from mousse/src/renderer/components/bots/useBotChatFind.ts and
// adapted for phone screens: searches loaded messages while loading older history pages, shows
// match count, and jumps between matches.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BotChatMessage } from '../../connection/bots'
import { actionStatus, actionTitle } from './BotActionCard'
import type { BotChatRow } from './botChatShape'
import { botGroupTime } from './messageGroups'

/** The searchable words of one bot chat message. */
export function botFindText(message: BotChatMessage): string {
  if (message.action) return [actionTitle(message.action), actionStatus(message.action)].filter(Boolean).join('\n\n')
  if (message.actionSentAt) return `Sent · ${botGroupTime(message.actionSentAt)}`
  if (message.plainFrom !== undefined && (message.question || message.cards?.length)) return message.text.slice(0, message.plainFrom).trimEnd()
  return message.text
}

export interface BotChatFindMatch {
  messageId: string
  index: number
}

export function findBotMatches(rows: readonly BotChatRow[], query: string): BotChatFindMatch[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const matches: BotChatFindMatch[] = []
  let index = 0
  for (const row of rows) {
    if (row.kind !== 'message') continue
    const text = botFindText(row.message).toLowerCase()
    if (!text) continue
    let from = 0
    while ((from = text.indexOf(needle, from)) >= 0) {
      matches.push({ messageId: row.message.id, index })
      index += 1
      from += needle.length
    }
  }
  return matches
}

export interface BotChatFindState {
  open: boolean
  query: string
  matches: BotChatFindMatch[]
  current: number
  currentMessageId?: string
  loadingHistory: boolean
  openFind(): void
  closeFind(): void
  setQuery(value: string): void
  next(): void
  prev(): void
}

export function useBotChatFind({
  botId,
  rows,
  hasMore,
  loadOlder,
  onNavigate,
}: {
  botId: string
  rows: readonly BotChatRow[]
  hasMore: boolean
  loadOlder(): Promise<boolean>
  onNavigate(messageId: string): void
}): BotChatFindState {
  const [open, setOpen] = useState(false)
  const [query, setQueryState] = useState('')
  const [current, setCurrent] = useState(0)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const onNavigateRef = useRef(onNavigate)
  onNavigateRef.current = onNavigate
  const loadOlderRef = useRef(loadOlder)
  loadOlderRef.current = loadOlder

  useEffect(() => {
    setOpen(false)
    setQueryState('')
    setCurrent(0)
  }, [botId])

  const matches = useMemo(() => (open ? findBotMatches(rows, query) : []), [open, rows, query])

  // Load older pages while the find bar is open so older messages are searchable too.
  useEffect(() => {
    if (!open || !hasMore) return
    let stopped = false
    setLoadingHistory(true)
    void (async () => {
      try {
        for (let pages = 0; !stopped && pages < 40; pages += 1) {
          const loaded = await loadOlderRef.current()
          if (!loaded) break
        }
      } finally {
        if (!stopped) setLoadingHistory(false)
      }
    })()
    return () => {
      stopped = true
      setLoadingHistory(false)
    }
  }, [open, hasMore, botId])

  const clamped = matches.length ? Math.min(current, matches.length - 1) : 0
  const currentMessageId = matches[clamped]?.messageId

  const setQuery = useCallback((value: string) => {
    setQueryState(value)
    setCurrent(0)
  }, [])

  const openFind = useCallback(() => {
    setOpen(true)
  }, [])

  const closeFind = useCallback(() => {
    setOpen(false)
    setQueryState('')
    setCurrent(0)
  }, [])

  const jump = useCallback((nextIndex: number) => {
    if (!matches.length) return
    const wrapped = (nextIndex + matches.length) % matches.length
    setCurrent(wrapped)
    onNavigateRef.current(matches[wrapped]!.messageId)
  }, [matches])

  const next = useCallback(() => jump(clamped + 1), [jump, clamped])
  const prev = useCallback(() => jump(clamped - 1), [jump, clamped])

  useEffect(() => {
    if (open && currentMessageId) onNavigateRef.current(currentMessageId)
  }, [open, query, currentMessageId])

  return {
    open,
    query,
    matches,
    current: clamped,
    currentMessageId,
    loadingHistory: loadingHistory && hasMore,
    openFind,
    closeFind,
    setQuery,
    next,
    prev,
  }
}
