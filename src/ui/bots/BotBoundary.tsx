// Bot UI is drawn inside boundaries: a bot that fails to draw (a face whose WebGL breaks, a message
// the parser let through in a shape the view did not expect) shows a quiet line or nothing, and the
// rest of the app keeps working.
import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  /** Drawn instead of the children once they failed; nothing by default. */
  fallback?: ReactNode | ((retry: () => void) => ReactNode)
  /** A new key starts over: the children are tried again. */
  resetKey?: unknown
  children: ReactNode
}

interface State {
  failed: boolean
  key: unknown
}

export class BotBoundary extends Component<Props, State> {
  state: State = { failed: false, key: this.props.resetKey }

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true }
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return Object.is(props.resetKey, state.key) ? null : { failed: false, key: props.resetKey }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('Bot UI failed to draw', error, info.componentStack)
  }

  private retry = () => this.setState({ failed: false })

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    const { fallback } = this.props
    return typeof fallback === 'function' ? fallback(this.retry) : fallback ?? null
  }
}
