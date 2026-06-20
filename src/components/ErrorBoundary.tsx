import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Top-level guard: a render-time throw anywhere in the tree would otherwise
 * unmount the whole app and leave a blank white screen with no recovery. This
 * catches it and shows a recoverable fallback instead.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surfaces in the browser console / error monitoring. Kept minimal -
    // wire to Sentry/Cloud Logging here when that lands.
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  private handleReload = (): void => {
    this.setState({ error: null });
    window.location.assign('/');
  };

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          role="alert"
          style={{
            minHeight: '100vh',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '1rem',
            padding: '2rem',
            textAlign: 'center',
            background: 'hsl(var(--background, 0 0% 4%))',
            color: 'hsl(var(--foreground, 0 0% 98%))',
            fontFamily: 'system-ui, -apple-system, sans-serif',
          }}
        >
          <h1 style={{ fontSize: '1.5rem', fontWeight: 600, margin: 0 }}>Something went wrong</h1>
          <p style={{ opacity: 0.7, maxWidth: '28rem', margin: 0 }}>
            The page hit an unexpected error. Reloading usually fixes it.
          </p>
          <button
            onClick={this.handleReload}
            style={{
              marginTop: '0.5rem',
              padding: '0.6rem 1.25rem',
              borderRadius: '0.5rem',
              border: 'none',
              cursor: 'pointer',
              fontSize: '0.95rem',
              fontWeight: 500,
              background: 'hsl(var(--primary, 217 91% 60%))',
              color: 'hsl(var(--primary-foreground, 0 0% 100%))',
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
