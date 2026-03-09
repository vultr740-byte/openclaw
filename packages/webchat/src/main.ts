type GatewayEventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
};

type GatewayResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code?: string; message?: string; details?: unknown };
};

type ChatEventPayload = {
  runId?: string;
  sessionKey?: string;
  state?: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  errorMessage?: string;
};

type Settings = {
  gatewayUrl: string;
  sessionKey: string;
  token: string;
};

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

const SETTINGS_STORAGE_KEY = "openclaw.webchat.settings.v1";
const TOKEN_STORAGE_KEY = "openclaw.webchat.token.v1";

const gatewayUrlInput = document.querySelector<HTMLInputElement>("#gateway-url");
const tokenInput = document.querySelector<HTMLInputElement>("#gateway-token");
const sessionKeyInput = document.querySelector<HTMLInputElement>("#session-key");
const connectButton = document.querySelector<HTMLButtonElement>("#connect-btn");
const disconnectButton = document.querySelector<HTMLButtonElement>("#disconnect-btn");
const reloadButton = document.querySelector<HTMLButtonElement>("#reload-btn");
const sendButton = document.querySelector<HTMLButtonElement>("#send-btn");
const stopButton = document.querySelector<HTMLButtonElement>("#stop-btn");
const composer = document.querySelector<HTMLTextAreaElement>("#composer");
const messagesEl = document.querySelector<HTMLDivElement>("#messages");
const statusEl = document.querySelector<HTMLParagraphElement>("#status");

if (
  !gatewayUrlInput ||
  !tokenInput ||
  !sessionKeyInput ||
  !connectButton ||
  !disconnectButton ||
  !reloadButton ||
  !sendButton ||
  !stopButton ||
  !composer ||
  !messagesEl ||
  !statusEl
) {
  throw new Error("webchat: missing required DOM elements");
}

let ws: WebSocket | null = null;
let reqCounter = 0;
let pending = new Map<string, PendingRequest>();
let manualClose = false;
let connected = false;
let handshakeReady = false;
let currentRunId: string | null = null;
let streamText: string | null = null;
let streamEl: HTMLDivElement | null = null;

applySettingsFromUrl();
const initialSettings = loadSettings();

gatewayUrlInput.value = initialSettings.gatewayUrl;
sessionKeyInput.value = initialSettings.sessionKey;
tokenInput.value = initialSettings.token;
updateButtons();

connectButton.addEventListener("click", () => {
  void connect();
});

disconnectButton.addEventListener("click", () => {
  disconnect();
});

reloadButton.addEventListener("click", () => {
  void loadChatHistory();
});

sendButton.addEventListener("click", () => {
  void sendMessage();
});

stopButton.addEventListener("click", () => {
  void abortRun();
});

composer.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") {
    return;
  }
  if (event.shiftKey || event.isComposing) {
    return;
  }
  event.preventDefault();
  void sendMessage();
});

function loadSettings(): Settings {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const defaults: Settings = {
    gatewayUrl: `${proto}://${window.location.host}`,
    sessionKey: "main",
    token: sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? "",
  };

  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return defaults;
    }
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      gatewayUrl:
        typeof parsed.gatewayUrl === "string" && parsed.gatewayUrl.trim()
          ? parsed.gatewayUrl.trim()
          : defaults.gatewayUrl,
      sessionKey:
        typeof parsed.sessionKey === "string" && parsed.sessionKey.trim()
          ? parsed.sessionKey.trim()
          : defaults.sessionKey,
      token: defaults.token,
    };
  } catch {
    return defaults;
  }
}

function saveSettings(settings: Settings): void {
  const persisted = {
    gatewayUrl: settings.gatewayUrl,
    sessionKey: settings.sessionKey,
  };
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(persisted));
  if (settings.token.trim()) {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, settings.token.trim());
  } else {
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  }
}

