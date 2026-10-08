import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./ErrorBoundary";
import { installMockBridgeIfNeeded } from "./mockBridge";
import { mark } from "./lib/startupTrace";

// The earliest honest "the renderer started" instant: our code is running,
// before any React work. Forwarded to the main process so the whole launch is
// one timeline.
mark("startup:renderer-boot");

// Browser-only dev aid: lets the renderer run without the Electron preload.
installMockBridgeIfNeeded();

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Latex: #root element was not found.");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
mark("startup:renderer-ready");
