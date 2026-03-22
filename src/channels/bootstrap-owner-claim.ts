import { claimFirstChannelAllowFromStoreEntry } from "../pairing/pairing-store.js";
import type { ChannelId } from "./plugins/types.js";

export type BootstrapOwnerClaimMode = "off" | "first-dm";

export type BootstrapOwnerClaimResult = Awaited<
  ReturnType<typeof claimFirstChannelAllowFromStoreEntry>
>;

const OWNER_CLAIM_ENABLED_VALUES = new Set(["1", "true", "on", "enabled", "first-dm"]);
const OWNER_CLAIM_DISABLED_VALUES = new Set(["0", "false", "off", "disabled", "none"]);
const OWNER_CLAIM_SUPPORTED_CHANNELS = new Set<string>(["discord", "telegram"]);

export function normalizeBootstrapChannelId(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  switch (normalized) {
    case "tg":
      return "telegram";
    case "qq":
    case "qqbot":
      return "qqbot";
    case "weixin":
      return "weixin";
    default:
      return normalized;
  }
}

export function parseBootstrapChannelIds(raw: string | undefined): string[] {
  if (!raw?.trim()) {
    return [];
  }
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const entry of raw.split(/[,\n;]+/g)) {
    const normalized = normalizeBootstrapChannelId(entry);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    resolved.push(normalized);
  }
  return resolved;
}

export function resolveBootstrapChannelIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const rawChannels = env.OPENCLAW_BOOTSTRAP_CHANNELS?.trim();
  if (rawChannels) {
    return parseBootstrapChannelIds(rawChannels);
  }
  return parseBootstrapChannelIds(env.OPENCLAW_BOOTSTRAP_CHANNEL);
}

export function supportsBootstrapOwnerClaim(channelId: string): boolean {
  return OWNER_CLAIM_SUPPORTED_CHANNELS.has(normalizeBootstrapChannelId(channelId));
}

export function resolveRequestedBootstrapOwnerClaimMode(
  env: NodeJS.ProcessEnv = process.env,
): BootstrapOwnerClaimMode {
  const raw = env.OPENCLAW_BOOTSTRAP_OWNER_MODE?.trim().toLowerCase();
  if (!raw) {
    return resolveBootstrapChannelIds(env).length > 0 ? "first-dm" : "off";
  }
  if (OWNER_CLAIM_DISABLED_VALUES.has(raw)) {
    return "off";
  }
  if (OWNER_CLAIM_ENABLED_VALUES.has(raw)) {
    return "first-dm";
  }
  return "off";
}

export function resolveBootstrapOwnerClaimModeForChannel(
  channelId: string,
  env: NodeJS.ProcessEnv = process.env,
): BootstrapOwnerClaimMode {
  const normalizedChannelId = normalizeBootstrapChannelId(channelId);
  if (!supportsBootstrapOwnerClaim(normalizedChannelId)) {
    return "off";
  }
  const bootstrapChannels = resolveBootstrapChannelIds(env);
  if (!bootstrapChannels.includes(normalizedChannelId)) {
    return "off";
  }
  return resolveRequestedBootstrapOwnerClaimMode(env);
}

export async function claimBootstrapDmOwner(params: {
  channel: ChannelId;
  senderId: string;
  accountId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<BootstrapOwnerClaimResult | null> {
  const env = params.env ?? process.env;
  if (resolveBootstrapOwnerClaimModeForChannel(params.channel, env) !== "first-dm") {
    return null;
  }
  return await claimFirstChannelAllowFromStoreEntry({
    channel: params.channel,
    entry: params.senderId,
    accountId: params.accountId,
    env,
  });
}
