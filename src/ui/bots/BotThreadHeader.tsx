// Compact header banner above a thread launched by a bot, ported from
// mousse/src/renderer/components/bots/BotThreadHeader.tsx.
import type { CSSProperties } from 'react'
import type { BotLaunchedThread, ListBot } from '../../connection/bots'
import { ChevronLeft } from '../components/icons'
import { launchedLook } from './botChatShape'
import { LazyBotFace } from './face/LazyBotFace'
import { BOT_COLOUR_HEX, normalizeBotLook } from './look'

export function BotThreadHeader({ bot, thread, onBackToBot }: {
  bot: ListBot
  thread?: BotLaunchedThread
  onBackToBot(): void
}) {
  const status = thread ? launchedLook(thread.status).label : undefined
  const meta = [thread?.project, status].filter(Boolean).join(' · ')
  return (
    <div
      className="bot-thread-banner"
      style={{ '--bot-colour': BOT_COLOUR_HEX[normalizeBotLook(bot.look).colour] } as CSSProperties}
    >
      <button type="button" className="bot-thread-banner__back" onClick={onBackToBot} aria-label={`Back to ${bot.name}’s chat`}>
        <ChevronLeft size={15} aria-hidden />
        <LazyBotFace look={bot.look} state={bot.state} size={22} view="head" still />
        <span>Started by <strong>{bot.name}</strong></span>
      </button>
      {meta && <span className="bot-thread-banner__meta">{meta}</span>}
    </div>
  )
}
