import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled render error", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <main className="boot-screen error">
        <span>APPLICATION ERROR</span>
        <h1>Something broke while rendering this page.</h1>
        <p>{error.message}</p>
        <button
          type="button"
          className="secondary-button small"
          onClick={() => {
            window.location.hash = "";
            window.location.reload();
          }}
        >
          Return to the landing page
        </button>
      </main>
    );
  }
}
