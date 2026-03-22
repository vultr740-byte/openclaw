import { randomUUID } from "node:crypto";
import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import type { ChannelId, ChannelLoginQrPayload, ChannelPlugin } from "../channels/plugins/types.js";
import { resolveBootstrapChannelEntry } from "../commands/channels/bootstrap-registry.js";
import { loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

export type ChannelLoginSessionStatus = "missing" | "qr_ready" | "connected" | "expired" | "error";

export type ChannelLoginSessionQr = {
  kind: "data_url" | "text";
  value: string;
};

export type ChannelLoginSessionPayload = {
  channel: string;
  loginKey: string;
  status: ChannelLoginSessionStatus;
  connected: boolean;
  message: string;
  sessionKey?: string;
  accountId?: string;
  qr?: ChannelLoginSessionQr;
  ttlMs?: number;
  startedAt?: number;
  updatedAt?: number;
  expiresAt?: number;
};

type ChannelLoginStartInput = {
  channel: string;
  loginKey?: string;
  accountId?: string;
  force?: boolean;
  timeoutMs?: number;
  verbose?: boolean;
  context: GatewayRequestContext;
};

type ChannelLoginStatusInput = {
  channel: string;
  loginKey?: string;
  accountId?: string;
  context: GatewayRequestContext;
};

type SessionRecord = {
  storeKey: string;
  channelId: ChannelId;
  loginKey: string;
  requestedAccountId?: string;
  pluginAccountId: string;
  sessionKey?: string;
  status: Exclude<ChannelLoginSessionStatus, "missing">;
  connected: boolean;
  message: string;
  qr?: ChannelLoginSessionQr;
  accountId?: string;
  ttlMs?: number;
  startedAt: number;
  updatedAt: number;
  expiresAt?: number;
  revision: number;
};

type ChannelLoginHints = {
  ttlMs?: number;
  waitTimeoutMs?: number;
};

const log = createSubsystemLogger("channel-login");
const sessions = new Map<string, SessionRecord>();
const DEFAULT_CHANNEL_LOGIN_KEY = "default";

const CHANNEL_LOGIN_HINTS: Partial<Record<string, ChannelLoginHints>> = {
  "openclaw-weixin": {
    ttlMs: 5 * 60_000,
    waitTimeoutMs: 5 * 60_000,
  },
  whatsapp: {
    ttlMs: 3 * 60_000,
    waitTimeoutMs: 3 * 60_000,
  },
};

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function resolveLoginKey(loginKey: string | undefined): string {
  return normalizeNonEmptyString(loginKey) ?? DEFAULT_CHANNEL_LOGIN_KEY;
}

function resolveStoreKey(channelId: ChannelId, loginKey: string): string {
  return `${channelId}::${loginKey.trim().toLowerCase()}`;
}

function buildAttemptAccountId(loginKey: string): string {
  const slug = loginKey
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const base = slug || "login";
  return `login-${base}-${randomUUID().slice(0, 8)}`;
}

function resolveLoginHints(channelId: ChannelId): ChannelLoginHints {
  return CHANNEL_LOGIN_HINTS[channelId] ?? {};
}

function inferQrPayload(value: {
  qr?: ChannelLoginQrPayload;
  qrDataUrl?: string;
}): ChannelLoginSessionQr | undefined {
  const qrValue = normalizeNonEmptyString(value.qr?.value);
  if (qrValue) {
    return {
      kind: value.qr?.kind === "data_url" ? "data_url" : "text",
      value: qrValue,
    };
  }

  const qrDataUrl = normalizeNonEmptyString(value.qrDataUrl);
  if (!qrDataUrl) {
    return undefined;
  }

  return {
    kind: qrDataUrl.startsWith("data:image/") ? "data_url" : "text",
    value: qrDataUrl,
  };
}

function resolveTtlMs(channelId: ChannelId, ttlMs?: number): number | undefined {
  if (typeof ttlMs === "number" && Number.isFinite(ttlMs) && ttlMs > 0) {
    return Math.floor(ttlMs);
  }
  return resolveLoginHints(channelId).ttlMs;
}

function resolveWaitTimeoutMs(channelId: ChannelId, ttlMs?: number): number {
  const hinted = resolveLoginHints(channelId).waitTimeoutMs;
  const resolved = ttlMs ?? hinted ?? 120_000;
  return Math.max(Math.floor(resolved), 1000);
}

function isFailureMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("failed") ||
    normalized.includes("error") ||
    normalized.includes("logged out") ||
    normalized.includes("no active") ||
    normalized.includes("未返回") ||
    normalized.includes("失败") ||
    normalized.includes("错误")
  );
}

