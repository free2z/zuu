import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * Rendered instead of `children` once a descendant throws during render.
   * A function form receives the caught error so callers can degrade
   * gracefully (e.g. show the raw text of a comment that failed to render).
   */
  fallback: ReactNode | ((error: Error) => ReactNode);
  /**
   * When any value in this array changes (shallow compare), the boundary
   * clears its error and retries rendering `children`. Pass the untrusted
   * content here so a fresh/edited body gets another render attempt instead of
   * being pinned to the fallback forever.
   */
  resetKeys?: unknown[];
  /** Optional hook for logging/telemetry. Never used to re-throw. */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

function keysChanged(a: unknown[] | undefined, b: unknown[] | undefined): boolean {
  if (a === b) return false;
  if (!a || !b || a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) return true;
  }
  return false;
}

/**
 * Class error boundary — the ONLY React primitive that can stop a render-time
 * throw from unmounting the whole root. We use it in two places:
 *
 *   1. At the app root (`main.tsx`) so a crash in any subtree degrades to a
 *      small error card instead of a permanent white screen.
 *   2. Around every markdown body rendered from untrusted/large content
 *      (`Markdown`), where a malicious comment (e.g. pathologically-nested
 *      `$$…$$` that overflows the MathJax stack) must degrade to plain text
 *      rather than take the page down for every viewer.
 *
 * React only invokes error boundaries for errors thrown during render /
 * lifecycle, which is exactly the stored-render-crash DoS class we're closing.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, info);
    // Dev breadcrumb only; production must never surface a crash to the user.
    const isDev = Boolean(
      (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV,
    );
    if (isDev) {
      // eslint-disable-next-line no-console
      console.error("ErrorBoundary caught a render error:", error, info);
    }
  }

  componentDidUpdate(prev: ErrorBoundaryProps) {
    if (this.state.error && keysChanged(prev.resetKeys, this.props.resetKeys)) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      const { fallback } = this.props;
      return typeof fallback === "function"
        ? fallback(this.state.error)
        : fallback;
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
