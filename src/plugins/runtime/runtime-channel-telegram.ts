import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { buildPluginLoaderJitiOptions, resolvePluginLoaderJitiConfig } from "../sdk-alias.js";
import { resolveRuntimeModuleCandidates } from "./runtime-module-paths.js";
import type { PluginRuntime } from "./types.js";

let sectionLoader: ReturnType<typeof import("jiti").createJiti> | null | undefined;
const sectionFactoryCache = new Map<string, unknown>();

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
    `Plugin runtime telegram channel section "${params.cacheKey}" could not be loaded (${params.exportName}).`,
  );
}

export function createRuntimeChannelTelegram(): PluginRuntime["channel"]["telegram"] {
  let coreSection:
    | import("./runtime-channel-telegram-core.js").RuntimeChannelTelegramCoreSection
    | undefined;
  let sendSection:
    | import("./runtime-channel-telegram-send.js").RuntimeChannelTelegramSendSection
    | undefined;
  let auditSection:
    | import("./runtime-channel-telegram-audit.js").RuntimeChannelTelegramAuditSection
    | undefined;
  let actionsSection:
    | import("./runtime-channel-telegram-actions.js").RuntimeChannelTelegramActionsSection
    | undefined;

  const getCoreSection = () =>
    (coreSection ??= loadSectionFactory<
      typeof import("./runtime-channel-telegram-core.js").createRuntimeChannelTelegramCoreSection
    >({
      cacheKey: "telegram-core",
      exportName: "createRuntimeChannelTelegramCoreSection",
      candidates: ["runtime-channel-telegram-core.js", "runtime-channel-telegram-core.ts"],
    })());

  const getSendSection = () =>
    (sendSection ??= loadSectionFactory<
      typeof import("./runtime-channel-telegram-send.js").createRuntimeChannelTelegramSendSection
    >({
      cacheKey: "telegram-send",
      exportName: "createRuntimeChannelTelegramSendSection",
      candidates: ["runtime-channel-telegram-send.js", "runtime-channel-telegram-send.ts"],
    })());

  const getAuditSection = () =>
    (auditSection ??= loadSectionFactory<
      typeof import("./runtime-channel-telegram-audit.js").createRuntimeChannelTelegramAuditSection
    >({
      cacheKey: "telegram-audit",
      exportName: "createRuntimeChannelTelegramAuditSection",
      candidates: ["runtime-channel-telegram-audit.js", "runtime-channel-telegram-audit.ts"],
    })());

  const getActionsSection = () =>
    (actionsSection ??= loadSectionFactory<
      typeof import("./runtime-channel-telegram-actions.js").createRuntimeChannelTelegramActionsSection
    >({
      cacheKey: "telegram-actions",
      exportName: "createRuntimeChannelTelegramActionsSection",
      candidates: ["runtime-channel-telegram-actions.js", "runtime-channel-telegram-actions.ts"],
    })());

  return {
    get auditTelegramGroupMembership() {
      return getAuditSection().auditTelegramGroupMembership;
    },
    get collectTelegramUnmentionedGroupIds() {
      return getAuditSection().collectTelegramUnmentionedGroupIds;
    },
    get probeTelegram() {
      return getCoreSection().probeTelegram;
    },
    get resolveTelegramToken() {
      return getCoreSection().resolveTelegramToken;
    },
    get sendMessageTelegram() {
      return getSendSection().sendMessageTelegram;
    },
    get sendPollTelegram() {
      return getSendSection().sendPollTelegram;
    },
    get monitorTelegramProvider() {
      return getCoreSection().monitorTelegramProvider;
    },
    get messageActions() {
      return getActionsSection().messageActions;
    },
  };
}