function toPayload(session: SessionRecord): ChannelLoginSessionPayload {
  return {
    channel: session.channelId,
    loginKey: session.loginKey,
    status: session.status,
    connected: session.connected,
    message: session.message,
    ...(session.sessionKey ? { sessionKey: session.sessionKey } : {}),
    ...(session.accountId ? { accountId: session.accountId } : {}),
    ...(session.qr ? { qr: session.qr } : {}),
    ...(session.ttlMs ? { ttlMs: session.ttlMs } : {}),
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
  };
}

function resolvePersistedConnectedPayload(params: {
  channelId: ChannelId;
  loginKey: string;
  accountId?: string;
  plugin: ChannelPlugin;
}): ChannelLoginSessionPayload | null {
  const cfg = loadConfig();
  const requestedAccountId = normalizeNonEmptyString(params.accountId);

  const candidates = requestedAccountId
    ? [requestedAccountId]
    : params.plugin.config.listAccountIds(cfg).filter(Boolean);
  const configured: string[] = [];

  for (const candidate of candidates) {
    try {
      const account = params.plugin.config.resolveAccount(cfg, candidate);
      const isConfigured = params.plugin.config.isConfigured
        ? params.plugin.config.isConfigured(account, cfg)
        : true;
      if (isConfigured instanceof Promise) {
        log.warn(
          `persisted login fallback for ${params.channelId} returned a promise; skipping async config probe`,
        );
        return null;
      }
      if (isConfigured) {
        configured.push(candidate);
      }
    } catch (err) {
      log.warn(
        `persisted login fallback failed for ${params.channelId} account=${candidate}: ${String(err)}`,
      );
    }
  }

  if (configured.length !== 1) {
    return null;
  }

  return {
    channel: params.channelId,
    loginKey: params.loginKey,
    status: "connected",
    connected: true,
    message: "Channel account is already configured.",
    accountId: configured[0],
  };
}

function resolveChannelLoginPlugin(rawChannel: string): {
  channelId: ChannelId;
  plugin: ChannelPlugin | undefined;
} | null {
  const direct = normalizeChannelId(rawChannel);
  if (direct) {
    return {
      channelId: direct,
      plugin: getChannelPlugin(direct),
    };
  }

  const bootstrapEntry = resolveBootstrapChannelEntry(rawChannel);
  if (!bootstrapEntry) {
    return null;
  }

  const channelId = bootstrapEntry.channelId as ChannelId;
  return {
    channelId,
    plugin: getChannelPlugin(channelId),
  };
}

function refreshExpiredStatus(session: SessionRecord): SessionRecord {
  if (
    session.status === "qr_ready" &&
    typeof session.expiresAt === "number" &&
    Number.isFinite(session.expiresAt) &&
    Date.now() >= session.expiresAt
  ) {
    session.status = "expired";
    session.updatedAt = Date.now();
    if (!session.message.trim()) {
      session.message = "Login QR expired. Refresh to generate a new one.";
    }
  }
  return session;
}

function getActiveSession(storeKey: string): SessionRecord | undefined {
  const session = sessions.get(storeKey);
  if (!session) {
    return undefined;
  }
  return refreshExpiredStatus(session);
}

function purgeStaleSessions(): void {
  const now = Date.now();
  for (const [key, session] of sessions) {
    const terminal =
      session.status === "connected" || session.status === "expired" || session.status === "error";
    if (terminal && now - session.updatedAt > 60 * 60_000) {
      sessions.delete(key);
    }
  }
}

async function runBackgroundWait(params: {
  session: SessionRecord;
  plugin: ChannelPlugin;
  context: GatewayRequestContext;
}): Promise<void> {
  const wait = params.plugin.gateway?.loginWithQrWait;
  if (!wait) {
    return;
  }

  const revision = params.session.revision;
  const waitTimeoutMs = resolveWaitTimeoutMs(params.session.channelId, params.session.ttlMs);

  try {
    const result = await wait({
      accountId: params.session.pluginAccountId,
      sessionKey: params.session.sessionKey,
      timeoutMs: waitTimeoutMs,
    });

    const current = sessions.get(params.session.storeKey);
    if (!current || current.revision !== revision) {
      return;
    }

    const now = Date.now();
    current.updatedAt = now;
    current.message = result.message;
    current.sessionKey = normalizeNonEmptyString(result.sessionKey) ?? current.sessionKey;
    current.accountId = normalizeNonEmptyString(result.accountId) ?? current.accountId;
    current.ttlMs = resolveTtlMs(current.channelId, result.ttlMs) ?? current.ttlMs;
    current.expiresAt =
      current.ttlMs && current.status !== "connected"
        ? current.startedAt + current.ttlMs
        : current.expiresAt;

    const nextQr = inferQrPayload(result);
    if (nextQr) {
      current.qr = nextQr;
    }

    if (result.connected) {
      current.status = "connected";
      current.connected = true;
      current.qr = undefined;
      const startAccountId = current.accountId ?? current.requestedAccountId;
      if (startAccountId) {
        await params.context.startChannel(current.channelId, startAccountId);
      }
      return;
    }

    current.connected = false;
    if (result.expired === true || (current.expiresAt != null && now >= current.expiresAt)) {
      current.status = "expired";
      return;
    }
    current.status = isFailureMessage(result.message) ? "error" : "qr_ready";
  } catch (err) {
    const current = sessions.get(params.session.storeKey);
    if (!current || current.revision !== revision) {
      return;
    }
    current.status = "error";
    current.connected = false;
    current.updatedAt = Date.now();
    current.message = `Login wait failed: ${String(err)}`;
    log.warn(
      `background channel login wait failed channel=${current.channelId} loginKey=${current.loginKey}: ${String(err)}`,
    );
  }
}

