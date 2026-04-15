import { signalMessageActions } from "../../channels/plugins/actions/signal.js";
import { monitorSignalProvider } from "../../signal/index.js";
import { probeSignal } from "../../signal/probe.js";
import { sendMessageSignal } from "../../signal/send.js";
import type { PluginRuntime } from "./types.js";

export function createRuntimeChannelSignal(): PluginRuntime["channel"]["signal"] {
  return {
    probeSignal,
    sendMessageSignal,
    monitorSignalProvider,
    messageActions: signalMessageActions,
  };
}
