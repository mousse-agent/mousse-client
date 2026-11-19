// The top of a bot's chat: the bot's own face in a glass circle with its activity sticker, its name
// in a pill under it, its presence line (tapping opens work/threads when active), checklist pill,
// and Back and Menu as round glass buttons at the sides.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ListBot } from '../../connection/bots'
import { ChevronDown } from '../components/icons'
import { BotBoundary } from './BotBoundary'
import { BotActivitySticker } from './BotPresenceSheet'
import { BotTasksButton } from './BotTasksSheet'
import { launchedGroups, presenceOf } from './botChatShape'
import { BotFace, type BotFaceState } from './face/BotFace'
import './bots.css'

const FACE = 60
/** How long a bot that just finished a good run looks happy (the desktop's BOT_HAPPY_MS). */
export const BOT_HAPPY_MS = 2500

/**
 * The face's pose, as on the desktop: the bot's state, and "happy" for a moment when it goes from
 * working to idle after a run that went well.
 */
export function useBotPose(bot: ListBot | undefined): BotFaceState {
  const [happy, setHappy] = useState(false)
  const previous = useRef(bot?.state)
  useEffect(() => {
    const before = previous.current
    previous.current = bot?.state
    if (!bot || before !== 'working' || bot.state !== 'idle' || bot.lastOutcome !== 'ok') return
    setHappy(true)
    const timer = window.setTimeout(() => setHappy(false), BOT_HAPPY_MS)
    return () => window.clearTimeout(timer)
  }, [bot?.state, bot?.lastOutcome, bot])
  if (!bot) return 'idle'
  return happy && bot.state === 'idle' ? 'happy' : bot.state
}

export function BotHeader({
  bot,
  name,
  computer,
  leading,
  trailing,
  onAbout,
  onPresence,
  onTasks,
}: {
  bot?: ListBot
  name: string
  computer?: string
  leading?: ReactNode
  trailing?: ReactNode
  onAbout?(): void
  onPresence?(): void
  onTasks?(): void
}) {
  const pose = useBotPose(bot)
  const legacy = bot ? bot.chat === undefined && bot.work === undefined && bot.threads === undefined : false
  const working = bot ? Boolean(bot.chat) || (legacy && bot.state === 'working') : false
  const offline = bot ? (bot.chat ? Boolean(bot.chat.offline) : working && bot.waiting === 'internet') : false
  const typing = working && !offline
  const presence = bot ? presenceOf(bot, { typing, offline }) : undefined
  const hasActivity = Boolean(
    bot &&
      ((bot.work?.length ?? 0) > 0 ||
        (bot.watchers?.length ?? 0) > 0 ||
        launchedGroups(bot.threads ?? [], Date.now()).going.length > 0 ||
        launchedGroups(bot.threads ?? [], Date.now()).ended.length > 0),
  )

  return (
    <header className="bot-header">
      <div className="bot-header__side">{leading}</div>
      <div className="bot-header__who">
        <button
          type="button"
          className="bot-header__identity"
          aria-label={bot ? `About ${name}` : name}
          disabled={!onAbout}
          onClick={onAbout}
        >
          <span className="bot-header__glass" aria-hidden="true">
            {bot && (
              <BotBoundary resetKey={bot.id} fallback={null}>
                <BotFace look={bot.look} state={pose} size={FACE} view="head" />
              </BotBoundary>
            )}
            {bot && <BotActivitySticker bot={bot} typing={typing} offline={offline} />}
          </span>
          <h1 className="bot-header__name">{name}</h1>
        </button>
        {presence && (
          hasActivity && onPresence ? (
            <button
              type="button"
              className="bot-header__presence is-button"
              data-kind={presence.kind}
              onClick={onPresence}
              aria-label={`Activity: ${presence.text}`}
            >
              <span role="status">{presence.text}</span>
              <ChevronDown size={12} aria-hidden />
            </button>
          ) : (
            <span className="bot-header__presence" data-kind={presence.kind} role="status">{presence.text}</span>
          )
        )}
        {computer && <p className="bot-header__computer">{computer}</p>}
      </div>
      <div className="bot-header__side bot-header__side--end">
        {bot && onTasks && <BotTasksButton botId={bot.id} tasks={bot.tasks} onOpen={onTasks} />}
        {trailing}
      </div>
    </header>
  )
}
