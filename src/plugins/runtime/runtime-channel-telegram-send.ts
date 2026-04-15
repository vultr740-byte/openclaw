import { sendMessageTelegram, sendPollTelegram } from "../../telegram/send.js";
import type { PluginRuntime } from "./types.js";

export type RuntimeChannelTelegramSendSection = Pick<
  PluginRuntime["channel"]["telegram"],
  "sendMessageTelegram" | "sendPollTelegram"
>;

export function createRuntimeChannelTelegramSendSection(): RuntimeChannelTelegramSendSection {
  return {
    sendMessageTelegram,
    sendPollTelegram,
  };
}
