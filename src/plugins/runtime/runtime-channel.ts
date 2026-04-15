import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  setChannelConversationBindingIdleTimeoutBySessionKey,
  setChannelConversationBindingMaxAgeBySessionKey,
} from "../../channels/plugins/conversation-bindings.js";
import { loadChannelOutboundAdapter } from "../../channels/plugins/outbound/load.js";
import { createSubsystemLogger } from "../../logging.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { buildPluginLoaderJitiOptions, resolvePluginLoaderJitiConfig } from "../sdk-alias.js";
import { resolveRuntimeModuleCandidates } from "./runtime-module-paths.js";
import type {
  PluginRuntimeChannelContextEvent,
  PluginRuntimeChannelContextKey,
} from "./types-channel.js";
import type { PluginRuntime } from "./types.js";

let sectionLoader: ReturnType<typeof import("jiti").createJiti> | null | undefined;
const sectionFactoryCache = new Map<string, unknown>();

type StoredRuntimeContext = {
  token: symbol;
  context: unknown;
  normalizedKey: {
    channelId: string;
    accountId?: string;
    capability: string;
  };
};

const log = createSubsystemLogger("plugins/runtime-channel");

function getSectionLoader(): ReturnType<typeof import("jiti").createJiti> {
  if (sectionLoader) {
    return sectionLoader;
  }
  const require = createRequire(import.meta.url);
  const { createJiti } = require("jiti") as typeof import("jiti");
  const { tryNative, aliasMap } = resolvePluginLoaderJitiConfig({
    modulePath: fileURLToPath(import.meta.url),
    argv1: process.argv[1],
    moduleUrl: import.meta.url,
  });
  sectionLoader = createJiti(import.meta.url, {
    ...buildPluginLoaderJitiOptions(aliasMap),
    tryNative,
  });
  return sectionLoader;
}

function loadSectionFactory<T>(params: {
  cacheKey: string;
  exportName: string;
  candidates: string[];
}): T {
  const cached = sectionFactoryCache.get(params.cacheKey);
  if (cached !== undefined) {
    return cached as T;
  }

  const loader = getSectionLoader();
  for (const candidate of resolveRuntimeModuleCandidates(import.meta.url, params.candidates)) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    const mod = loader(candidate) as Record<string, unknown>;
    const value = mod[params.exportName];
    if (typeof value === "function") {
      sectionFactoryCache.set(params.cacheKey, value);
      return value as T;
    }
  }

  throw new Error(
    `Plugin runtime channel section "${params.cacheKey}" could not be loaded (${params.exportName}).`,
  );
}

function normalizeRuntimeContextString(value: string | null | undefined): string {
  return normalizeOptionalString(value) ?? "";
}

function normalizeRuntimeContextKey(params: PluginRuntimeChannelContextKey): {
  mapKey: string;
  normalizedKey: {
    channelId: string;
    accountId?: string;
    capability: string;
  };
} | null {
  const channelId = normalizeRuntimeContextString(params.channelId);
  const capability = normalizeRuntimeContextString(params.capability);
  const accountId = normalizeRuntimeContextString(params.accountId);
  if (!channelId || !capability) {
    return null;
  }
  return {
    mapKey: `${channelId}\u0000${accountId}\u0000${capability}`,
    normalizedKey: {
      channelId,
      capability,
      ...(accountId ? { accountId } : {}),
    },
  };
}

function doesRuntimeContextWatcherMatch(params: {
  watcher: {
    channelId?: string;
    accountId?: string;
    capability?: string;
  };
  event: PluginRuntimeChannelContextEvent;
}): boolean {
  if (params.watcher.channelId && params.watcher.channelId !== params.event.key.channelId) {
    return false;
  }
  if (
    params.watcher.accountId !== undefined &&
    params.watcher.accountId !== (params.event.key.accountId ?? "")
  ) {
    return false;
  }
  if (params.watcher.capability && params.watcher.capability !== params.event.key.capability) {
    return false;
  }
  return true;
}

