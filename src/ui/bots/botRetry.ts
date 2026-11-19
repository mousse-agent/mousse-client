// Failed chat turn Retry (#1630), ported from mousse/src/renderer/components/bots/botRetry.ts.
import type { BotChatMessage } from '../../connection/bots'

const MAX_REMOTE_BOT_TEXT = 32 * 1024

/** What Retry on a failed chat turn sends again: the owner's words and optional reply target. */
export interface BotRetry {
  text: string
  replyTo?: string
}

/**
 * What Retry on the bot's failed message `failed` sends again, or null when it offers no Retry: the line has a way out
 * of its own (sign in, open providers, resume, pick a model), it is not a failed turn of the chat (work's failures have
 * no message of the owner's in their turn), or the owner already wrote after it.
 */
export function botRetryOf(messages: readonly BotChatMessage[], failed: BotChatMessage): BotRetry | null {
  if (failed.author !== 'bot' || failed.kind !== 'error' || !failed.error || failed.error.action || !failed.activationId) return null
  if (messages.some((message) => message.author === 'owner' && message.seq > failed.seq)) return null
  const asked = messages.filter((message) => message.author === 'owner' && message.activationId === failed.activationId && message.seq < failed.seq)
  if (!asked.length) return null
  const text = asked.map((message) => message.text.trim()).filter(Boolean).join('\n\n').slice(0, MAX_REMOTE_BOT_TEXT)
  if (!text) return null
  const replyTo = asked[0]!.replyTo?.id
  return { text, ...(replyTo ? { replyTo } : {}) }
}
