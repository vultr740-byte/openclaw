import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { ChannelLoginWithQrWaitResult, ChannelPlugin } from "../channels/plugins/types.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { setRegistry } from "./server.agent.gateway-server-agent.mocks.js";
import { createRegistry } from "./server.e2e-registry-helpers.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let readConfigFileSnapshot: typeof import("../config/config.js").readConfigFileSnapshot;
let writeConfigFile: typeof import("../config/config.js").writeConfigFile;

installGatewayTestHooks({ scope: "suite" });

const createStubChannelPlugin = (params: {
  id: ChannelPlugin["id"];
  label: string;
  summary?: Record<string, unknown>;
  logoutCleared?: boolean;
}): ChannelPlugin => ({
  ...createChannelTestPluginBase({
    id: params.id,
    label: params.label,
    config: { isConfigured: async () => false },
  }),
  status: {
    buildChannelSummary: async () => ({
      configured: false,
      ...params.summary,
    }),
  },
  gateway: {
    logoutAccount: async () => ({
      cleared: params.logoutCleared ?? false,
      envToken: false,
    }),
  },
});

const createQrLoginTestPlugin = (params: {
  waiters: Array<ReturnType<typeof createDeferred<ChannelLoginWithQrWaitResult>>>;
  configuredAccountIds?: string[];
}) => {
  let startCount = 0;
  return {
    ...createChannelTestPluginBase({
      id: "openclaw-weixin",
      label: "Weixin",
      config: {
        listAccountIds: () => params.configuredAccountIds ?? [],
        resolveAccount: (_cfg, accountId) => ({ accountId }),
        isConfigured: () => (params.configuredAccountIds?.length ?? 0) > 0,
      },
    }),
    gateway: {
      loginWithQrStart: async () => {
        startCount += 1;
        return {
          qrDataUrl: `wx://qr-${startCount}`,
          message: `Scan QR ${startCount}`,
          sessionKey: `session-${startCount}`,
          ttlMs: 300_000,
        };
      },
      loginWithQrWait: async () => {
        const waiter = createDeferred<ChannelLoginWithQrWaitResult>();
        params.waiters.push(waiter);
        return await waiter.promise;
      },
    },
  } satisfies ChannelPlugin;
};

const telegramPlugin: ChannelPlugin = {
  ...createStubChannelPlugin({
    id: "telegram",
    label: "Telegram",
    summary: { tokenSource: "none", lastProbeAt: null },
    logoutCleared: true,
  }),
  gateway: {
    logoutAccount: async ({ cfg }) => {
      const nextTelegram = cfg.channels?.telegram ? { ...cfg.channels.telegram } : {};
      delete nextTelegram.botToken;
      await writeConfigFile({
        ...cfg,
        channels: {
          ...cfg.channels,
          telegram: nextTelegram,
        },
      });
      return { cleared: true, envToken: false, loggedOut: true };
    },
  },
};

const defaultRegistry = createRegistry([
  {
    pluginId: "whatsapp",
    source: "test",
    plugin: createStubChannelPlugin({ id: "whatsapp", label: "WhatsApp" }),
  },
  {
    pluginId: "telegram",
    source: "test",
    plugin: telegramPlugin,
  },
  {
    pluginId: "signal",
    source: "test",
    plugin: createStubChannelPlugin({
      id: "signal",
      label: "Signal",
      summary: { lastProbeAt: null },
    }),
  },
]);

let server: Awaited<ReturnType<typeof startServerWithClient>>["server"];
let ws: Awaited<ReturnType<typeof startServerWithClient>>["ws"];

beforeAll(async () => {
  ({ readConfigFileSnapshot, writeConfigFile } = await import("../config/config.js"));
  setRegistry(defaultRegistry);
  const started = await startServerWithClient();
  server = started.server;
  ws = started.ws;
  await connectOk(ws);
});

afterAll(async () => {
  ws.close();
  await server.close();
});

