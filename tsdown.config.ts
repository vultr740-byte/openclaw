import fs from "node:fs";
import path from "node:path";
import { defineConfig, type UserConfig } from "tsdown";
import {
  listBundledPluginBuildEntries,
  listBundledPluginRuntimeDependencies,
} from "./scripts/lib/bundled-plugin-build-entries.mjs";
import { buildPluginSdkEntrySources } from "./scripts/lib/plugin-sdk-entries.mjs";

type InputOptionsFactory = Extract<NonNullable<UserConfig["inputOptions"]>, Function>;
type InputOptionsArg = InputOptionsFactory extends (
  options: infer Options,
  format: infer _Format,
  context: infer _Context,
) => infer _Return
  ? Options
  : never;
type InputOptionsReturn = InputOptionsFactory extends (
  options: infer _Options,
  format: infer _Format,
  context: infer _Context,
) => infer Return
  ? Return
  : never;
type OnLogFunction = InputOptionsArg extends { onLog?: infer OnLog } ? NonNullable<OnLog> : never;

const env = {
  NODE_ENV: "production",
};

const SUPPRESSED_EVAL_WARNING_PATHS = [
  "@protobufjs/inquire/index.js",
  "bottleneck/lib/IORedisConnection.js",
  "bottleneck/lib/RedisConnection.js",
] as const;

function buildInputOptions(options: InputOptionsArg): InputOptionsReturn {
  if (process.env.OPENCLAW_BUILD_VERBOSE === "1") {
    return undefined;
  }

  const previousOnLog = typeof options.onLog === "function" ? options.onLog : undefined;

  function isSuppressedLog(log: {
    code?: string;
    message?: string;
    id?: string;
    importer?: string;
  }) {
    if (log.code === "PLUGIN_TIMINGS") {
      return true;
    }
    if (log.code !== "EVAL") {
      return false;
    }
    const haystack = [log.message, log.id, log.importer].filter(Boolean).join("\n");
    return SUPPRESSED_EVAL_WARNING_PATHS.some((entry) => haystack.includes(entry));
  }

  return {
    ...options,
    onLog(...args: Parameters<OnLogFunction>) {
      const [level, log, defaultHandler] = args;
      if (isSuppressedLog(log)) {
        return;
      }
      if (typeof previousOnLog === "function") {
        previousOnLog(level, log, defaultHandler);
        return;
      }
      defaultHandler(level, log);
    },
  };
}

function nodeBuildConfig(config: UserConfig): UserConfig {
  return {
    ...config,
    env,
    fixedExtension: false,
    platform: "node",
    inputOptions: buildInputOptions,
  };
}

const bundledPluginBuildEntries = listBundledPluginBuildEntries();
const bundledPluginRuntimeDependencies = listBundledPluginRuntimeDependencies();

function buildBundledHookEntries(): Record<string, string> {
  const hooksRoot = path.join(process.cwd(), "src", "hooks", "bundled");
  const entries: Record<string, string> = {};

  if (!fs.existsSync(hooksRoot)) {
    return entries;
  }

  for (const dirent of fs.readdirSync(hooksRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }

    const hookName = dirent.name;
    const handlerPath = path.join(hooksRoot, hookName, "handler.ts");
    if (!fs.existsSync(handlerPath)) {
      continue;
    }

    entries[`bundled/${hookName}/handler`] = handlerPath;
  }

  return entries;
}

const bundledHookEntries = buildBundledHookEntries();
const bundledPluginRoot = (pluginId: string) => ["extensions", pluginId].join("/");
const bundledPluginFile = (pluginId: string, relativePath: string) =>
  `${bundledPluginRoot(pluginId)}/${relativePath}`;
const explicitNeverBundleDependencies = [
  "@lancedb/lancedb",
  "@matrix-org/matrix-sdk-crypto-nodejs",
  "matrix-js-sdk",
  ...bundledPluginRuntimeDependencies,
].toSorted((left, right) => left.localeCompare(right));

function shouldNeverBundleDependency(id: string): boolean {
  return explicitNeverBundleDependencies.some((dependency) => {
    return id === dependency || id.startsWith(`${dependency}/`);
  });
}