async function beginChannelLoginSession(
  params: ChannelLoginStartInput & { force: boolean },
): Promise<ChannelLoginSessionPayload> {
  purgeStaleSessions();

  const resolved = resolveChannelLoginPlugin(params.channel);
  if (!resolved) {
    throw new Error(`Unsupported channel: ${params.channel}`);
  }
  const { channelId, plugin } = resolved;
  if (!plugin?.gateway?.loginWithQrStart) {
    throw new Error(`Channel ${channelId} does not support QR login`);
  }

  const normalizedLoginKey = resolveLoginKey(params.loginKey);
  const storeKey = resolveStoreKey(channelId, normalizedLoginKey);
  const previous = getActiveSession(storeKey);

  if (previous && !params.force && previous.status === "qr_ready") {
    return toPayload(previous);
  }

  const requestedAccountId = normalizeNonEmptyString(params.accountId);
  const stopAccountId = requestedAccountId ?? previous?.accountId;
  if (stopAccountId) {
    await params.context.stopChannel(channelId, stopAccountId);
  }

  const pluginAccountId = requestedAccountId ?? buildAttemptAccountId(normalizedLoginKey);
  const startResult = await plugin.gateway.loginWithQrStart({
    accountId: pluginAccountId,
    force: params.force,
    timeoutMs: params.timeoutMs,
    verbose: params.verbose,
  });

  const now = Date.now();
  const ttlMs = resolveTtlMs(channelId, startResult.ttlMs);
  const session: SessionRecord = {
    storeKey,
    channelId,
    loginKey: normalizedLoginKey,
    requestedAccountId,
    pluginAccountId,
    sessionKey: normalizeNonEmptyString(startResult.sessionKey) ?? pluginAccountId,
    status: inferQrPayload(startResult) ? "qr_ready" : "error",
    connected: false,
    message: startResult.message,
    qr: inferQrPayload(startResult),
    ttlMs,
    startedAt: now,
    updatedAt: now,
    ...(ttlMs ? { expiresAt: now + ttlMs } : {}),
    revision: (previous?.revision ?? 0) + 1,
  };

  sessions.set(storeKey, session);

  if (session.status === "qr_ready" && plugin.gateway.loginWithQrWait) {
    void runBackgroundWait({
      session: { ...session },
      plugin,
      context: params.context,
    });
  }

  return toPayload(session);
}

export async function startChannelLoginSession(
  params: ChannelLoginStartInput,
): Promise<ChannelLoginSessionPayload> {
  return await beginChannelLoginSession({
    ...params,
    force: Boolean(params.force),
  });
}

export async function refreshChannelLoginSession(
  params: Omit<ChannelLoginStartInput, "force">,
): Promise<ChannelLoginSessionPayload> {
  return await beginChannelLoginSession({
    ...params,
    force: true,
  });
}

export function getChannelLoginSessionStatus(
  params: ChannelLoginStatusInput,
): ChannelLoginSessionPayload {
  purgeStaleSessions();

  const resolved = resolveChannelLoginPlugin(params.channel);
  if (!resolved) {
    throw new Error(`Unsupported channel: ${params.channel}`);
  }

  const { channelId, plugin } = resolved;
  const normalizedLoginKey = resolveLoginKey(params.loginKey);
  const storeKey = resolveStoreKey(channelId, normalizedLoginKey);
  const session = getActiveSession(storeKey);
  if (session) {
    return toPayload(session);
  }

  if (plugin) {
    const persisted = resolvePersistedConnectedPayload({
      channelId,
      loginKey: normalizedLoginKey,
      accountId: params.accountId,
      plugin,
    });
    if (persisted) {
      return persisted;
    }
  }

  return {
    channel: channelId,
    loginKey: normalizedLoginKey,
    status: "missing",
    connected: false,
    message: "No active channel login session.",
  };
}