function applySettingsFromUrl(): void {
  if (!window.location.search && !window.location.hash) {
    return;
  }
  const url = new URL(window.location.href);
  const params = new URLSearchParams(url.search);
  const hashParams = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);

  const token = params.get("token") ?? hashParams.get("token");
  const gatewayUrl = params.get("gatewayUrl") ?? hashParams.get("gatewayUrl");
  const sessionKey = params.get("session") ?? hashParams.get("session");

  if (token) {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, token.trim());
    params.delete("token");
    hashParams.delete("token");
  }
  if (gatewayUrl) {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        gatewayUrl: gatewayUrl.trim(),
        sessionKey: sessionKey?.trim() || "main",
      }),
    );
    params.delete("gatewayUrl");
    hashParams.delete("gatewayUrl");
  }
  if (sessionKey) {
    const existing = loadSettings();
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        gatewayUrl: existing.gatewayUrl,
        sessionKey: sessionKey.trim(),
      }),
    );
    params.delete("session");
    hashParams.delete("session");
  }

  url.search = params.toString();
  const nextHash = hashParams.toString();
  url.hash = nextHash ? `#${nextHash}` : "";
  window.history.replaceState({}, "", url.toString());
}

function readSettingsFromInputs(): Settings {
  return {
    gatewayUrl: gatewayUrlInput.value.trim(),
    sessionKey: sessionKeyInput.value.trim() || "main",
    token: tokenInput.value.trim(),
  };
}

function setStatus(level: "info" | "ok" | "warn" | "error", message: string): void {
  statusEl.className = `status status--${level}`;
  statusEl.textContent = message;
}

function updateButtons(): void {
  const socketOpen = ws?.readyState === WebSocket.OPEN;
  connectButton.disabled = socketOpen;
  disconnectButton.disabled = !socketOpen;
  reloadButton.disabled = !handshakeReady;
  sendButton.disabled = !handshakeReady;
  stopButton.disabled = !handshakeReady || !currentRunId;
  composer.disabled = !handshakeReady;
}

function nextRequestId(): string {
  reqCounter += 1;
  return `req-${Date.now()}-${reqCounter}`;
}

function request<T = unknown>(method: string, params?: unknown): Promise<T> {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("socket not connected"));
  }

  const id = nextRequestId();
  const frame = {
    type: "req",
    id,
    method,
    params,
  };

  return new Promise<T>((resolve, reject) => {
    pending.set(id, {
      method,
      resolve: (value) => resolve(value as T),
      reject,
    });
    ws!.send(JSON.stringify(frame));
  });
}

function rejectAllPending(reason: string): void {
  for (const [, entry] of pending) {
    entry.reject(new Error(reason));
  }
  pending.clear();
}

async function connect(): Promise<void> {
  const settings = readSettingsFromInputs();
  if (!settings.gatewayUrl) {
    setStatus("error", "Gateway URL is required.");
    return;
  }

  saveSettings(settings);

  if (ws && ws.readyState === WebSocket.OPEN) {
    setStatus("info", "Already connected.");
    return;
  }

  if (ws && ws.readyState === WebSocket.CONNECTING) {
    setStatus("info", "Connection in progress...");
    return;
  }

  manualClose = false;
  connected = false;
  handshakeReady = false;
  currentRunId = null;
  clearStreamingIndicator();

  setStatus("info", "Connecting...");

  ws = new WebSocket(settings.gatewayUrl);
  updateButtons();

  ws.addEventListener("open", () => {
    setStatus("info", "Socket opened. Waiting for challenge...");
    connected = true;
    updateButtons();
  });

  ws.addEventListener("message", (event) => {
    const text = String(event.data ?? "");
    void handleIncomingFrame(text);
  });

  ws.addEventListener("close", (event) => {
    connected = false;
    handshakeReady = false;
    currentRunId = null;
    clearStreamingIndicator();
    rejectAllPending(`socket closed (${event.code}): ${event.reason || "no reason"}`);
    if (manualClose) {
      setStatus("warn", "Disconnected.");
    } else {
      setStatus("error", `Disconnected (${event.code}): ${event.reason || "no reason"}`);
    }
    updateButtons();
    ws = null;
  });

  ws.addEventListener("error", () => {
    setStatus("error", "WebSocket error.");
  });
}

function disconnect(): void {
  manualClose = true;
  if (ws) {
    ws.close(1000, "manual disconnect");
  }
}

async function handleIncomingFrame(raw: string): Promise<void> {
  let frame: unknown;
  try {
    frame = JSON.parse(raw);
  } catch {
    return;
  }

  if (!frame || typeof frame !== "object") {
    return;
  }

  const typed = frame as { type?: unknown };
  if (typed.type === "res") {
    handleResponseFrame(frame as GatewayResponseFrame);
    return;
  }

  if (typed.type === "event") {
    await handleEventFrame(frame as GatewayEventFrame);
  }
}

