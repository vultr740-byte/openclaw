import type { IncomingMessage, ServerResponse } from "node:http";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

import {
  DEFAULT_ILINK_BOT_TYPE,
  getWeixinLoginStatus,
  pollWeixinLoginStatus,
  startWeixinLoginWithQr,
  type WeixinQrLoginStatus,
} from "./auth/login-qr.js";
import { persistConfirmedWeixinLogin, resolveWeixinBaseUrl } from "./bridge.js";
import { logger } from "./util/logger.js";

type LoginRouteResponse = {
  status: WeixinQrLoginStatus;
  connected: boolean;
  message: string;
  qr_url?: string;
  session_key?: string;
  expires_at?: number;
  ttl_ms?: number;
};

const HTTP_STATUS_TIMEOUT_MS = 1_500;
const HTTP_STATUS_TIMEOUT_MIN_MS = 250;
const HTTP_STATUS_TIMEOUT_MAX_MS = 35_000;
const BACKGROUND_CONFIRM_POLL_INTERVAL_MS = 1_000;
const BACKGROUND_CONFIRM_TIMEOUT_MS = 90_000;
const backgroundConfirmers = new Map<string, Promise<void>>();

function getSearchParam(req: IncomingMessage, key: string): string | undefined {
  const url = new URL(req.url ?? "/", "http://localhost");
  const value = url.searchParams.get(key)?.trim();
  return value ? value : undefined;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function writeJson(
  res: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
): true {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
  return true;
}

function buildLoginRouteResponse(result: {
  status: WeixinQrLoginStatus;
  connected: boolean;
  message: string;
  qrcodeUrl?: string;
  sessionKey?: string;
  expiresAt?: number;
  ttlMs?: number;
}): LoginRouteResponse {
  return {
    status: result.status,
    connected: result.connected,
    message: result.message,
    ...(result.qrcodeUrl ? { qr_url: result.qrcodeUrl } : {}),
    ...(result.sessionKey ? { session_key: result.sessionKey } : {}),
    ...(typeof result.expiresAt === "number" ? { expires_at: result.expiresAt } : {}),
    ...(typeof result.ttlMs === "number" ? { ttl_ms: result.ttlMs } : {}),
  };
}

function buildStartResponse(result: {
  message: string;
  qrcodeUrl?: string;
  sessionKey: string;
}): LoginRouteResponse {
  const snapshot = getWeixinLoginStatus({ sessionKey: result.sessionKey });
  const hasQr = Boolean(result.qrcodeUrl);

  return buildLoginRouteResponse({
    status: hasQr ? snapshot.status : "error",
    connected: false,
    message: result.message,
    qrcodeUrl: result.qrcodeUrl,
    sessionKey: result.sessionKey,
    expiresAt: snapshot.expiresAt,
    ttlMs: snapshot.ttlMs,
  });
}

function parseRequestedTimeoutMs(req: IncomingMessage): number {
  const raw = getSearchParam(req, "timeout_ms");
  if (!raw) {
    return HTTP_STATUS_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return HTTP_STATUS_TIMEOUT_MS;
  }
  return Math.min(
    HTTP_STATUS_TIMEOUT_MAX_MS,
    Math.max(HTTP_STATUS_TIMEOUT_MIN_MS, Math.floor(parsed)),
  );
}

async function runBackgroundLoginConfirmer(sessionKey: string): Promise<void> {
  const deadline = Date.now() + BACKGROUND_CONFIRM_TIMEOUT_MS;

  try {
    while (Date.now() < deadline) {
      const polled = await pollWeixinLoginStatus({
        sessionKey,
        timeoutMs: HTTP_STATUS_TIMEOUT_MS,
      });

      if (polled.connected) {
        await persistConfirmedWeixinLogin(polled);
        logger.info(`weixin background confirmer persisted login sessionKey=${sessionKey}`);
        return;
      }

      if (polled.status === "expired" || polled.status === "error" || polled.status === "missing") {
        logger.info(
          `weixin background confirmer stopped sessionKey=${sessionKey} status=${polled.status}`,
        );
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, BACKGROUND_CONFIRM_POLL_INTERVAL_MS));
    }

    logger.info(`weixin background confirmer timed out sessionKey=${sessionKey}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`weixin background confirmer failed sessionKey=${sessionKey}: ${message}`);
  } finally {
    backgroundConfirmers.delete(sessionKey);
  }
}

function ensureBackgroundLoginConfirmer(sessionKey: string): void {
  if (backgroundConfirmers.has(sessionKey)) {
    return;
  }

  const runner = runBackgroundLoginConfirmer(sessionKey);
  backgroundConfirmers.set(sessionKey, runner);
}

export function registerWeixinHttpLoginRoutes(api: OpenClawPluginApi): void {
  api.registerHttpRoute({
    path: "/api/weixin/login/start",
    auth: "gateway",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.setHeader("Allow", "POST");
        res.end("Method Not Allowed");
        return true;
      }

      try {
        const body = await readJsonBody(req);
        const force = body.force === true;
        const sessionKey =
          (typeof body.session_key === "string" && body.session_key.trim()) ||
          (typeof body.sessionKey === "string" && body.sessionKey.trim()) ||
          undefined;
        const accountId =
          (typeof body.account_id === "string" && body.account_id.trim()) ||
          (typeof body.accountId === "string" && body.accountId.trim()) ||
          undefined;

        const started = await startWeixinLoginWithQr({
          accountId,
          sessionKey,
          force,
          apiBaseUrl: resolveWeixinBaseUrl(accountId),
          botType: DEFAULT_ILINK_BOT_TYPE,
        });

        if (started.qrcodeUrl) {
          ensureBackgroundLoginConfirmer(started.sessionKey);
        }

        return writeJson(res, 200, buildStartResponse(started));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`weixin login start bridge failed: ${message}`);
        return writeJson(res, 500, { error: message });
      }
    },
  });

  api.registerHttpRoute({
    path: "/api/weixin/login/status",
    auth: "gateway",
    handler: async (req, res) => {
      if (req.method !== "GET") {
        res.statusCode = 405;
        res.setHeader("Allow", "GET");
        res.end("Method Not Allowed");
        return true;
      }

      try {
        const sessionKey = getSearchParam(req, "session_key");
        if (!sessionKey) {
          return writeJson(res, 400, {
            error: "session_key is required.",
          });
        }

        const polled = await pollWeixinLoginStatus({
          sessionKey,
          timeoutMs: parseRequestedTimeoutMs(req),
        });
        if (polled.connected) {
          await persistConfirmedWeixinLogin(polled);
        }

        return writeJson(res, 200, buildLoginRouteResponse(polled));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`weixin login status bridge failed: ${message}`);
        return writeJson(res, 500, { error: message });
      }
    },
  });
}
