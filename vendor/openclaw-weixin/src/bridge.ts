import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";

import {
  clearStaleAccountsForUserId,
  DEFAULT_BASE_URL,
  loadWeixinAccount,
  registerWeixinAccountId,
  saveWeixinAccount,
  triggerWeixinChannelReload,
} from "./auth/accounts.js";
import type { WeixinQrPolledStatusResult } from "./auth/login-qr.js";
import { clearContextTokensForAccount } from "./messaging/inbound.js";
import { logger } from "./util/logger.js";

export async function persistConfirmedWeixinLogin(
  result: Pick<WeixinQrPolledStatusResult, "connected" | "botToken" | "accountId" | "baseUrl" | "userId">,
): Promise<void> {
  if (!result.connected || !result.botToken || !result.accountId) {
    return;
  }

  const normalizedId = normalizeAccountId(result.accountId);
  saveWeixinAccount(normalizedId, {
    token: result.botToken,
    baseUrl: result.baseUrl,
    userId: result.userId,
  });
  registerWeixinAccountId(normalizedId);
  if (result.userId) {
    clearStaleAccountsForUserId(normalizedId, result.userId, clearContextTokensForAccount);
  }
  await triggerWeixinChannelReload();
  logger.info(`persistConfirmedWeixinLogin: saved account data for accountId=${normalizedId}`);
}

export function resolveWeixinBaseUrl(accountId?: string | null): string {
  const trimmed = accountId?.trim();
  return (trimmed ? loadWeixinAccount(trimmed)?.baseUrl?.trim() : "") || DEFAULT_BASE_URL;
}