export function createRuntimeChannel(): PluginRuntime["channel"] {
  let coreSections: import("./runtime-channel-core.js").RuntimeChannelCoreSections | undefined;
  let discordRuntime: PluginRuntime["channel"]["discord"] | undefined;
  let slackRuntime: PluginRuntime["channel"]["slack"] | undefined;
  let telegramRuntime: PluginRuntime["channel"]["telegram"] | undefined;
  let signalRuntime: PluginRuntime["channel"]["signal"] | undefined;
  let imessageRuntime: PluginRuntime["channel"]["imessage"] | undefined;
  let whatsappRuntime: PluginRuntime["channel"]["whatsapp"] | undefined;
  let lineRuntime: PluginRuntime["channel"]["line"] | undefined;

  const runtimeContexts = new Map<string, StoredRuntimeContext>();
  const runtimeContextWatchers = new Set<{
    filter: {
      channelId?: string;
      accountId?: string;
      capability?: string;
    };
    onEvent: (event: PluginRuntimeChannelContextEvent) => void;
  }>();

  const getCoreSections = () =>
    (coreSections ??= loadSectionFactory<
      typeof import("./runtime-channel-core.js").createRuntimeChannelCoreSections
    >({
      cacheKey: "core",
      exportName: "createRuntimeChannelCoreSections",
      candidates: ["runtime-channel-core.js", "runtime-channel-core.ts"],
    })());

  const emitRuntimeContextEvent = (event: PluginRuntimeChannelContextEvent) => {
    for (const watcher of runtimeContextWatchers) {
      if (!doesRuntimeContextWatcherMatch({ watcher: watcher.filter, event })) {
        continue;
      }
      try {
        watcher.onEvent(event);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(
          `runtime context watcher failed during ${event.type} ` +
            `channel=${event.key.channelId} capability=${event.key.capability}` +
            (event.key.accountId ? ` account=${event.key.accountId}` : "") +
            `: ${message}`,
        );
      }
    }
  };

  return {
    get text() {
      return getCoreSections().text;
    },
    get reply() {
      return getCoreSections().reply;
    },
    get routing() {
      return getCoreSections().routing;
    },
    get pairing() {
      return getCoreSections().pairing;
    },
    get media() {
      return getCoreSections().media;
    },
    get activity() {
      return getCoreSections().activity;
    },
    get session() {
      return getCoreSections().session;
    },
    get mentions() {
      return getCoreSections().mentions;
    },
    get reactions() {
      return getCoreSections().reactions;
    },
    get groups() {
      return getCoreSections().groups;
    },
    get debounce() {
      return getCoreSections().debounce;
    },
    get commands() {
      return getCoreSections().commands;
    },
    outbound: {
      loadAdapter: loadChannelOutboundAdapter,
    },
    threadBindings: {
      setIdleTimeoutBySessionKey: ({ channelId, targetSessionKey, accountId, idleTimeoutMs }) =>
        setChannelConversationBindingIdleTimeoutBySessionKey({
          channelId,
          targetSessionKey,
          accountId,
          idleTimeoutMs,
        }),
      setMaxAgeBySessionKey: ({ channelId, targetSessionKey, accountId, maxAgeMs }) =>
        setChannelConversationBindingMaxAgeBySessionKey({
          channelId,
          targetSessionKey,
          accountId,
          maxAgeMs,
        }),
    },
    runtimeContexts: {
      register: (params) => {
        const normalized = normalizeRuntimeContextKey(params);
        if (!normalized) {
          return { dispose: () => {} };
        }
        if (params.abortSignal?.aborted) {
          return { dispose: () => {} };
        }
        const token = Symbol(normalized.mapKey);
        let disposed = false;
        const dispose = () => {
          if (disposed) {
            return;
          }
          disposed = true;
          const current = runtimeContexts.get(normalized.mapKey);
          if (!current || current.token !== token) {
            return;
          }
          runtimeContexts.delete(normalized.mapKey);
          emitRuntimeContextEvent({
            type: "unregistered",
            key: normalized.normalizedKey,
          });
        };
        params.abortSignal?.addEventListener("abort", dispose, { once: true });
        if (params.abortSignal?.aborted) {
          dispose();
          return { dispose };
        }
        runtimeContexts.set(normalized.mapKey, {
          token,
          context: params.context,
          normalizedKey: normalized.normalizedKey,
        });
        if (disposed) {
          return { dispose };
        }
        emitRuntimeContextEvent({
          type: "registered",
          key: normalized.normalizedKey,
          context: params.context,
        });
        return { dispose };
      },
      get: <T = unknown>(params: PluginRuntimeChannelContextKey) => {
        const normalized = normalizeRuntimeContextKey(params);
        if (!normalized) {
          return undefined;
        }
        return runtimeContexts.get(normalized.mapKey)?.context as T | undefined;
      },
      watch: (params) => {
        const watcher = {
          filter: {
            ...(params.channelId?.trim() ? { channelId: params.channelId.trim() } : {}),
            ...(params.accountId != null ? { accountId: params.accountId.trim() } : {}),
            ...(params.capability?.trim() ? { capability: params.capability.trim() } : {}),
          },
          onEvent: params.onEvent,
        };
        runtimeContextWatchers.add(watcher);
        return () => {
          runtimeContextWatchers.delete(watcher);
        };
      },
    },
    get discord() {
      return (discordRuntime ??= loadSectionFactory<
        typeof import("./runtime-channel-discord.js").createRuntimeChannelDiscord
      >({
        cacheKey: "discord",
        exportName: "createRuntimeChannelDiscord",
        candidates: ["runtime-channel-discord.js", "runtime-channel-discord.ts"],
      })());
    },
    get slack() {
      return (slackRuntime ??= loadSectionFactory<
        typeof import("./runtime-channel-slack.js").createRuntimeChannelSlack
      >({
        cacheKey: "slack",
        exportName: "createRuntimeChannelSlack",
        candidates: ["runtime-channel-slack.js", "runtime-channel-slack.ts"],
      })());
    },
    get telegram() {
      return (telegramRuntime ??= loadSectionFactory<
        typeof import("./runtime-channel-telegram.js").createRuntimeChannelTelegram
      >({
        cacheKey: "telegram",
        exportName: "createRuntimeChannelTelegram",
        candidates: ["runtime-channel-telegram.js", "runtime-channel-telegram.ts"],
      })());
    },
    get signal() {
      return (signalRuntime ??= loadSectionFactory<
        typeof import("./runtime-channel-signal.js").createRuntimeChannelSignal
      >({
        cacheKey: "signal",
        exportName: "createRuntimeChannelSignal",
        candidates: ["runtime-channel-signal.js", "runtime-channel-signal.ts"],
      })());
    },
    get imessage() {
      return (imessageRuntime ??= loadSectionFactory<
        typeof import("./runtime-channel-imessage.js").createRuntimeChannelIMessage
      >({
        cacheKey: "imessage",
        exportName: "createRuntimeChannelIMessage",
        candidates: ["runtime-channel-imessage.js", "runtime-channel-imessage.ts"],
      })());
    },
    get whatsapp() {
      return (whatsappRuntime ??= loadSectionFactory<
        typeof import("./runtime-whatsapp.js").createRuntimeWhatsApp
      >({
        cacheKey: "whatsapp",
        exportName: "createRuntimeWhatsApp",
        candidates: ["runtime-whatsapp.js", "runtime-whatsapp.ts"],
      })());
    },
    get line() {
      return (lineRuntime ??= loadSectionFactory<
        typeof import("./runtime-channel-line.js").createRuntimeChannelLine
      >({
        cacheKey: "line",
        exportName: "createRuntimeChannelLine",
        candidates: ["runtime-channel-line.js", "runtime-channel-line.ts"],
      })());
    },
  } satisfies PluginRuntime["channel"];
}
