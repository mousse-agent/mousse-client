import type { ReactNode } from 'react'
import { LiquidGlassOrb } from './LiquidGlassOrb'
import { useReducedMotion } from '../hooks/useMediaQuery'

export interface EmptyStateProps {
  title: ReactNode
  body?: ReactNode
  actions?: ReactNode
  /** Show the liquid-glass orb above the title. */
  orb?: boolean
  palette?: 'aurora' | 'lagoon' | 'ember' | 'pearl' | 'violet' | 'graphite'
}

/** The desktop's empty-thread hero: accent aura, orb, 26px title. */
export function EmptyState({ title, body, actions, orb = true, palette = 'violet' }: EmptyStateProps) {
  const reducedMotion = useReducedMotion()
  return (
    <div className="m-empty">
      <div className="m-empty__aura" aria-hidden="true" />
      {orb && (
        <div className="m-empty__orb">
          <LiquidGlassOrb appearance={{ palette, motion: 0.25, parallax: false }} active={!reducedMotion} />
        </div>
      )}
      <h2 className="m-empty__title">{title}</h2>
      {body && <p className="m-empty__body">{body}</p>}
      {actions && <div className="m-empty__actions">{actions}</div>}
    </div>
  )
}
