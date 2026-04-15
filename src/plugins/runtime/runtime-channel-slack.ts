import { handleSlackAction } from "../../agents/tools/slack-actions.js";
import {
  listSlackDirectoryGroupsLive,
  listSlackDirectoryPeersLive,
} from "../../slack/directory-live.js";
import { monitorSlackProvider } from "../../slack/index.js";
import { probeSlack } from "../../slack/probe.js";
import { resolveSlackChannelAllowlist } from "../../slack/resolve-channels.js";
import { resolveSlackUserAllowlist } from "../../slack/resolve-users.js";
import { sendMessageSlack } from "../../slack/send.js";
import type { PluginRuntime } from "./types.js";

export function createRuntimeChannelSlack(): PluginRuntime["channel"]["slack"] {
  return {
    listDirectoryGroupsLive: listSlackDirectoryGroupsLive,
    listDirectoryPeersLive: listSlackDirectoryPeersLive,
    probeSlack,
    resolveChannelAllowlist: resolveSlackChannelAllowlist,
    resolveUserAllowlist: resolveSlackUserAllowlist,
    sendMessageSlack,
    monitorSlackProvider,
    handleSlackAction,
  };
}
