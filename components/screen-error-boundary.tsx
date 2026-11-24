import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  // Rendered instead of the children after a render error, with a way to try again.
  fallback: (error: Error, retry: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

// Keeps one screen's render error from taking down the app, so the operator
// still has a way out (for Results: exporting the raw data) instead of a crash.
export class ScreenErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('Screen render failed', error);
  }

  retry = () => this.setState({ error: null });

  render() {
    if (this.state.error) return this.props.fallback(this.state.error, this.retry);
    return this.props.children;
  }
}
