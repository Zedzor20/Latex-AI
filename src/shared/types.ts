export type ApprovalMode = "always" | "destructive" | "trusted" | "autonomous";

/** Filesystem boundary: workspace-only (approved folder) or full PC access. */
export type FilesystemAccess = "workspace" | "full";

/** PC control (screenshot / mouse / keyboard / open app) permission level. */
export type PcControlMode = "off" | "ask" | "on";

/** Supported AI model providers. */
export type ModelProvider = "gemini" | "openrouter" | "minimax" | "groq" | "puter";

export const MODEL_PROVIDERS: ModelProvider[] = ["gemini", "openrouter", "minimax", "groq", "puter"];

export interface Workspace {
  id: string;
  name: string;
  path: string;
  trusted: boolean;
  lastOpenedAt: number;
}

export type ThemePreference = "dark" | "light" | "system";

export interface LatexSettings {
  provider: ModelProvider;
  selectedModel?: string;
  /** When true, Latex picks the best available model per task. */
  autoSelectModel?: boolean;
  approvalMode: ApprovalMode;
  terminalApprovalMode: ApprovalMode;
  /** Filesystem boundary: workspace-only (default) or full PC access. */
  filesystemAccess?: FilesystemAccess;
  /** PC control permission: off | ask (default) | on. */
  pcControl?: PcControlMode;
  temperature: number;
  maxOutputTokens: number;
  theme: ThemePreference;
  shell?: "powershell" | "cmd";
  voiceInput?: boolean;
  speakResponses?: boolean;
  voiceLang?: string;
  notifyOnFinish?: boolean;
}

export interface Attachment {
  id: string;
  name: string;
  kind: "text" | "image" | "workspace" | "conversation";
  /** Text content (truncated for very large files). */
  content?: string;
  /** Base64 image data (no data: prefix). */
  base64?: string;
  mimeType?: string;
  truncated?: boolean;
  size?: number;
  label?: string;
}

export interface GeminiModel {
  name: string;
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
  /** Provider that serves this model (defaults to "gemini" for legacy lists). */
  provider?: ModelProvider;
  /** Normalized model metadata used for search, filtering and Auto selection. */
  contextLength?: number;
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  supportsStreaming?: boolean;
  isFree?: boolean;
  /** Category keywords (coding, reasoning, long-context, vision, fast…). */
  capabilities?: string[];
}

/** Availability of each configured provider, surfaced to the renderer. */
export interface ProviderStatus {
  provider: ModelProvider;
  label: string;
  configured: boolean;
  error?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdAt: number;
  /** Generation start timestamp (assistant messages only). */
  startedAt?: number;
  /** Generation complete timestamp (assistant messages only). */
  completedAt?: number;
  meta?: Record<string, unknown>;
  /** The model that generated this assistant message. */
  model?: string;
  /** The provider that served this assistant message. */
  provider?: ModelProvider;
}

export interface Conversation {
  id: string;
  title: string;
  /** "main" = agent mode, "chat" = conversation-only mode. */
  mode?: "main" | "chat";
  workspaceId?: string;
  selectedModel?: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface FileTreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileTreeNode[];
}

export interface PendingChange {
  id: string;
  filePath: string;
  previousContent: string;
  nextContent: string;
  diff: string;
  status: "pending" | "accepted" | "rejected";
  /** Whether the file existed when the change was prepared (for conflict detection). */
  existed?: boolean;
}

export interface TerminalResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Structured result of a real filesystem operation. success/verified are only true when disk confirms it. */
export interface FileOperationResult {
  success: boolean;
  operation: string;
  path?: string;
  verified?: boolean;
  error?: string;
}

/** An operation the agent wants to perform that requires user approval. */
export interface ApprovalRequest {
  requestId: string;
  operation: string;
  title: string;
  description: string;
  path?: string;
  /** Diff, command, or other preview text. */
  preview?: string;
  reason: string;
  destructive: boolean;
}

/** Detected metadata about an approved workspace. */
export interface WorkspaceInfo {
  path: string;
  isGitRepository: boolean;
  branch?: string;
  frameworks: string[];
  fileCount: number;
  ignoredDirs: string[];
}

export interface AgentActivityStep {
  id: string;
  label: string;
  status: "pending" | "active" | "done" | "failed";
  /** Human-readable description of what is happening (e.g. file path, command). */
  detail?: string;
  /** Timestamp when this step became active or completed. */
  timestamp: number;
}

export interface AgentEvent {
  type: "status" | "message" | "tool" | "changes" | "error" | "terminal" | "approval" | "done" | "activity" | "activity_step" | "activity_complete";
  conversationId: string;
  payload: unknown;
}

