import {
  auditTelegramGroupMembership,
  collectTelegramUnmentionedGroupIds,
} from "../../telegram/audit.js";
import type { PluginRuntime } from "./types.js";

export type RuntimeChannelTelegramAuditSection = Pick<
  PluginRuntime["channel"]["telegram"],
  "auditTelegramGroupMembership" | "collectTelegramUnmentionedGroupIds"
>;

export function createRuntimeChannelTelegramAuditSection(): RuntimeChannelTelegramAuditSection {
  return {
    auditTelegramGroupMembership: auditTelegramGroupMembership,
    collectTelegramUnmentionedGroupIds: collectTelegramUnmentionedGroupIds,
  };
}
