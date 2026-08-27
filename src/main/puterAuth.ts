/**
 * PuterAuth — centralized Puter authentication service.
 *
 * Architecture:
 *   Puter.js uses a popup-based authentication flow where:
 *   1. puter.auth.signIn() opens a popup to puter.com/action/sign-in
 *   2. User authenticates (Google/email/etc.)
 *   3. Popup posts {msg: 'puter.token', token} back to opener via postMessage
 *   4. SDK calls setAuthToken() which stores in localStorage under 'puter.auth.token.v2'
 *
 *   This CANNOT cross from a system browser to Electron (postMessage requires same window).
 *   Instead, we use a persistent Electron BrowserWindow (partition: persist:latex-puter)
 *   that loads a local helper page which initializes the Puter SDK.
 *   The SDK handles the popup natively, the token is stored in the partition's localStorage,
 *   and we extract it programmatically — invisible to the user.
 *
 *   On restart, the persistent session auto-restores the SDK's auth state.
 */

import { BrowserWindow, session } from "electron";
import http from "node:http";
import type { AppStore } from "./store.js";

const PUTER_SESSION_PARTITION = "persist:latex-puter";
const PUTER_API_BASE = "https://api.puter.com";

/** Result of an auth attempt. */
export interface PuterAuthResult {
  ok: boolean;
  username?: string;
  error?: string;
}

export class PuterAuth {
  private store: AppStore;
  private authToken: string | null = null;
  private puterUsername: string | null = null;
  private authWindow: BrowserWindow | null = null;
  private startupPromise: Promise<void> | null = null;

  constructor(store: AppStore) {
    this.store = store;
  }

  // ── Initialization ─────────────────────────────────────────────────

  /** Initialize auth on app startup — load and verify stored token. */
  async initialize(): Promise<void> {
    this.startupPromise = this.restoreSession();
  }

  /** Wait for startup verification to complete. */
  async waitForStartup(): Promise<void> {
    if (this.startupPromise) {
      try { await this.startupPromise; } catch { /* ignore */ }
    }
  }

  // ── Session Management ─────────────────────────────────────────────

  /** Load token from electron-store and verify against Puter servers. */
  private async restoreSession(): Promise<void> {
    console.log("[PUTER] Restoring session from store...");
    this.loadFromStore();
    if (!this.authToken) {
      console.log("[PUTER] No stored token — user needs to sign in");
      return;
    }
    const name = await this.verifyToken(this.authToken);
    if (name) {
      this.puterUsername = name;
      this.store.setPuterUsername(name);
      console.log(`[PUTER] ✓ Session restored — ${name}`);
    } else {
      console.log("[PUTER] ✗ Stored token invalid — clearing");
      this.clearToken();
    }
  }

  /** Load token + username from electron-store. */
  private loadFromStore(): void {
    const token = this.store.getPuterToken();
    if (token && typeof token === "string") {
      this.authToken = token;
      this.puterUsername = this.store.getPuterUsername() ?? null;
      console.log(`[PUTER] Loaded token from store (${token.length} chars)`);
    }
  }

  /** Save token + username to electron-store. */
  private saveToken(token: string, username: string | null): void {
    this.authToken = token;
    this.puterUsername = username;
    this.store.setPuterToken(token);
    this.store.setPuterUsername(username);
    console.log(`[PUTER] Token saved (${token.length} chars)`);
  }

  /** Clear token + username from memory and store. */
  private clearToken(): void {
    this.authToken = null;
    this.puterUsername = null;
    this.store.setPuterToken(null);
    this.store.setPuterUsername(null);
  }

  // ── Token Verification ─────────────────────────────────────────────

