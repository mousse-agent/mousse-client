// The top of a bot's chat: the bot's own face in a glass circle in the middle, its name in a pill
// under it, and Back and About as round glass buttons at the sides.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ListBot } from '../../connection/bots'
import { BotFace, type BotFaceState } from './face/BotFace'
import { BotBoundary } from './BotBoundary'
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

export function BotHeader({ bot, name, computer, leading, trailing }: { bot?: ListBot; name: string; computer?: string; leading?: ReactNode; trailing?: ReactNode }) {
  const pose = useBotPose(bot)
  return (
    <header className="bot-header">
      <div className="bot-header__side">{leading}</div>
      <div className="bot-header__who">
        <div className="bot-header__glass" aria-hidden="true">
          {bot && (
            // The live face, moving as on the desktop: idle, working, needs you, stuck, paused and happy.
            <BotBoundary resetKey={bot.id} fallback={null}>
              <BotFace look={bot.look} state={pose} size={FACE} view="head" />
            </BotBoundary>
          )}
        </div>
        <h1 className="bot-header__name">{name}</h1>
        {computer && <p className="bot-header__computer">{computer}</p>}
      </div>
      <div className="bot-header__side bot-header__side--end">{trailing}</div>
    </header>
  )
}
