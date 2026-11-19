// Inter-bot messages (#1543), ported from mousse/src/shared/bots/personal/botMessages.ts.

/**
 * The start of the id of the message's row in the receiving bot's chat: `bm_botmsg_<sender's bot id>_<message id>`;
 * rows written before the sender was kept are `bm_botmsg_<message id>`.
 */
export const BOT_MESSAGE_ROW_PREFIX = 'bm_botmsg_'
const MESSAGE_ID_TAIL = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
const ROW_TEXT = /^\*\*Message from your bot ([^\n]*)\*\*\n\n(>[^\n]*(?:\n>[^\n]*)*)$/

/** Another bot's message as its row in a chat holds it: who sent it (its bot id when the row keeps it) and the message. */
export interface BotMessageFrom {
  botId?: string
  name: string
  message: string
}

/**
 * The sender and the message of a row another bot's message left, for a chat that draws it as
 * that bot's own bubble; undefined for any other row, or one whose text is not that shape.
 */
export function botMessageFrom(row: { id: string; text: string }): BotMessageFrom | undefined {
  if (!row.id.startsWith(BOT_MESSAGE_ROW_PREFIX)) return undefined
  const parts = ROW_TEXT.exec(row.text)
  if (!parts) return undefined
  const message = parts[2]!.split('\n').map((line) => line.replace(/^> ?/, '')).join('\n')
  const tail = MESSAGE_ID_TAIL.exec(row.id)
  const botId = tail && tail.index > BOT_MESSAGE_ROW_PREFIX.length ? row.id.slice(BOT_MESSAGE_ROW_PREFIX.length, tail.index) : undefined
  return { ...(botId ? { botId } : {}), name: parts[1]!, message }
}