function handleResponseFrame(frame: GatewayResponseFrame): void {
  const entry = pending.get(frame.id);
  if (!entry) {
    return;
  }
  pending.delete(frame.id);

  if (frame.ok) {
    entry.resolve(frame.payload);
    return;
  }

  const details = frame.error?.code ? `${frame.error.code}: ` : "";
  entry.reject(new Error(`${details}${frame.error?.message ?? "request failed"}`));
}

async function handleEventFrame(frame: GatewayEventFrame): Promise<void> {
  if (frame.event === "connect.challenge") {
    await completeHandshake();
    return;
  }

  if (frame.event === "chat") {
    handleChatEvent(frame.payload);
    return;
  }

  if (frame.event === "shutdown") {
    setStatus("warn", "Gateway is shutting down.");
  }
}

async function completeHandshake(): Promise<void> {
  if (!connected) {
    return;
  }

  const settings = readSettingsFromInputs();

  const connectParams = {
    minProtocol: 3,
    maxProtocol: 3,
    client: {
      id: "webchat-ui",
      version: "webchat/0.1.0",
      platform: navigator.platform || "web",
      mode: "webchat",
      instanceId: crypto.randomUUID(),
    },
    role: "operator",
    scopes: [],
    caps: ["tool-events"],
    auth: settings.token ? { token: settings.token } : undefined,
    locale: navigator.language,
    userAgent: navigator.userAgent,
    device: undefined,
  };

  try {
    await request("connect", connectParams);
    handshakeReady = true;
    updateButtons();
    setStatus("ok", "Connected. Loading chat history...");
    await loadChatHistory();
  } catch (error) {
    handshakeReady = false;
    updateButtons();
    setStatus("error", `Handshake failed: ${String(error)}`);
    disconnect();
  }
}

function extractText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }

  const entry = message as Record<string, unknown>;

  if (typeof entry.text === "string") {
    return entry.text;
  }

  if (typeof entry.content === "string") {
    return entry.content;
  }

  if (!Array.isArray(entry.content)) {
    return "";
  }

  const parts: string[] = [];
  for (const block of entry.content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const row = block as Record<string, unknown>;
    if (row.type === "text" && typeof row.text === "string") {
      parts.push(row.text);
      continue;
    }
    if (row.type === "toolcall" && typeof row.name === "string") {
      parts.push(`[toolcall] ${row.name}`);
      continue;
    }
    if (row.type === "toolresult" && typeof row.text === "string") {
      parts.push(`[tool] ${row.text}`);
    }
  }

  return parts.join("\n");
}

function extractRole(message: unknown): "user" | "assistant" | "system" {
  if (!message || typeof message !== "object") {
    return "assistant";
  }

  const role = (message as Record<string, unknown>).role;
  if (typeof role !== "string") {
    return "assistant";
  }

  const normalized = role.toLowerCase();
  if (normalized === "user" || normalized === "assistant" || normalized === "system") {
    return normalized;
  }

  if (normalized === "toolresult" || normalized === "tool") {
    return "system";
  }

  return "assistant";
}

function appendMessage(role: "user" | "assistant" | "system", text: string, meta?: string): void {
  const row = document.createElement("div");
  row.className = `message message--${role}`;

  if (meta) {
    const metaEl = document.createElement("div");
    metaEl.className = "message__meta";
    metaEl.textContent = meta;
    row.appendChild(metaEl);
  }

  const textEl = document.createElement("div");
  textEl.textContent = text || "(empty)";
  row.appendChild(textEl);

  messagesEl.appendChild(row);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function clearMessages(): void {
  messagesEl.innerHTML = "";
}

function formatTimestamp(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toLocaleTimeString();
  }
  return new Date().toLocaleTimeString();
}

function ensureStreamingIndicator(): HTMLDivElement {
  if (streamEl) {
    return streamEl;
  }

  const row = document.createElement("div");
  row.className = "message message--streaming";

  const meta = document.createElement("div");
  meta.className = "message__meta";
  meta.textContent = "assistant streaming";
  row.appendChild(meta);

  const body = document.createElement("div");
  body.textContent = "...";
  row.appendChild(body);

  messagesEl.appendChild(row);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  streamEl = row;
  return row;
}

