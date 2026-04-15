import {
  listLineAccountIds,
  normalizeAccountId as normalizeLineAccountId,
  resolveDefaultLineAccountId,
  resolveLineAccount,
} from "../../line/accounts.js";
import { monitorLineProvider } from "../../line/monitor.js";
import { probeLineBot } from "../../line/probe.js";
import {
  createQuickReplyItems,
  pushFlexMessage,
  pushLocationMessage,
  pushMessageLine,
  pushMessagesLine,
  pushTemplateMessage,
  pushTextMessageWithQuickReplies,
  sendMessageLine,
} from "../../line/send.js";
import { buildTemplateMessageFromPayload } from "../../line/template-messages.js";
import type { PluginRuntime } from "./types.js";

export function createRuntimeChannelLine(): PluginRuntime["channel"]["line"] {
  return {
    listLineAccountIds,
    resolveDefaultLineAccountId,
    resolveLineAccount,
    normalizeAccountId: normalizeLineAccountId,
    probeLineBot,
    sendMessageLine,
    pushMessageLine,
    pushMessagesLine,
    pushFlexMessage,
    pushTemplateMessage,
    pushLocationMessage,
    pushTextMessageWithQuickReplies,
    createQuickReplyItems,
    buildTemplateMessageFromPayload,
    monitorLineProvider,
  };
}
