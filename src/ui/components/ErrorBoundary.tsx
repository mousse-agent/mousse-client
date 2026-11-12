// Keeps one part of the screen failing from taking the whole app down: it shows what went wrong,
// with Try again (render the part again) and Reload (start the app again).
import { Component, type ErrorInfo, type ReactNode } from 'react'

const LAST_ERROR_KEY = 'mousse.lastError'

interface Props {
  /** What failed, in the message: "the thread list", "this chat". */
  what: string
  /** A new value renders the part again, e.g. the open tab. */
  resetKey?: unknown
  children: ReactNode
}

interface State { error?: Error; key?: unknown }

export class ErrorBoundary extends Component<Props, State> {
  state: State = {}

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.key) return { key: props.resetKey, error: undefined }
    return null
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`Mousse: ${this.props.what} failed`, error, info.componentStack)
    try {
      localStorage.setItem(LAST_ERROR_KEY, JSON.stringify({ at: new Date().toISOString(), what: this.props.what, message: error.message, stack: `${error.stack ?? ''}\n${info.componentStack ?? ''}`.slice(0, 4000) }))
    } catch { /* storage unavailable */ }
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="m-error-boundary" role="alert">
        <strong>Something went wrong in {this.props.what}.</strong>
        <code>{error.message || String(error)}</code>
        <div className="m-error-boundary__actions">
          <button type="button" className="m-button m-button--ghost" onClick={() => this.setState({ error: undefined })}>Try again</button>
          <button type="button" className="m-button m-button--primary" onClick={() => location.reload()}>Reload</button>
        </div>
      </div>
    )
  }
}
