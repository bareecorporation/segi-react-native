import { Component, type ErrorInfo, type ReactNode } from 'react';
import { captureSegiException } from './client';
import type { SegiEventContext } from './types';

export interface SegiErrorBoundaryProps {
  children: ReactNode;
  /** Rendered when a child throws. Receives the error and a `reset` callback. */
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);
  /** Extra context merged into the captured event. */
  context?: SegiEventContext;
  /** Invoked after the error is captured. */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface State {
  error: Error | null;
}

/**
 * React error boundary that reports render-tree crashes to Segi and renders a fallback.
 *
 * ```tsx
 * <SegiErrorBoundary fallback={(e, reset) => <Crash error={e} onRetry={reset} />}>
 *   <App />
 * </SegiErrorBoundary>
 * ```
 */
export class SegiErrorBoundary extends Component<SegiErrorBoundaryProps, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    captureSegiException(error, {
      level: 'error',
      handled: true,
      tags: { source: 'ErrorBoundary' },
      ...this.props.context,
      extra: {
        componentStack: info.componentStack,
        ...this.props.context?.extra,
      },
    });
    this.props.onError?.(error, info);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error !== null) {
      const { fallback } = this.props;
      if (typeof fallback === 'function') return fallback(error, this.reset);
      return fallback ?? null;
    }
    return this.props.children;
  }
}