  /**
   * Verify a token against Puter's /whoami endpoint.
   * The Puter SDK uses https://api.puter.com/whoami (not /v1/identity/whoami).
   * Returns username or null.
   */
  private async verifyToken(token: string): Promise<string | null> {
    try {
      // Puter SDK endpoint: ${APIOrigin}/whoami — NOT /v1/identity/whoami
      const resp = await fetch(`${PUTER_API_BASE}/whoami`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000)
      });
      console.log(`[PUTER] Token verification: HTTP ${resp.status}`);
      if (!resp.ok) {
        return null;
      }
      const data = await resp.json() as { username?: string; name?: string; [key: string]: unknown };
      const name = data.username ?? data.name ?? "Puter user";
      console.log(`[PUTER] Token verified — user: ${name}`);
      return name;
    } catch (err) {
      console.log(`[PUTER] Token verification error: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  // ── Renderer Notification ──────────────────────────────────────────

  /** Notify all renderer windows that auth state changed. */
  private notifyRenderer(): void {
    const wins = BrowserWindow.getAllWindows();
    for (const win of wins) {
      if (!win.isDestroyed()) {
        win.webContents.send("puter:auth:changed", {
          status: this.authToken ? "connected" : "disconnected",
          username: this.puterUsername ?? undefined
        });
      }
    }
  }

  // ── Authentication ─────────────────────────────────────────────────

  /**
   * Sign in to Puter using a BrowserWindow with a persistent session.
   *
   * The Puter SDK runs natively in the BrowserWindow, handling its own
   * popup-based authentication. After the user authenticates, we extract
   * the token programmatically from the SDK's localStorage — the user
   * never sees or copies any token.
   *
   * The persistent session partition (persist:latex-puter) ensures that
   * the authentication survives app restarts.
   */
  async signIn(): Promise<PuterAuthResult> {
    if (this.authToken) {
      return { ok: true, username: this.puterUsername ?? "user" };
    }

    // Close any existing auth window
    if (this.authWindow && !this.authWindow.isDestroyed()) {
      this.authWindow.focus();
      return { ok: false, error: "Authentication window is already open" };
    }

    console.log("[PUTER] Opening authentication window...");

    try {
      const result = await this.openAuthWindow();
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[PUTER] Sign-in failed:", msg);
      return { ok: false, error: `Puter login failed — ${msg}` };
    }
  }

  /**
   * Open a BrowserWindow with persistent session that runs the Puter SDK.
   * The SDK handles its own popup-based auth. We extract the token afterward.
   */
  private openAuthWindow(): Promise<PuterAuthResult> {
    return new Promise((resolve) => {
      let resolved = false;

      const finish = (result: PuterAuthResult) => {
        if (resolved) return;
        resolved = true;
        this.cleanupAuthWindow();
        resolve(result);
      };

      // Use persistent session so cookies/localStorage survive restarts
      const ses = session.fromPartition(PUTER_SESSION_PARTITION);

      // Create the auth window
      this.authWindow = new BrowserWindow({
        width: 700,
        height: 800,
        title: "Sign in to Puter",
        autoHideMenuBar: true,
        backgroundColor: "#0c0d10",
        webPreferences: {
          session: ses,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false  // Required for Puter SDK's localStorage access
        }
      });

      const win = this.authWindow;

      // Allow the Puter auth popups to open within Electron.
      // The SDK's signIn() opens a popup to puter.com/action/sign-in.
      // That page may open a Google OAuth popup to accounts.google.com.
      // After Google auth, it redirects back to puter.com which posts the
      // token via postMessage to the opener. ALL popups must stay within
      // Electron for the postMessage chain to work.
      win.webContents.setWindowOpenHandler(({ url }) => {
        if (url.includes("puter.com") || url.includes("google.com")) {
          return { action: "allow" };
        }
        // Block all other external URLs
        return { action: "deny" };
      });

      // Allow necessary permissions
      win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
        callback(permission === "notifications" || permission === "media");
      });

      // Handle navigation errors
      win.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
        console.error(`[PUTER] Failed to load: ${errorDescription} (${errorCode})`);
        if (!resolved) {
          finishAndCleanup({ ok: false, error: `Failed to load Puter: ${errorDescription}` });
        }
      });

      // Handle window close — check if polling already resolved.
      // The helper page auto-closes 2s after auth success, which gives
      // the polling enough time to capture the token before the window closes.
      win.on("closed", () => {
        this.authWindow = null;
        if (!resolved) {
          finishAndCleanup({ ok: false, error: "Authentication window was closed" });
        }
      });

      // Start a localhost server to serve the helper page.
      // localhost IS a secure context, so crypto.randomUUID() works.
      // data: URLs are NOT secure contexts — the Puter SDK needs crypto.randomUUID().
      const PORT = 18900 + Math.floor(Math.random() * 1000);
      let server: ReturnType<typeof http.createServer> | null = null;

      const helperHtml = this.getHelperPageHtml();

      const closeServer = () => {
        try { server?.close(); } catch { /* ignore */ }
        server = null;
      };

      // Finish helper that also closes the server
      let finishAndCleanup = (result: PuterAuthResult) => {
        closeServer();
        finish(result);
      };

      server = http.createServer(async (req, res) => {
        // CORS headers for the helper page
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        // Helper page sends the token here after puter.auth.signIn() succeeds.
        if (req.method === "POST" && req.url === "/auth-complete") {
          let body = "";
          for await (const chunk of req) body += chunk;
          try {
            const { token } = JSON.parse(body) as { token?: string };
            if (token && token.length > 20) {
              console.log("[PUTER] Received token via callback — verifying...");
              const username = await this.verifyToken(token);
              if (username) {
                this.saveToken(token, username);
                this.notifyRenderer();
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true, username }));
                finishAndCleanup({ ok: true, username });
                return;
              }
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: "Token verification failed" }));
              return;
            }
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Invalid token" }));
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Invalid request" }));
          }
          return;
        }

        // Serve the helper page
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(helperHtml);
      });

      server.on("error", (err) => {
        finishAndCleanup({ ok: false, error: `Local server error: ${err.message}` });
      });

      server.listen(PORT, "127.0.0.1", () => {
        console.log(`[PUTER] Helper page served on http://127.0.0.1:${PORT}`);
        win.loadURL(`http://127.0.0.1:${PORT}`).catch((err) => {
          finishAndCleanup({ ok: false, error: `Could not load helper page: ${err.message}` });
        });
      });

      // Timeout if auth takes too long (5 minutes)
      const authTimeout = setTimeout(() => {
        if (!resolved) {
          finishAndCleanup({ ok: false, error: "Authentication timed out after 5 minutes" });
        }
      }, 300_000);
      const origFinish = finishAndCleanup;
      finishAndCleanup = (result: PuterAuthResult) => {
        clearTimeout(authTimeout);
        origFinish(result);
      };
    });
  }

  /**
   * Generate an HTML page that loads the Puter SDK and exposes a signIn button.
   * The SDK handles the popup-based auth natively.
   */
  private getHelperPageHtml(): string {
    return `<!DOCTYPE html>
<html>
<head>
  <title>Puter Authentication</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0c0d10; color: #e0e0e0;
      display: flex; justify-content: center; align-items: center;
      min-height: 100vh; margin: 0;
    }
    .card {
      background: #1a1b23; border-radius: 12px; padding: 40px;
      max-width: 460px; text-align: center;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    }
    h1 { font-size: 24px; margin: 0 0 8px; color: #fff; }
    p { color: #888; margin: 8px 0 16px; line-height: 1.5; }
    .btn {
      display: inline-block; padding: 12px 32px;
      background: #4f8cff; color: #fff; text-decoration: none;
      border-radius: 8px; font-size: 16px; font-weight: 600;
      cursor: pointer; border: none; margin-top: 16px;
    }
    .btn:hover { background: #3d7ae8; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .status { margin-top: 16px; font-size: 14px; color: #888; }
    .status.ok { color: #4cff8c; }
    .status.error { color: #ff4c4c; }
    .user-info { margin-top: 16px; padding: 12px; background: #12131a; border-radius: 8px; }
    .user-info .name { color: #fff; font-weight: 600; font-size: 16px; }
    .user-info .detail { color: #888; font-size: 13px; margin-top: 4px; }
  </style>
  <script src="https://js.puter.com/v2/"></script>
</head>
<body>
  <div class="card">
    <h1>🔐 Puter Authentication</h1>
    <p>Click the button below to sign in to your Puter account.<br>
       A popup window will open for authentication.</p>

    <div id="auth-section">
      <button class="btn" id="signin-btn" onclick="doSignIn()">
        Sign in with Puter
      </button>
    </div>

    <div id="signed-in-section" style="display:none">
      <div class="user-info">
        <div class="name" id="username">Signed in</div>
        <div class="detail" id="userdetail"></div>
      </div>
      <p style="color:#4cff8c; margin-top: 16px;">✅ Authentication successful!</p>
      <p style="color:#666;">Authenticating with Latex...</p>
    </div>

    <div class="status" id="status"></div>
  </div>

  <script>
    let authCompleted = false;

    async function doSignIn() {
      const btn = document.getElementById('signin-btn');
      const status = document.getElementById('status');
      btn.disabled = true;
      btn.textContent = 'Opening sign-in...';
      status.textContent = 'Waiting for authentication...';
      status.className = 'status';

      try {
        const result = await puter.auth.signIn();
        if (result && result.success) {
          authCompleted = true;
          const user = await puter.auth.getUser();
          document.getElementById('username').textContent = user.username || 'Puter user';
          document.getElementById('userdetail').textContent = user.email || user.uuid || '';
          document.getElementById('auth-section').style.display = 'none';
          document.getElementById('signed-in-section').style.display = 'block';
          status.textContent = 'Saving session...';
          // Extract token and POST to local server — no polling needed
          const token = localStorage.getItem('puter.auth.token.v2');
          if (token) {
            try {
              const resp = await fetch('/auth-complete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token })
              });
              const data = await resp.json();
              if (data.ok) {
                status.textContent = '';
                status.className = 'status ok';
                // Auto-close after 2 seconds
                setTimeout(() => window.close(), 2000);
              } else {
                status.textContent = 'Session save failed: ' + (data.error || 'unknown');
                status.className = 'status error';
              }
            } catch (e) {
              status.textContent = 'Connection to Latex failed — close this window manually.';
              status.className = 'status error';
            }
          } else {
            status.textContent = 'No auth token found — close this window manually.';
            status.className = 'status error';
          }
        } else {
          status.textContent = 'Sign-in was cancelled or failed.';
          status.className = 'status error';
          btn.disabled = false;
          btn.textContent = 'Try Again';
        }
      } catch (err) {
        const msg = (err && err.error) || (err && err.msg) || (err instanceof Error ? err.message : 'Unknown error');
        status.textContent = 'Sign-in failed: ' + msg;
        status.className = 'status error';
        btn.disabled = false;
        btn.textContent = 'Try Again';
      }
    }
  </script>
</body>
</html>`;
  }

  /**
   * Extract the Puter auth token from the BrowserWindow's localStorage.
   * This is how the Puter SDK stores the token after signIn().
   */
  private async extractTokenFromWindow(win: BrowserWindow): Promise<string | null> {
    if (!win || win.isDestroyed()) return null;

    try {
      const token = await win.webContents.executeJavaScript(`
        (function() {
          // The SDK stores the token under this key after setAuthToken()
          var token = localStorage.getItem('puter.auth.token.v2');
          if (token && token.length > 20) return token;
          return null;
        })()
      `);
      return typeof token === "string" && token.length > 20 ? token : null;
    } catch {
      return null;
    }
  }

  /** Clean up the auth window. */
  private cleanupAuthWindow(): void {
    if (this.authWindow && !this.authWindow.isDestroyed()) {
      try { this.authWindow.destroy(); } catch { /* ignore */ }
    }
    this.authWindow = null;
  }

  // ── Public API ─────────────────────────────────────────────────────

  /** Get current auth status. */
  getStatus(): { status: "loading" | "connected" | "disconnected"; username?: string; hasToken: boolean } {
    return {
      status: this.authToken ? "connected" : "disconnected",
      username: this.puterUsername ?? undefined,
      hasToken: Boolean(this.authToken)
    };
  }

  /** Get the auth token for API requests. */
  getToken(): string | null {
    return this.authToken;
  }

  /** Get the username. */
  getUsername(): string | null {
    return this.puterUsername;
  }

  /** Re-verify the current token against Puter servers. */
  async refreshSession(): Promise<{ status: "connected" | "disconnected"; username?: string }> {
    this.loadFromStore();
    if (!this.authToken) {
      return { status: "disconnected" };
    }
    const name = await this.verifyToken(this.authToken);
    if (name) {
      this.puterUsername = name;
      this.store.setPuterUsername(name);
      return { status: "connected", username: name };
    }
    this.clearToken();
    return { status: "disconnected" };
  }

  /** Sign out: clear token and persistent session. */
  async signOut(): Promise<void> {
    console.log("[PUTER] Signing out...");
    this.clearToken();
    this.cleanupAuthWindow();
    await this.clearPersistentSession();
    this.notifyRenderer();
  }

  /** Clear the persistent Electron session for Puter. */
  private async clearPersistentSession(): Promise<void> {
    try {
      const ses = session.fromPartition(PUTER_SESSION_PARTITION);
      await ses.clearStorageData();
      console.log("[PUTER] Persistent session cleared");
    } catch { /* best effort */ }
  }
}
