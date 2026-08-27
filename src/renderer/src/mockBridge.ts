import type { AgentEvent, ApprovalRequest, Attachment, Conversation, FileTreeNode, GeminiModel, LatexSettings, ModelProvider, PendingChange, Workspace } from "../../shared/types";

/**
 * Dev-only bridge mock. When the renderer is served by Vite in a plain
 * browser there is no Electron preload, so window.latex is undefined and the
 * app would fall into the error boundary. This installs a functional
 * in-memory stand-in so the real UI renders and is interactive in the
 * browser preview. It is gated on import.meta.env.DEV and on window.latex
 * being absent, so it never runs inside Electron or packaged builds (Vite
 * dead-code-eliminates it from production bundles).
 */
export function installMockBridgeIfNeeded() {
  if (!import.meta.env.DEV || typeof window.latex !== "undefined") return;

  const settings: LatexSettings = {
    provider: "gemini",
    selectedModel: "models/gemini-3.5-flash",
    autoSelectModel: false,
    approvalMode: "always",
    terminalApprovalMode: "always",
    filesystemAccess: "workspace",
    pcControl: "ask",
    temperature: 0.4,
    maxOutputTokens: 8192,
    theme: "dark",
    shell: "powershell",
    voiceInput: true,
    speakResponses: false,
    voiceLang: "auto",
    notifyOnFinish: false
  };

  const providerKeys = new Map<ModelProvider, string>([["gemini", "mock-key"], ["openrouter", "sk-mock-openrouter"]]);
  const providers = () =>
    (["gemini", "openrouter", "minimax", "groq"] as ModelProvider[]).map((provider) => ({
      provider,
      label: provider === "gemini" ? "Google Gemini" : provider === "openrouter" ? "OpenRouter" : provider === "minimax" ? "MiniMax" : "Groq",
      configured: providerKeys.has(provider)
    }));

  let apiKey = "mock-key";
  const mockWorkspace: Workspace = {
    id: "ws_mock",
    name: "Sound recordings",
    path: "C:\\Users\\user\\Documents\\Sound recordings",
    trusted: false,
    lastOpenedAt: Date.now()
  };
  const mockTree: FileTreeNode[] = [
    { name: "src", path: "src", type: "directory", children: [
      { name: "main.ts", path: "src/main.ts", type: "file" },
      { name: "utils.ts", path: "src/utils.ts", type: "file" }
    ] },
    { name: "public", path: "public", type: "directory", children: [
      { name: "index.html", path: "public/index.html", type: "file" }
    ] },
    { name: "package.json", path: "package.json", type: "file" },
    { name: "Recording (10).m4a", path: "Recording (10).m4a", type: "file" },
    { name: "README.md", path: "README.md", type: "file" }
  ];

  const mockModels: GeminiModel[] = [
    { name: "models/gemini-3.6-flash", displayName: "Gemini 3.6 Flash", description: "Fast general model (simulated)", inputTokenLimit: 1_000_000, provider: "gemini", supportsTools: true, contextLength: 1_000_000, capabilities: ["tool-calling"] },
    { name: "models/gemini-3.5-flash", displayName: "Gemini 3.5 Flash", description: "Fast, low-cost model (simulated)", inputTokenLimit: 1_000_000, provider: "gemini", supportsTools: true, contextLength: 1_000_000, capabilities: ["tool-calling"] },
    { name: "models/gemini-3.5-flash-lite", displayName: "Gemini 3.5 Flash-Lite", description: "Cheapest fast model (simulated)", inputTokenLimit: 1_000_000, provider: "gemini", supportsTools: true, contextLength: 1_000_000, capabilities: ["tool-calling"] },
    { name: "models/gemini-3.1-flash-lite", displayName: "Gemini 3.1 Flash-Lite", description: "Lightweight model (simulated)", inputTokenLimit: 1_000_000, provider: "gemini", supportsTools: true, contextLength: 1_000_000, capabilities: ["tool-calling"] },
    { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", description: "Legacy fast model (simulated)", inputTokenLimit: 1_000_000, provider: "gemini", supportsTools: true, contextLength: 1_000_000, capabilities: ["tool-calling"] },
    { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro", description: "Most capable legacy model (simulated)", inputTokenLimit: 1_000_000, provider: "gemini", supportsTools: true, contextLength: 1_000_000, capabilities: ["tool-calling"] },
    { name: "openrouter/meta-llama/llama-3.3-70b-instruct", displayName: "Llama 3.3 70B Instruct", description: "Open-weight instruct model", provider: "openrouter", supportsTools: true, supportsStreaming: true, isFree: true, contextLength: 131_072, capabilities: ["tool-calling", "free"] },
    { name: "openrouter/deepseek/deepseek-r1", displayName: "DeepSeek R1", description: "Open reasoning model", provider: "openrouter", supportsTools: true, supportsReasoning: true, contextLength: 163_840, capabilities: ["tool-calling", "reasoning"] },
    { name: "openrouter/microsoft/phi-4", displayName: "Phi-4", description: "Compact coding model (free)", provider: "openrouter", supportsTools: true, isFree: true, contextLength: 16_384, capabilities: ["tool-calling", "free"] },
    { name: "minimax/MiniMax-M3", displayName: "MiniMax M3", description: "Reasoning + long context", provider: "minimax", supportsTools: true, supportsReasoning: true, contextLength: 1_000_000, capabilities: ["tool-calling", "reasoning", "long-context"] },
    { name: "groq/llama-3.3-70b-versatile", displayName: "Llama 3.3 70B Versatile", description: "Fast open model", provider: "groq", supportsTools: true, contextLength: 131_072, capabilities: ["tool-calling"] },
    { name: "groq/deepseek-r1-distill-llama-70b", displayName: "DeepSeek R1 Distill 70B", description: "Reasoning distill", provider: "groq", supportsTools: false, supportsReasoning: true, contextLength: 131_072, capabilities: ["reasoning"] }
  ];
  const providerStatuses = () => providers();

  let workspaces: Workspace[] = [mockWorkspace];
  let conversations: Conversation[] = [];
  const eventListeners = new Set<(event: AgentEvent) => void>();
  const pendingResolvers = new Map<string, (approved: boolean) => void>();

  const emit = (event: AgentEvent) => {
    for (const listener of eventListeners) listener(event);
  };

  const newId = (prefix: string) => `${prefix}_mock_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

  function waitApproval(conversationId: string, request: ApprovalRequest): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      pendingResolvers.set(request.requestId, resolve);
      emit({ type: "approval", conversationId, payload: request });
    });
  }

  const api = {
    settings: {
      get: async () => ({ ...settings, hasApiKey: providerKeys.has(settings.provider ?? "gemini"), providers: providers() }),
      save: async (partial: Partial<LatexSettings>) => Object.assign(settings, partial),
      saveApiKey: async (key: string, provider: ModelProvider = "gemini") => {
        apiKey = key;
        providerKeys.set(provider, key);
        return { ok: true };
      },
      clearApiKey: async (provider: ModelProvider = "gemini") => {
        providerKeys.delete(provider);
        if (provider === "gemini") apiKey = "";
        return { ok: true };
      }
    },
    ai: {
      test: async (provider: ModelProvider) => {
        if (!providerKeys.has(provider)) throw new Error(`No ${provider} API key has been saved.`);
        return { ok: true };
      },
      models: async (): Promise<GeminiModel[]> =>
        mockModels.filter((model) => providerKeys.has(model.provider ?? "gemini")),
      modelsForProvider: async (provider: ModelProvider): Promise<GeminiModel[]> =>
        mockModels.filter((model) => (model.provider ?? "gemini") === provider && providerKeys.has(provider)),
      healthProbe: async () => [
        { provider: "gemini" as ModelProvider, status: "ok" as const, modelCount: 65 },
        { provider: "openrouter" as ModelProvider, status: "ok" as const, modelCount: 190 },
        { provider: "groq" as ModelProvider, status: "ok" as const, modelCount: 40 },
        { provider: "minimax" as ModelProvider, status: "error" as const, error: "Not configured" }
      ]
    },
    voice: {
      transcribe: async (): Promise<{ text: string }> => {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        return { text: "This is a simulated voice transcript from the browser preview." };
      }
    },
    clipboard: {
      writeText: async (text: string) => {
        await navigator.clipboard.writeText(text).catch(() => undefined);
        return { ok: true };
      }
    },
    workspace: {
      open: async (): Promise<Workspace | null> => {
        workspaces = [mockWorkspace, ...workspaces.filter((w) => w.id !== mockWorkspace.id)];
        return mockWorkspace;
      },
      list: async () => workspaces,
      remove: async (workspaceId: string) => {
        workspaces = workspaces.filter((w) => w.id !== workspaceId);
        return workspaces;
      },
      info: async (ws: Workspace) => ({
        path: ws.path,
        isGitRepository: false,
        branch: undefined,
        frameworks: ["TypeScript", "Vite"],
        fileCount: 24,
        ignoredDirs: ["node_modules", ".git", "dist", "release", "out", ".cache", "target"]
      }),
      watch: async () => ({ ok: true }),
      tree: async () => mockTree,
      onChanged: (callback: (path: string) => void) => {
        // No real filesystem in the browser preview — the callback never fires.
        void callback;
        return () => undefined;
      }
    },
    file: {
      read: async (_ws: Workspace, relativePath: string) => {
        const samples: Record<string, string> = {
          "package.json": '{\n  "name": "sound-recordings",\n  "version": "0.1.0",\n  "private": true,\n  "scripts": {\n    \"dev\": \"vite\",\n    \"build\": \"tsc && vite build\"\n  }\n}\n',
          "src/main.ts": "import { app, BrowserWindow } from 'electron';\n\nconst win = new BrowserWindow({ width: 1200, height: 800 });\nwin.loadURL('http://localhost:5173');\n",
          "src/utils.ts": "export function formatBytes(bytes: number): string {\n  return `${(bytes / 1024).toFixed(1)} KB`;\n}\n",
          "README.md": "# Sound recordings\n\nA demo project used by the preview. In the desktop app this reads the real file from disk.\n",
          "public/index.html": "<!DOCTYPE html>\n<html>\n  <head><title>Preview</title></head>\n  <body><h1>Hello from the preview</h1></body>\n</html>\n"
        };
        return samples[relativePath] ?? `// ${relativePath}\n\nPreview content is simulated in the browser. In the desktop app this reads the real file from disk.\n`;
      },
      pick: async (): Promise<Attachment[]> => [
        { id: `att_mock_${Date.now().toString(36)}`, name: "package.json", kind: "text", content: '{\n  "name": "example-project",\n  "dependencies": { "react": "^18.3.1" }\n}\n', size: 82, mimeType: "application/json" }
      ],
      applyChange: async () => ({ ok: true }),
      delete: async () => ({ ok: true }),
      open: async () => ({ ok: true })
    },
    notifications: {
      send: async () => ({ ok: true })
    },
    shell: {
      showInFolder: async () => ({ ok: true })
    },
    terminal: {
      run: async () => ({ command: "", cwd: "", exitCode: 0, stdout: "(simulated: no terminal in the browser preview)", stderr: "" })
    },
    conversation: {
      list: async () => conversations,
      save: async (conversation: Conversation) => {
        conversations = [conversation, ...conversations.filter((item) => item.id !== conversation.id)];
        return conversation;
      },
      delete: async (conversationId: string) => {
        conversations = conversations.filter((item) => item.id !== conversationId);
        return { ok: true };
      },
      clear: async () => {
        conversations = [];
        return [];
      }
    },
    agent: {
      chat: async (conversation: Conversation, _workspace?: Workspace, attachments: Attachment[] = []): Promise<Conversation> => {
        return finishMockRun(conversation, "chat", attachments);
      },
      run: async (conversation: Conversation, _workspace?: Workspace, attachments: Attachment[] = []): Promise<Conversation> => {
        return finishMockRun(conversation, "agent", attachments);
      },
      stop: async () => {
        for (const [requestId, resolve] of pendingResolvers) {
          pendingResolvers.delete(requestId);
          resolve(false);
        }
        for (const listener of eventListeners) listener({ type: "done", conversationId: "active", payload: null });
        return { ok: true };
      },
      resolveApproval: async (requestId: string, approved: boolean) => {
        const resolver = pendingResolvers.get(requestId);
        if (resolver) {
          pendingResolvers.delete(requestId);
          resolver(approved);
          return { ok: true };
        }
        return { ok: false };
      },
      onEvent: (callback: (event: AgentEvent) => void) => {
        eventListeners.add(callback);
        return () => eventListeners.delete(callback);
      }
    },
    puter: {
      signIn: async () => ({ ok: false, error: "Mock: Puter sign-in not available in browser preview" }),
      signOut: async () => ({ ok: true }),
      getStatus: async () => ({ status: "disconnected", username: undefined, hasToken: false }),
      refreshStatus: async () => ({ status: "disconnected", username: undefined }),
      onAuthChanged: (_callback: (data: { status: string; username?: string }) => void) => {
        return () => undefined;
      }
    }
  };

  async function finishMockRun(conversation: Conversation, mode: "chat" | "agent", attachments: Attachment[]): Promise<Conversation> {
    const userText = conversation.messages[conversation.messages.length - 1]?.content ?? "";
    const lower = userText.toLowerCase();
    const codeDemo = /explain|code|function/.test(userText)
      ? "\n\n```typescript\nconst greet = (name: string) => `Hello, ${name}!`;\nconsole.log(greet(\"Latex\"));\n```"
      : "";
    const attachmentNote = attachments.length
      ? `\n\n(Context attached: ${attachments.map((a) => a.name).join(", ")} — in the real app this content is sent to Gemini.)`
      : "";

    // Emulate the agent's tool loop with pause/resume approval.
    const op = /delete (this |the )?/.test(lower)
      ? { operation: "delete_file", path: "test.txt", title: "Delete file: test.txt", preview: "Delete file: test.txt", destructive: true }
      : /rename|move/.test(lower)
        ? { operation: "rename_file", path: "test.txt", title: "Rename test.txt → hello.txt", preview: "Rename test.txt → hello.txt", destructive: false }
        : /run |npm |command|build/.test(lower)
          ? { operation: "run_command", path: undefined, title: "Run command", preview: `npm --version`, destructive: false }
          : /create|write|add a file/.test(lower)
            ? { operation: "write_file", path: "src/hello.ts", title: "Write file: src/hello.ts", preview: "--- src/hello.ts\n+++ src/hello.ts\n@@ -0,0 +1,2 @@\n+// Hello Latex\n+console.log('hi from the preview');\n", destructive: false }
            : null;

    if (op && mode === "agent") {
      emit({ type: "status", conversationId: conversation.id, payload: "Inspecting workspace (simulated)" });
      const request: ApprovalRequest = { requestId: newId("aprv"), operation: op.operation, title: op.title, description: op.destructive ? "This operation permanently removes files." : "Ask before modifying workspace files.", path: op.path, preview: op.preview, reason: "Simulated approval", destructive: op.destructive };
      const approved = await waitApproval(conversation.id, request);
      if (!approved) {
        const reply = `I couldn't ${op.operation.replace(/_/g, " ")} — the operation was **cancelled**. Nothing was changed.`;
        return completeWith(conversation, reply, [], mode);
      }
      if (op.operation === "run_command") {
        emit({ type: "tool", conversationId: "active", payload: { name: "run_command", status: "ok", path: undefined } });
        const reply = `**Command executed** (simulated):\n\n\`\`\`\nnpm --version\n\`\`\`\n\nIn the real app this runs in the approved workspace with the real shell.`;
        return completeWith(conversation, reply, [], mode);
      }
      const change: PendingChange = {
        id: newId("change"),
        filePath: op.path ?? "src/hello.ts",
        previousContent: op.operation === "write_file" ? "" : "// placeholder\n",
        nextContent: "// Hello Latex\nconsole.log('hi from the preview');\n",
        diff: op.preview ?? "",
        status: "accepted",
        existed: op.operation !== "write_file"
      };
      emit({ type: "tool", conversationId: "active", payload: { name: op.operation, status: "ok", path: op.path } });
      emit({ type: "changes", conversationId: conversation.id, payload: [change] });
      const reply =
        op.operation === "delete_file"
          ? "**Deleted** test.txt (simulated — verified removed)."
          : op.operation === "rename_file"
            ? "**Renamed** test.txt → hello.txt (simulated — verified)."
            : "**Created** src/hello.ts (simulated). In the real desktop app the file is actually written to disk and verified.";
      return completeWith(conversation, reply, [change], mode);
    }

    const reply =
      (mode === "agent"
        ? "**Simulated agent run** — in the desktop app Latex uses the Gemini API against your approved workspace.\n\n"
        : "**Simulated chat reply** — normal conversation works without a workspace.\n\n") +
      `You asked:\n\n> ${userText.slice(0, 140)}\n\n` +
      "This preview mock lets you explore the interface — sidebar, composer, settings, search, explorer, chat history and the diff viewer all work here." +
      codeDemo +
      attachmentNote;
    return completeWith(conversation, reply, [], mode);
  }

  async function completeWith(conversation: Conversation, reply: string, changes: PendingChange[], mode: "chat" | "agent"): Promise<Conversation> {
    const assistantMessage = {
      id: newId("msg"),
      role: "assistant" as const,
      content: reply,
      createdAt: Date.now()
    };
    const next: Conversation = { ...conversation, messages: [...conversation.messages, assistantMessage], updatedAt: Date.now() };
    setTimeout(() => emit({ type: "message", conversationId: conversation.id, payload: reply }), 300);
    for (const change of changes) emit({ type: "changes", conversationId: conversation.id, payload: [change] });
    await new Promise((resolve) => setTimeout(resolve, 700));
    conversations = [next, ...conversations.filter((item) => item.id !== next.id)];
    emit({ type: "done", conversationId: conversation.id, payload: next });
    return next;
  }

  window.latex = api as unknown as typeof window.latex;
}
