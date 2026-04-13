import {
  type ResolvedWhatsAppAccount as UpstreamResolvedWhatsAppAccount,
  DEFAULT_WHATSAPP_MEDIA_MAX_MB,
  hasAnyWhatsAppAuth,
  listEnabledWhatsAppAccounts,
  listWhatsAppAccountIds,
  listWhatsAppAuthDirs,
  resolveDefaultWhatsAppAccountId,
  resolveWhatsAppAccount as resolveUpstreamWhatsAppAccount,
  resolveWhatsAppAuthDir,
  resolveWhatsAppMediaMaxBytes,
} from "../../extensions/whatsapp/src/accounts.js";
import type { OpenClawConfig } from "../config/config.js";
import type { WhatsAppAccountConfig } from "../config/types.js";

export { DEFAULT_WHATSAPP_MEDIA_MAX_MB };
export {
  hasAnyWhatsAppAuth,
  listEnabledWhatsAppAccounts,
  listWhatsAppAccountIds,
  listWhatsAppAuthDirs,
  resolveDefaultWhatsAppAccountId,
  resolveWhatsAppAuthDir,
  resolveWhatsAppMediaMaxBytes,
};

export type ResolvedWhatsAppAccount = UpstreamResolvedWhatsAppAccount & {
  config: WhatsAppAccountConfig;
};

export function resolveWhatsAppAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedWhatsAppAccount {
  const resolved = resolveUpstreamWhatsAppAccount(params);
  return {
    ...resolved,
    config: buildLegacyWhatsAppConfig(params.cfg, resolved),
  };
}

function buildLegacyWhatsAppConfig(
  cfg: OpenClawConfig,
  account: UpstreamResolvedWhatsAppAccount,
): WhatsAppAccountConfig {
  const rootCfg = cfg.channels?.whatsapp;
  const accountCfg = rootCfg?.accounts?.[account.accountId];
  return {
    ...rootCfg,
    ...accountCfg,
    enabled: account.enabled,
    name: account.name,
    sendReadReceipts: account.sendReadReceipts,
    messagePrefix: account.messagePrefix,
    defaultTo: account.defaultTo,
    authDir: account.authDir,
    selfChatMode: account.selfChatMode,
    allowFrom: account.allowFrom,
    groupAllowFrom: account.groupAllowFrom,
    groupPolicy: account.groupPolicy,
    dmPolicy: account.dmPolicy,
    textChunkLimit: account.textChunkLimit,
    chunkMode: account.chunkMode,
    mediaMaxMb: account.mediaMaxMb,
    blockStreaming: account.blockStreaming,
    ackReaction: account.ackReaction,
    reactionLevel: account.reactionLevel,
    groups: account.groups,
    debounceMs: account.debounceMs,
  };
}
