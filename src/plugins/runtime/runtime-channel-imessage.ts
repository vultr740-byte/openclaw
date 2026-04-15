import { monitorIMessageProvider } from "../../imessage/monitor.js";
import { probeIMessage } from "../../imessage/probe.js";
import { sendMessageIMessage } from "../../imessage/send.js";
import type { PluginRuntime } from "./types.js";

export function createRuntimeChannelIMessage(): PluginRuntime["channel"]["imessage"] {
  return {
    monitorIMessageProvider,
    probeIMessage,
    sendMessageIMessage,
  };
}
