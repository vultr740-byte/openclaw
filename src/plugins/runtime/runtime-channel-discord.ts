import { discordMessageActions } from "../../channels/plugins/actions/discord.js";
import { auditDiscordChannelPermissions } from "../../discord/audit.js";
import {
  listDiscordDirectoryGroupsLive,
  listDiscordDirectoryPeersLive,
} from "../../discord/directory-live.js";
import { monitorDiscordProvider } from "../../discord/monitor.js";
import { probeDiscord } from "../../discord/probe.js";
import { resolveDiscordChannelAllowlist } from "../../discord/resolve-channels.js";
import { resolveDiscordUserAllowlist } from "../../discord/resolve-users.js";
import { sendMessageDiscord, sendPollDiscord } from "../../discord/send.js";
import type { PluginRuntime } from "./types.js";

export function createRuntimeChannelDiscord(): PluginRuntime["channel"]["discord"] {
  return {
    messageActions: discordMessageActions,
    auditChannelPermissions: auditDiscordChannelPermissions,
    listDirectoryGroupsLive: listDiscordDirectoryGroupsLive,
    listDirectoryPeersLive: listDiscordDirectoryPeersLive,
    probeDiscord,
    resolveChannelAllowlist: resolveDiscordChannelAllowlist,
    resolveUserAllowlist: resolveDiscordUserAllowlist,
    sendMessageDiscord,
    sendPollDiscord,
    monitorDiscordProvider,
  };
}
