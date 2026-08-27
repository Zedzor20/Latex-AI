import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render/effect errors anywhere below it in the tree. Without this,
 * React 18 unmounts the whole tree on an uncaught error, leaving a blank
 * window. This keeps a readable fallback UI (and the real error in the
 * development console) instead.
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The actual error stays visible in the development console.
    console.error("Latex renderer crashed:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      const { error } = this.state;
      return (
        <div
          style={{
            width: "100vw",
            height: "100vh",
            background: "#171717",
            color: "#f5f5f5",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "12px",
            fontFamily: "system-ui, sans-serif",
            textAlign: "center",
            padding: "24px"
          }}
        >
          <div
            style={{
              width: "44px",
              height: "44px",
              borderRadius: "10px",
              background: "linear-gradient(135deg, #8b5cf6, #ec4899)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 700,
              fontSize: "22px",
              color: "#fff"
            }}
          >
            L
          </div>
          <h1 style={{ margin: 0, fontSize: "22px" }}>Something went wrong while loading the interface.</h1>
          <p style={{ margin: 0, color: "#a1a1aa", maxWidth: "460px" }}>
            Latex hit an unexpected error. Reload to try again. The full error is logged to the development console.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              marginTop: "8px",
              padding: "10px 18px",
              borderRadius: "8px",
              border: "none",
              background: "#8b5cf6",
              color: "#fff",
              fontSize: "14px",
              fontWeight: 600,
              cursor: "pointer"
            }}
          >
            Reload Latex
          </button>
          <details style={{ marginTop: "12px", color: "#71717a", fontSize: "13px", maxWidth: "640px" }}>
            <summary>Technical details</summary>
            <pre
              style={{
                textAlign: "left",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                background: "#0c0d10",
                border: "1px solid #27272a",
                borderRadius: "8px",
                padding: "12px",
                marginTop: "8px",
                fontSize: "12px"
              }}
            >
              {error.name}: {error.message}
              {"\n\n"}
              {error.stack}
            </pre>
          </details>
        </div>
      );
    }
    return this.props.children;
  }
}