function updateStreamingIndicator(text: string): void {
  const row = ensureStreamingIndicator();
  const body = row.lastElementChild as HTMLDivElement | null;
  if (body) {
    body.textContent = text || "...";
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function clearStreamingIndicator(): void {
  if (streamEl && streamEl.parentNode) {
    streamEl.parentNode.removeChild(streamEl);
  }
  streamEl = null;
  streamText = null;
}

async function loadChatHistory(): Promise<void> {
  if (!handshakeReady) {
    setStatus("warn", "Connect first.");
    return;
  }

  try {
    const settings = readSettingsFromInputs();
    const res = await request<{ messages?: unknown[] }>("chat.history", {
      sessionKey: settings.sessionKey,
      limit: 200,
    });

    clearMessages();
    clearStreamingIndicator();

    const items = Array.isArray(res?.messages) ? res.messages : [];
    for (const item of items) {
      const role = extractRole(item);
      const text = extractText(item);
      appendMessage(
        role,
        text,
        `${role} · ${formatTimestamp((item as { timestamp?: unknown }).timestamp)}`,
      );
    }

    setStatus("ok", `History loaded (${items.length} messages).`);
  } catch (error) {
    setStatus("error", `History load failed: ${String(error)}`);
  }
}

async function sendMessage(): Promise<void> {
  if (!handshakeReady) {
    setStatus("warn", "Connect first.");
    return;
  }

  const message = composer.value.trim();
  if (!message) {
    return;
  }

  appendMessage("user", message, `user · ${new Date().toLocaleTimeString()}`);
  composer.value = "";

  const settings = readSettingsFromInputs();
  const runId = crypto.randomUUID();
  currentRunId = runId;
  streamText = "";
  updateStreamingIndicator("...");
  updateButtons();

  try {
    await request("chat.send", {
      sessionKey: settings.sessionKey,
      message,
      deliver: false,
      idempotencyKey: runId,
    });
    setStatus("info", "Message sent. Waiting for assistant...");
  } catch (error) {
    currentRunId = null;
    clearStreamingIndicator();
    updateButtons();
    appendMessage("system", `send failed: ${String(error)}`, "system");
    setStatus("error", `Send failed: ${String(error)}`);
  }
}

async function abortRun(): Promise<void> {
  if (!handshakeReady) {
    return;
  }

  const settings = readSettingsFromInputs();

  try {
    await request(
      "chat.abort",
      currentRunId
        ? { sessionKey: settings.sessionKey, runId: currentRunId }
        : { sessionKey: settings.sessionKey },
    );
    setStatus("warn", "Abort requested.");
  } catch (error) {
    setStatus("error", `Abort failed: ${String(error)}`);
  }
}

function handleChatEvent(payload: unknown): void {
  if (!payload || typeof payload !== "object") {
    return;
  }

  const chat = payload as ChatEventPayload;
  const settings = readSettingsFromInputs();
  if (chat.sessionKey && chat.sessionKey !== settings.sessionKey) {
    return;
  }

  const incomingRunId = chat.runId ?? null;
  if (incomingRunId && currentRunId && incomingRunId !== currentRunId) {
    if (chat.state === "final" && chat.message) {
      const text = extractText(chat.message);
      if (text.trim()) {
        appendMessage("assistant", text, `assistant · ${new Date().toLocaleTimeString()}`);
      }
    }
    return;
  }

  if (chat.state === "delta") {
    const text = extractText(chat.message);
    if (!text) {
      return;
    }
    if (!streamText || text.length >= streamText.length) {
      streamText = text;
      updateStreamingIndicator(text);
    }
    return;
  }

  if (chat.state === "final") {
    const finalText = extractText(chat.message);
    const textToCommit = finalText.trim() || (streamText ?? "").trim();
    if (textToCommit) {
      appendMessage("assistant", textToCommit, `assistant · ${new Date().toLocaleTimeString()}`);
    }
    currentRunId = null;
    clearStreamingIndicator();
    updateButtons();
    setStatus("ok", "Assistant response complete.");
    return;
  }

  if (chat.state === "aborted") {
    const abortedText = extractText(chat.message).trim() || (streamText ?? "").trim();
    if (abortedText) {
      appendMessage("assistant", abortedText, "assistant · aborted");
    }
    currentRunId = null;
    clearStreamingIndicator();
    updateButtons();
    setStatus("warn", "Run aborted.");
    return;
  }

  if (chat.state === "error") {
    currentRunId = null;
    clearStreamingIndicator();
    updateButtons();
    setStatus("error", chat.errorMessage ?? "Chat error");
  }
}
