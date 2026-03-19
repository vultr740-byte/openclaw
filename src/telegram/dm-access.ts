import type { Message } from "@grammyjs/types";
import type { Bot } from "grammy";
import { claimBootstrapDmOwner } from "../channels/bootstrap-owner-claim.js";
import type { DmPolicy } from "../config/types.js";
import { logVerbose } from "../globals.js";
import { issuePairingChallenge } from "../pairing/pairing-challenge.js";
import { upsertChannelPairingRequest } from "../pairing/pairing-store.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { resolveSenderAllowMatch, type NormalizedAllowFrom } from "./bot-access.js";

type TelegramDmAccessLogger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
};

type TelegramSenderIdentity = {
  username: string;
  userId: string | null;
  candidateId: string;
  firstName?: string;
  lastName?: string;
};

export type TelegramDmAccessResult = {
  allowed: boolean;
  storeAllowFrom?: string[];
};

function resolveTelegramSenderIdentity(msg: Message, chatId: number): TelegramSenderIdentity {
  const from = msg.from;
  const userId = from?.id != null ? String(from.id) : null;
  return {
    username: from?.username ?? "",
    userId,
    candidateId: userId ?? String(chatId),
    firstName: from?.first_name,
    lastName: from?.last_name,
  };
}

export async function enforceTelegramDmAccess(params: {
  isGroup: boolean;
  dmPolicy: DmPolicy;
  msg: Message;
  chatId: number;
  effectiveDmAllow: NormalizedAllowFrom;
  accountId: string;
  bot: Bot;
  logger: TelegramDmAccessLogger;
}): Promise<TelegramDmAccessResult> {
  const { isGroup, dmPolicy, msg, chatId, effectiveDmAllow, accountId, bot, logger } = params;
  if (isGroup) {
    return { allowed: true };
  }
  if (dmPolicy === "disabled") {
    return { allowed: false };
  }
  if (dmPolicy === "open") {
    return { allowed: true };
  }

  const sender = resolveTelegramSenderIdentity(msg, chatId);
  const allowMatch = resolveSenderAllowMatch({
    allow: effectiveDmAllow,
    senderId: sender.candidateId,
    senderUsername: sender.username,
  });
  const allowMatchMeta = `matchKey=${allowMatch.matchKey ?? "none"} matchSource=${
    allowMatch.matchSource ?? "none"
  }`;
  const allowed =
    effectiveDmAllow.hasWildcard || (effectiveDmAllow.hasEntries && allowMatch.allowed);
  if (allowed) {
    return { allowed: true };
  }

  if (dmPolicy === "pairing") {
    const telegramUserId = sender.userId ?? sender.candidateId;
    const ownerClaim = await claimBootstrapDmOwner({
      channel: "telegram",
      senderId: telegramUserId,
      accountId,
    });
    if (ownerClaim?.allowFrom.includes(telegramUserId)) {
      logger.info(
        {
          chatId: String(chatId),
          senderUserId: sender.userId ?? undefined,
          username: sender.username || undefined,
          firstName: sender.firstName,
          lastName: sender.lastName,
          autoClaimed: ownerClaim.changed,
        },
        "telegram bootstrap owner claim",
      );
      return { allowed: true, storeAllowFrom: ownerClaim.allowFrom };
    }
    try {
      await issuePairingChallenge({
        channel: "telegram",
        senderId: telegramUserId,
        senderIdLine: `Your Telegram user id: ${telegramUserId}`,
        meta: {
          username: sender.username || undefined,
          firstName: sender.firstName,
          lastName: sender.lastName,
        },
        upsertPairingRequest: async ({ id, meta }) =>
          await upsertChannelPairingRequest({
            channel: "telegram",
            id,
            accountId,
            meta,
          }),
        onCreated: () => {
          logger.info(
            {
              chatId: String(chatId),
              senderUserId: sender.userId ?? undefined,
              username: sender.username || undefined,
              firstName: sender.firstName,
              lastName: sender.lastName,
              matchKey: allowMatch.matchKey ?? "none",
              matchSource: allowMatch.matchSource ?? "none",
            },
            "telegram pairing request",
          );
        },
        sendPairingReply: async (text) => {
          await withTelegramApiErrorLogging({
            operation: "sendMessage",
            fn: () => bot.api.sendMessage(chatId, text),
          });
        },
        onReplyError: (err) => {
          logVerbose(`telegram pairing reply failed for chat ${chatId}: ${String(err)}`);
        },
      });
    } catch (err) {
      logVerbose(`telegram pairing reply failed for chat ${chatId}: ${String(err)}`);
    }
    return { allowed: false };
  }

  logVerbose(
    `Blocked unauthorized telegram sender ${sender.candidateId} (dmPolicy=${dmPolicy}, ${allowMatchMeta})`,
  );
  return { allowed: false };
}
