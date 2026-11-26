import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/** Keep UI visible if a child (chart) throws. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('KEHAI UI error', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: '1.25rem', color: '#e7f2f4' }}>
          <p style={{ margin: '0 0 0.75rem', fontSize: '1.1rem' }}>
            表示エラーが発生しました
          </p>
          <p style={{ margin: '0 0 1rem', opacity: 0.7, fontSize: '0.85rem' }}>
            {this.state.error.message}
          </p>
          <button
            type="button"
            style={{
              padding: '0.55rem 0.9rem',
              borderRadius: 8,
              border: '1px solid rgba(94,234,212,0.35)',
              background: 'transparent',
              color: '#5eead4',
            }}
            onClick={() => window.location.reload()}
          >
            再読み込み
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