// ── Provider error layer ─────────────────────────────────────────────────

/** Normalized provider error returned by every provider adapter. */
export interface ProviderError {
  provider: ModelProvider;
  model: string;
  status: number | null;
  errorType: string;
  message: string;
  retryable: boolean;
  fallbackAllowed: boolean;
  requestId?: string;
  timestamp: number;
}

/** Normalized result of a provider request. */
export interface ProviderResult<T> {
  success: boolean;
  data?: T;
  error?: ProviderError;
}

/** Health state of a specific model, used for AUTO fallback cooldown. */
export interface ModelHealth {
  provider: string;
  model: string;
  status: "healthy" | "degraded" | "unavailable";
  failures: number;
  lastFailure?: number;
  lastStatus?: number;
  cooldownUntil?: number;
}

/** Classify an HTTP status code into a structured provider error. */
export function classifyHttpStatus(
  provider: ModelProvider,
  model: string,
  status: number,
  rawMessage: string,
  requestId?: string
): ProviderError {
  const ts = Date.now();
  const base = { provider, model, status, message: rawMessage, requestId, timestamp: ts } as const;

  switch (status) {
    case 400:
      return { ...base, errorType: "invalid_request", retryable: false, fallbackAllowed: true };
    case 401:
      return { ...base, errorType: "auth_failed", retryable: false, fallbackAllowed: false };
    case 402:
      return { ...base, errorType: "no_credit", retryable: false, fallbackAllowed: true };
    case 403:
      return { ...base, errorType: "forbidden", retryable: false, fallbackAllowed: true };
    case 404:
      return { ...base, errorType: "not_found", retryable: false, fallbackAllowed: true };
    case 408:
      return { ...base, errorType: "timeout", retryable: true, fallbackAllowed: true };
    case 429:
      return { ...base, errorType: "rate_limited", retryable: true, fallbackAllowed: true };
    case 500:
      return { ...base, errorType: "server_error", retryable: true, fallbackAllowed: true };
    case 502:
      return { ...base, errorType: "bad_gateway", retryable: true, fallbackAllowed: true };
    case 503:
      return { ...base, errorType: "unavailable", retryable: true, fallbackAllowed: true };
    case 504:
      return { ...base, errorType: "gateway_timeout", retryable: true, fallbackAllowed: true };
    default:
      return { ...base, errorType: "unknown", retryable: status >= 500, fallbackAllowed: status >= 500 };
  }
}

/** Classify a non-HTTP error (network, timeout, etc.). */
export function classifyNetworkError(
  provider: ModelProvider,
  model: string,
  err: Error,
  requestId?: string
): ProviderError {
  const msg = err.message.toLowerCase();
  const ts = Date.now();
  const base = { provider, model, status: null as number | null, message: err.message, requestId, timestamp: ts } as const;

  if (err.name === "AbortError" || msg.includes("aborted") || msg.includes("abort")) {
    return { ...base, errorType: "aborted", retryable: false, fallbackAllowed: false };
  }
  if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("etimedout")) {
    return { ...base, errorType: "timeout", retryable: true, fallbackAllowed: true };
  }
  if (/fetch failed|econnrefused|enotfound|eai_again|network|unable to reach/i.test(msg)) {
    return { ...base, errorType: "network", retryable: true, fallbackAllowed: true };
  }
  return { ...base, errorType: "unknown", retryable: true, fallbackAllowed: true };
}

/** True when this error should be retried with the same model (e.g. 500, 408). */
export function isRetryableError(err: ProviderError): boolean {
  return err.retryable && err.errorType !== "auth_failed" && err.errorType !== "no_credit";
}

/** True when AUTO mode should fall back to a different model. */
export function shouldFallback(err: ProviderError): boolean {
  return err.fallbackAllowed;
}

/** Human-readable error type label for display. */
export function errorTypeLabel(err: ProviderError): string {
  switch (err.errorType) {
    case "invalid_request": return "Invalid request";
    case "auth_failed": return "Authentication failed";
    case "no_credit": return "Credits unavailable";
    case "forbidden": return "Request forbidden";
    case "not_found": return "Model not found";
    case "timeout": return "Request timed out";
    case "rate_limited": return "Rate limited";
    case "server_error": return "Server error";
    case "bad_gateway": return "Bad gateway";
    case "unavailable": return "Service unavailable";
    case "gateway_timeout": return "Gateway timeout";
    case "aborted": return "Request aborted";
    case "network": return "Network error";
    default: return "Unknown error";
  }
}
