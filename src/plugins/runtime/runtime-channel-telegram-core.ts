import { monitorTelegramProvider } from "../../telegram/monitor.js";
import { probeTelegram } from "../../telegram/probe.js";
import { resolveTelegramToken } from "../../telegram/token.js";
import type { PluginRuntime } from "./types.js";

export type RuntimeChannelTelegramCoreSection = Pick<
  PluginRuntime["channel"]["telegram"],
  "monitorTelegramProvider" | "probeTelegram" | "resolveTelegramToken"
>;

export function createRuntimeChannelTelegramCoreSection(): RuntimeChannelTelegramCoreSection {
  return {
    monitorTelegramProvider,
    probeTelegram,
    resolveTelegramToken,
  };
}