describe("gateway server channels", () => {
  test("channels.status returns snapshot without probe", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", undefined);
    setRegistry(defaultRegistry);
    const res = await rpcReq<{
      channels?: Record<
        string,
        {
          configured?: boolean;
          tokenSource?: string;
          probe?: unknown;
          lastProbeAt?: unknown;
          linked?: boolean;
        }
      >;
    }>(ws, "channels.status", { probe: false, timeoutMs: 2000 });
    expect(res.ok).toBe(true);
    const telegram = res.payload?.channels?.telegram;
    const signal = res.payload?.channels?.signal;
    expect(res.payload?.channels?.whatsapp).toBeTruthy();
    expect(telegram?.configured).toBe(false);
    expect(telegram?.tokenSource).toBe("none");
    expect(telegram?.probe).toBeUndefined();
    expect(telegram?.lastProbeAt).toBeNull();
    expect(signal?.configured).toBe(false);
    expect(signal?.probe).toBeUndefined();
    expect(signal?.lastProbeAt).toBeNull();
  });

  test("channels.logout reports no session when missing", async () => {
    setRegistry(defaultRegistry);
    const res = await rpcReq<{ cleared?: boolean; channel?: string }>(ws, "channels.logout", {
      channel: "whatsapp",
    });
    expect(res.ok).toBe(true);
    expect(res.payload?.channel).toBe("whatsapp");
    expect(res.payload?.cleared).toBe(false);
  });

  test("channels.logout clears telegram bot token from config", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", undefined);
    setRegistry(defaultRegistry);
    await writeConfigFile({
      channels: {
        telegram: {
          botToken: "123:abc",
          groups: { "*": { requireMention: false } },
        },
      },
    });
    const res = await rpcReq<{
      cleared?: boolean;
      envToken?: boolean;
      channel?: string;
    }>(ws, "channels.logout", { channel: "telegram" });
    expect(res.ok).toBe(true);
    expect(res.payload?.channel).toBe("telegram");
    expect(res.payload?.cleared).toBe(true);
    expect(res.payload?.envToken).toBe(false);

    const snap = await readConfigFileSnapshot();
    expect(snap.valid).toBe(true);
    expect(snap.config?.channels?.telegram?.botToken).toBeUndefined();
    expect(snap.config?.channels?.telegram?.groups?.["*"]?.requireMention).toBe(false);
  });

  test("channels.login.start returns qr_ready and transitions to connected", async () => {
    const waiters: Array<ReturnType<typeof createDeferred<ChannelLoginWithQrWaitResult>>> = [];
    setRegistry(
      createRegistry([
        ...defaultRegistry.channels,
        {
          pluginId: "openclaw-weixin",
          source: "test",
          plugin: createQrLoginTestPlugin({ waiters }),
        },
      ]),
    );

    const started = await rpcReq<{
      channel?: string;
      status?: string;
      loginKey?: string;
      qr?: { kind?: string; value?: string };
      sessionKey?: string;
    }>(ws, "channels.login.start", {
      channel: "weixin",
    });
    expect(started.ok).toBe(true);
    expect(started.payload?.channel).toBe("openclaw-weixin");
    expect(started.payload?.loginKey).toBe("default");
    expect(started.payload?.status).toBe("qr_ready");
    expect(started.payload?.qr).toEqual({ kind: "text", value: "wx://qr-1" });
    expect(started.payload?.sessionKey).toBe("session-1");

    const pending = await rpcReq<{ status?: string }>(ws, "channels.login.status", {
      channel: "weixin",
    });
    expect(pending.ok).toBe(true);
    expect(pending.payload?.status).toBe("qr_ready");

    expect(waiters).toHaveLength(1);
    waiters[0].resolve({
      connected: true,
      message: "Connected",
      accountId: "bot-1@im.bot",
    });

    await vi.waitFor(async () => {
      const connected = await rpcReq<{
        status?: string;
        connected?: boolean;
        accountId?: string;
      }>(ws, "channels.login.status", {
        channel: "weixin",
      });
      expect(connected.ok).toBe(true);
      expect(connected.payload?.status).toBe("connected");
      expect(connected.payload?.connected).toBe(true);
      expect(connected.payload?.accountId).toBe("bot-1@im.bot");
    });
  });

  test("channels.login.refresh starts a fresh login attempt", async () => {
    const waiters: Array<ReturnType<typeof createDeferred<ChannelLoginWithQrWaitResult>>> = [];
    setRegistry(
      createRegistry([
        ...defaultRegistry.channels,
        {
          pluginId: "openclaw-weixin",
          source: "test",
          plugin: createQrLoginTestPlugin({ waiters }),
        },
      ]),
    );

    const started = await rpcReq<{ sessionKey?: string; qr?: { value?: string } }>(
      ws,
      "channels.login.start",
      {
        channel: "weixin",
      },
    );
    expect(started.ok).toBe(true);
    expect(started.payload?.sessionKey).toBe("session-1");
    expect(started.payload?.qr?.value).toBe("wx://qr-1");

    const refreshed = await rpcReq<{ sessionKey?: string; qr?: { value?: string } }>(
      ws,
      "channels.login.refresh",
      {
        channel: "weixin",
      },
    );
    expect(refreshed.ok).toBe(true);
    expect(refreshed.payload?.sessionKey).toBe("session-2");
    expect(refreshed.payload?.qr?.value).toBe("wx://qr-2");
    expect(waiters).toHaveLength(2);
  });

  test("channels.login.status falls back to configured account state", async () => {
    setRegistry(
      createRegistry([
        ...defaultRegistry.channels,
        {
          pluginId: "openclaw-weixin",
          source: "test",
          plugin: createQrLoginTestPlugin({
            waiters: [],
            configuredAccountIds: ["bot-2@im.bot"],
          }),
        },
      ]),
    );

    const res = await rpcReq<{
      status?: string;
      connected?: boolean;
      accountId?: string;
    }>(ws, "channels.login.status", {
      channel: "weixin",
      loginKey: "configured-account",
    });
    expect(res.ok).toBe(true);
    expect(res.payload?.status).toBe("connected");
    expect(res.payload?.connected).toBe(true);
    expect(res.payload?.accountId).toBe("bot-2@im.bot");
  });
});
