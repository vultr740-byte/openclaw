import { isDeepStrictEqual } from "node:util";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import {
  readConfigFileSnapshotForWrite,
  writeConfigFile,
  type OpenClawConfig,
} from "../../config/config.js";
import { formatConfigIssueLines } from "../../config/issue-format.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { clearPluginDiscoveryCache } from "../../plugins/discovery.js";
import { enablePluginInConfig } from "../../plugins/enable.js";
import { installPluginFromNpmSpec } from "../../plugins/install.js";
import { buildNpmResolutionInstallFields, recordPluginInstall } from "../../plugins/installs.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import { createPluginLoaderLogger } from "../../plugins/logger.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import {
  listBootstrapChannelEntries,
  resolveBootstrapChannelEntry,
  type BootstrapChannelEntry,
} from "./bootstrap-registry.js";

export type ChannelsBootstrapOptions = {
  channels?: string;
};

function parseBootstrapChannelIds(raw: string | undefined): string[] {
  if (!raw?.trim()) {
    return [];
  }
  return Array.from(
    new Set(
      raw
        .split(/[,\n;]+/g)
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

function formatSupportedBootstrapChannels(): string {
  return listBootstrapChannelEntries()
    .map((entry) => entry.publicId)
    .toSorted((a, b) => a.localeCompare(b))
    .join(", ");
}

function exitWithConfigIssues(params: {
  runtime: RuntimeEnv;
  issues: ReadonlyArray<{ path?: string | null; message: string }>;
}): null {
  const issues =
    params.issues.length > 0
      ? formatConfigIssueLines(params.issues, "-").join("\n")
      : "Unknown validation issue.";
  params.runtime.error(`Config invalid:\n${issues}`);
  params.runtime.error("Fix the config before bootstrapping channels.");
  params.runtime.exit(1);
  return null;
}

function resolveBootstrapWorkspaceDir(cfg: OpenClawConfig): string | undefined {
  return resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
}

function reloadBootstrapPluginRegistry(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
}): void {
  clearPluginDiscoveryCache();
  const log = createSubsystemLogger("plugins");
  loadOpenClawPlugins({
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    cache: false,
    logger: createPluginLoaderLogger(log),
  });
}

function resolveLoadedBootstrapChannelPlugin(params: {
  cfg: OpenClawConfig;
  entry: BootstrapChannelEntry;
  workspaceDir?: string;
}): ChannelPlugin | undefined {
  reloadBootstrapPluginRegistry({
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
  });
  return getChannelPlugin(params.entry.channelId);
}

function requireEnabledPluginConfig(params: {
  cfg: OpenClawConfig;
  entry: BootstrapChannelEntry;
  runtime: RuntimeEnv;
}): OpenClawConfig | null {
  const result = enablePluginInConfig(params.cfg, params.entry.pluginId);
  if (result.enabled) {
    return result.config;
  }
  params.runtime.error(
    `Cannot enable plugin ${params.entry.pluginId} for bootstrap channel ${params.entry.publicId}: ${result.reason ?? "unknown reason"}`,
  );
  params.runtime.exit(1);
  return null;
}

function validateRequiredEnv(params: {
  entry: BootstrapChannelEntry;
  runtime: RuntimeEnv;
}): boolean {
  const missing = params.entry.requiredEnv.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    params.runtime.error(
      `Bootstrap channel ${params.entry.publicId} requires env: ${missing.join(", ")}`,
    );
    params.runtime.exit(1);
    return false;
  }
  return true;
}

function shouldEnsureBootstrapChannelPlugin(entry: BootstrapChannelEntry): boolean {
  return entry.ensurePlugin !== false;
}

async function ensureBootstrapChannelPlugin(params: {
  cfg: OpenClawConfig;
  entry: BootstrapChannelEntry;
  runtime: RuntimeEnv;
  workspaceDir?: string;
}): Promise<{ cfg: OpenClawConfig; plugin: ChannelPlugin } | null> {
  let next = params.cfg;
  const { entry, runtime, workspaceDir } = params;

  let plugin = resolveLoadedBootstrapChannelPlugin({
    cfg: next,
    entry,
    workspaceDir,
  });
  if (plugin) {
    return { cfg: next, plugin };
  }

  const enabledConfig = requireEnabledPluginConfig({ cfg: next, entry, runtime });
  if (!enabledConfig) {
    return null;
  }
  next = enabledConfig;
  plugin = resolveLoadedBootstrapChannelPlugin({
    cfg: next,
    entry,
    workspaceDir,
  });
  if (plugin) {
    return { cfg: next, plugin };
  }

  if (!entry.npmSpec) {
    runtime.error(
      `Bootstrap channel ${entry.publicId} could not find built-in channel ${entry.channelId}.`,
    );
    runtime.exit(1);
    return null;
  }

  const installResult = await installPluginFromNpmSpec({
    spec: entry.npmSpec,
    expectedPluginId: entry.pluginId,
    logger: {
      info: (message) => runtime.log(message),
      warn: (message) => runtime.log(message),
    },
  });
  if (!installResult.ok) {
    runtime.error(`Failed to install ${entry.npmSpec}: ${installResult.error}`);
    runtime.exit(1);
    return null;
  }

  const installedEnabledConfig = requireEnabledPluginConfig({ cfg: next, entry, runtime });
  if (!installedEnabledConfig) {
    return null;
  }
  next = installedEnabledConfig;
  next = recordPluginInstall(next, {
    pluginId: installResult.pluginId,
    source: "npm",
    spec: entry.npmSpec,
    installPath: installResult.targetDir,
    version: installResult.version,
    ...buildNpmResolutionInstallFields(installResult.npmResolution),
  });

  plugin = resolveLoadedBootstrapChannelPlugin({
    cfg: next,
    entry,
    workspaceDir,
  });
  if (!plugin) {
    runtime.error(
      `Installed plugin ${entry.pluginId}, but channel ${entry.channelId} was not registered.`,
    );
    runtime.exit(1);
    return null;
  }

  return { cfg: next, plugin };
}

export async function channelsBootstrapCommand(
  opts: ChannelsBootstrapOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const channelIds = parseBootstrapChannelIds(opts.channels);
  if (channelIds.length === 0) {
    runtime.error("Bootstrap requires --channels <list>.");
    runtime.exit(1);
    return;
  }

  const entries: BootstrapChannelEntry[] = [];
  for (const channelId of channelIds) {
    const entry = resolveBootstrapChannelEntry(channelId);
    if (entry) {
      entries.push(entry);
      continue;
    }
    runtime.error(
      `Unsupported bootstrap channel: ${channelId}. Supported: ${formatSupportedBootstrapChannels()}`,
    );
    runtime.exit(1);
    return;
  }

  for (const entry of entries) {
    if (!validateRequiredEnv({ entry, runtime })) {
      return;
    }
  }

  const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
  if (snapshot.exists && !snapshot.valid) {
    exitWithConfigIssues({ runtime, issues: snapshot.issues });
    return;
  }

  let nextConfig = snapshot.config;
  for (const entry of entries) {
    if (shouldEnsureBootstrapChannelPlugin(entry)) {
      const workspaceDir = resolveBootstrapWorkspaceDir(nextConfig);
      const ensured = await ensureBootstrapChannelPlugin({
        cfg: nextConfig,
        entry,
        runtime,
        workspaceDir,
      });
      if (!ensured) {
        return;
      }
      nextConfig = entry.applyConfig({
        cfg: ensured.cfg,
        env: process.env,
        plugin: ensured.plugin,
      });
    } else {
      nextConfig = entry.applyConfig({
        cfg: nextConfig,
        env: process.env,
      });
    }
    runtime.log(`Bootstrapped channel ${entry.publicId} (${entry.channelId}).`);
  }

  if (isDeepStrictEqual(nextConfig, snapshot.config)) {
    runtime.log("Bootstrap config already up to date.");
    return;
  }

  await writeConfigFile(nextConfig, writeOptions);
}
