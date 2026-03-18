import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { isRecord } from "../../utils.js";

type BootstrapChannelConfigContext = {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  plugin?: ChannelPlugin;
};

export type BootstrapChannelEntry = {
  publicId: string;
  aliases?: readonly string[];
  channelId: string;
  pluginId: string;
  npmSpec?: string;
  ensurePlugin?: boolean;
  requiredEnv: readonly string[];
  applyConfig: (params: BootstrapChannelConfigContext) => OpenClawConfig;
};

function envRef(name: string): string {
  return `\${${name}}`;
}

function resolveChannelSection(
  cfg: OpenClawConfig,
  channelId: string,
): Record<string, unknown> | undefined {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const section = channels?.[channelId];
  return isRecord(section) ? section : undefined;
}

const bootstrapChannelEntries: BootstrapChannelEntry[] = [
  {
    publicId: "discord",
    channelId: "discord",
    pluginId: "discord",
    ensurePlugin: false,
    requiredEnv: ["DISCORD_BOT_TOKEN"],
    applyConfig: ({ cfg }) => {
      const existing = resolveChannelSection(cfg, "discord");
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          discord: {
            ...existing,
            enabled: true,
            token: envRef("DISCORD_BOT_TOKEN"),
          },
        },
      };
    },
  },
  {
    publicId: "telegram",
    aliases: ["tg"],
    channelId: "telegram",
    pluginId: "telegram",
    ensurePlugin: false,
    requiredEnv: [],
    // Telegram is still bootstrapped by the existing entrypoint template/env logic.
    // This registry entry only makes OPENCLAW_BOOTSTRAP_CHANNEL=telegram a compatible no-op.
    applyConfig: ({ cfg }) => cfg,
  },
  {
    publicId: "qq",
    aliases: ["qqbot"],
    channelId: "qqbot",
    pluginId: "openclaw-qqbot",
    npmSpec: "@tencent-connect/openclaw-qqbot@1.5.7",
    requiredEnv: ["QQ_APP_ID", "QQ_APP_SECRET"],
    applyConfig: ({ cfg }) => {
      const existing = resolveChannelSection(cfg, "qqbot");
      const allowFrom = Array.isArray(existing?.allowFrom) ? existing.allowFrom : ["*"];
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          qqbot: {
            ...existing,
            enabled: true,
            allowFrom,
            appId: envRef("QQ_APP_ID"),
            clientSecret: envRef("QQ_APP_SECRET"),
          },
        },
      };
    },
  },
];

export function listBootstrapChannelEntries(): BootstrapChannelEntry[] {
  return bootstrapChannelEntries.slice();
}

export function resolveBootstrapChannelEntry(raw: string): BootstrapChannelEntry | undefined {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return bootstrapChannelEntries.find((entry) => {
    if (entry.publicId === normalized) {
      return true;
    }
    return (entry.aliases ?? []).some((alias) => alias.trim().toLowerCase() === normalized);
  });
}
