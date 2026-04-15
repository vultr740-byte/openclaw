import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockServerResponse } from "./helpers/plugins/mock-http-response.js";
import { createTestPluginApi } from "./helpers/plugins/plugin-api.ts";

const hoisted = vi.hoisted(() => ({
  getWeixinLoginStatusMock: vi.fn(),
  persistConfirmedWeixinLoginMock: vi.fn(),
  pollWeixinLoginStatusMock: vi.fn(),
  resolveWeixinBaseUrlMock: vi.fn(),
  startWeixinLoginWithQrMock: vi.fn(),
}));

vi.mock("../vendor/openclaw-weixin/src/auth/login-qr.js", () => ({
  DEFAULT_ILINK_BOT_TYPE: "3",
  getWeixinLoginStatus: hoisted.getWeixinLoginStatusMock,
  pollWeixinLoginStatus: hoisted.pollWeixinLoginStatusMock,
  startWeixinLoginWithQr: hoisted.startWeixinLoginWithQrMock,
}));

vi.mock("../vendor/openclaw-weixin/src/bridge.js", () => ({
  persistConfirmedWeixinLogin: hoisted.persistConfirmedWeixinLoginMock,
  resolveWeixinBaseUrl: hoisted.resolveWeixinBaseUrlMock,
}));

import { registerWeixinHttpLoginRoutes } from "../vendor/openclaw-weixin/src/http-login.js";

type RegisteredRoute = {
  path: string;
  handler: (
    req: IncomingMessage,
    res: ReturnType<typeof createMockServerResponse>,
  ) => Promise<boolean>;
};

type MockIncomingMessage = IncomingMessage & {
  destroyed?: boolean;
  destroy: () => MockIncomingMessage;
  socket: { remoteAddress: string };
};

function createJsonRequest(params: {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
}): MockIncomingMessage {
  const chunks =
    params.body === undefined ? [] : [Buffer.from(JSON.stringify(params.body), "utf8")];

  return {
    method: params.method,
    url: params.path,
    headers: params.body === undefined ? {} : { "content-type": "application/json" },
    socket: { remoteAddress: "127.0.0.1" },
    destroyed: false,
    destroy() {
      this.destroyed = true;
      return this;
    },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  } as MockIncomingMessage;
}

function parseJsonBody(res: { body?: string | Buffer | null }) {
  return JSON.parse(String(res.body ?? ""));
}

function registerRoutes() {
  const routes: RegisteredRoute[] = [];

  registerWeixinHttpLoginRoutes(
    createTestPluginApi({
      registerHttpRoute(route) {
        routes.push(route as RegisteredRoute);
      },
    }),
  );

  return {
    start: routes.find((route) => route.path === "/api/weixin/login/start"),
    status: routes.find((route) => route.path === "/api/weixin/login/status"),
  };
}

describe("registerWeixinHttpLoginRoutes", () => {
  beforeEach(() => {
    hoisted.resolveWeixinBaseUrlMock.mockReturnValue("https://ilinkai.weixin.qq.com");
    hoisted.startWeixinLoginWithQrMock.mockReset();
    hoisted.getWeixinLoginStatusMock.mockReset();
    hoisted.pollWeixinLoginStatusMock.mockReset();
    hoisted.persistConfirmedWeixinLoginMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns explicit qr_ready status for /start and persists login in the background", async () => {
    hoisted.startWeixinLoginWithQrMock.mockResolvedValue({
      message: "使用微信扫描以下二维码，以完成连接。",
      qrcodeUrl: "https://liteapp.weixin.qq.com/q/demo",
      sessionKey: "session-1",
    });
    hoisted.getWeixinLoginStatusMock.mockReturnValue({
      status: "qr_ready",
      connected: false,
      message: "使用微信扫描以下二维码，以完成连接。",
      sessionKey: "session-1",
      qrcodeUrl: "https://liteapp.weixin.qq.com/q/demo",
      expiresAt: 111,
      ttlMs: 222,
    });
    hoisted.pollWeixinLoginStatusMock.mockResolvedValue({
      status: "connected",
      connected: true,
      message: "✅ 与微信连接成功！",
      sessionKey: "session-1",
      botToken: "bot-token",
      accountId: "bot-id",
      baseUrl: "https://ilinkai.weixin.qq.com",
      userId: "user-1",
    });

    const { start } = registerRoutes();
    const req = createJsonRequest({
      method: "POST",
      path: "/api/weixin/login/start",
      body: {},
    });
    const res = createMockServerResponse();

    await start?.handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(parseJsonBody(res)).toMatchObject({
      status: "qr_ready",
      connected: false,
      session_key: "session-1",
      qr_url: "https://liteapp.weixin.qq.com/q/demo",
      expires_at: 111,
      ttl_ms: 222,
    });

    await vi.waitFor(() => {
      expect(hoisted.pollWeixinLoginStatusMock).toHaveBeenCalledWith({
        sessionKey: "session-1",
        timeoutMs: 1500,
      });
      expect(hoisted.persistConfirmedWeixinLoginMock).toHaveBeenCalledWith(
        expect.objectContaining({
          connected: true,
          accountId: "bot-id",
        }),
      );
    });
  });

  it("returns explicit error status for /start when QR creation fails", async () => {
    hoisted.startWeixinLoginWithQrMock.mockResolvedValue({
      message: "Failed to start login: upstream failed",
      sessionKey: "session-2",
    });
    hoisted.getWeixinLoginStatusMock.mockReturnValue({
      status: "missing",
      connected: false,
      message: "当前没有进行中的登录，请先发起登录。",
      sessionKey: "session-2",
    });

    const { start } = registerRoutes();
    const req = createJsonRequest({
      method: "POST",
      path: "/api/weixin/login/start",
      body: {},
    });
    const res = createMockServerResponse();

    await start?.handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(parseJsonBody(res)).toMatchObject({
      status: "error",
      connected: false,
      message: "Failed to start login: upstream failed",
      session_key: "session-2",
    });
    expect(hoisted.pollWeixinLoginStatusMock).not.toHaveBeenCalled();
    expect(hoisted.persistConfirmedWeixinLoginMock).not.toHaveBeenCalled();
  });

  it("honors timeout_ms when polling /status", async () => {
    hoisted.pollWeixinLoginStatusMock.mockResolvedValue({
      status: "qr_ready",
      connected: false,
      message: "使用微信扫描以下二维码，以完成连接。",
      sessionKey: "session-3",
      qrcodeUrl: "https://liteapp.weixin.qq.com/q/demo",
      expiresAt: 100,
      ttlMs: 200,
    });

    const { status } = registerRoutes();
    const req = createJsonRequest({
      method: "GET",
      path: "/api/weixin/login/status?session_key=session-3&timeout_ms=5000",
    });
    const res = createMockServerResponse();

    await status?.handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(hoisted.pollWeixinLoginStatusMock).toHaveBeenCalledWith({
      sessionKey: "session-3",
      timeoutMs: 5000,
    });
  });
});
