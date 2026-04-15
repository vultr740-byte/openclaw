import { telegramMessageActions } from "../../channels/plugins/actions/telegram.js";
import type { PluginRuntime } from "./types.js";

export type RuntimeChannelTelegramActionsSection = Pick<
  PluginRuntime["channel"]["telegram"],
  "messageActions"
>;

export function createRuntimeChannelTelegramActionsSection(): RuntimeChannelTelegramActionsSection {
  return {
    messageActions: telegramMessageActions,
  };
}