function buildCoreDistEntries(): Record<string, string> {
  return {
    index: "src/index.ts",
    entry: "src/entry.ts",
    "cli/daemon-cli": "src/cli/daemon-cli.ts",
    "agents/auth-profiles.runtime": "src/agents/auth-profiles.runtime.ts",
    "agents/model-catalog.runtime": "src/agents/model-catalog.runtime.ts",
    "agents/models-config.runtime": "src/agents/models-config.runtime.ts",
    "agents/pi-model-discovery-runtime": "src/agents/pi-model-discovery-runtime.ts",
    "commands/status.summary.runtime": "src/commands/status.summary.runtime.ts",
    "infra/boundary-file-read": "src/infra/boundary-file-read.ts",
    "plugins/provider-discovery.runtime": "src/plugins/provider-discovery.runtime.ts",
    "plugins/provider-runtime.runtime": "src/plugins/provider-runtime.runtime.ts",
    "plugins/public-surface-runtime": "src/plugins/public-surface-runtime.ts",
    "plugins/sdk-alias": "src/plugins/sdk-alias.ts",
    "facade-activation-check.runtime": "src/plugin-sdk/facade-activation-check.runtime.ts",
    extensionAPI: "src/extensionAPI.ts",
    "infra/warning-filter": "src/infra/warning-filter.ts",
    "telegram/audit": bundledPluginFile("telegram", "src/audit.ts"),
    "telegram/token": bundledPluginFile("telegram", "src/token.ts"),
    "plugins/build-smoke-entry": "src/plugins/build-smoke-entry.ts",
    "plugins/runtime/index": "src/plugins/runtime/index.ts",
    "plugins/runtime/runtime-module-paths": "src/plugins/runtime/runtime-module-paths.ts",
    "plugins/runtime/runtime-channel": "src/plugins/runtime/runtime-channel.ts",
    "plugins/runtime/runtime-channel-core": "src/plugins/runtime/runtime-channel-core.ts",
    "plugins/runtime/runtime-channel-discord": "src/plugins/runtime/runtime-channel-discord.ts",
    "plugins/runtime/runtime-channel-imessage": "src/plugins/runtime/runtime-channel-imessage.ts",
    "plugins/runtime/runtime-channel-line": "src/plugins/runtime/runtime-channel-line.ts",
    "plugins/runtime/runtime-channel-signal": "src/plugins/runtime/runtime-channel-signal.ts",
    "plugins/runtime/runtime-channel-slack": "src/plugins/runtime/runtime-channel-slack.ts",
    "plugins/runtime/runtime-channel-telegram": "src/plugins/runtime/runtime-channel-telegram.ts",
    "plugins/runtime/runtime-channel-telegram-actions":
      "src/plugins/runtime/runtime-channel-telegram-actions.ts",
    "plugins/runtime/runtime-channel-telegram-audit":
      "src/plugins/runtime/runtime-channel-telegram-audit.ts",
    "plugins/runtime/runtime-channel-telegram-core":
      "src/plugins/runtime/runtime-channel-telegram-core.ts",
    "plugins/runtime/runtime-channel-telegram-send":
      "src/plugins/runtime/runtime-channel-telegram-send.ts",
    "plugins/runtime/runtime-whatsapp": "src/plugins/runtime/runtime-whatsapp.ts",
    "llm-slug-generator": "src/hooks/llm-slug-generator.ts",
    "mcp/plugin-tools-serve": "src/mcp/plugin-tools-serve.ts",
    "channels/plugins/agent-tools/whatsapp-login":
      "src/channels/plugins/agent-tools/whatsapp-login.ts",
    "channels/plugins/actions/discord": "src/channels/plugins/actions/discord.ts",
    "channels/plugins/actions/signal": "src/channels/plugins/actions/signal.ts",
    "channels/plugins/actions/telegram": "src/channels/plugins/actions/telegram.ts",
    "line/accounts": "src/line/accounts.ts",
    "line/send": "src/line/send.ts",
    "line/template-messages": "src/line/template-messages.ts",
  };
}

const coreDistEntries = buildCoreDistEntries();

function buildUnifiedDistEntries(): Record<string, string> {
  return {
    ...coreDistEntries,
    "plugin-sdk/compat": "src/plugin-sdk/compat.ts",
    ...Object.fromEntries(
      Object.entries(buildPluginSdkEntrySources()).map(([entry, source]) => [
        `plugin-sdk/${entry}`,
        source,
      ]),
    ),
    ...bundledPluginBuildEntries,
    ...bundledHookEntries,
  };
}

export default defineConfig([
  nodeBuildConfig({
    entry: buildUnifiedDistEntries(),
    deps: {
      neverBundle: shouldNeverBundleDependency,
    },
  }),
]);
