import { createLazyFacadeArrayValue } from "./facade-loader.js";
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

type FacadeModule = typeof import("@openclaw/telegram/contract-api.js");

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "telegram",
    artifactBasename: "contract-api.js",
  });
}

export type {
  ChannelAccountSnapshot,
  ChannelGatewayContext,
  ChannelMessageActionAdapter,
} from "../channels/plugins/types.js";
export type { OpenClawConfig } from "../config/config.js";
export type { InspectedTelegramAccount } from "../telegram/account-inspect.js";
export type { ResolvedTelegramAccount } from "../telegram/accounts.js";
export type { TelegramProbe } from "../telegram/probe.js";
export * from "./channel-plugin-common.js";

export {
  listTelegramAccountIds,
  resolveDefaultTelegramAccountId,
  resolveTelegramAccount,
} from "../telegram/accounts.js";
export { inspectTelegramAccount } from "../telegram/account-inspect.js";
export {
  projectCredentialSnapshotFields,
  resolveConfiguredFromCredentialStatuses,
} from "../channels/account-snapshot-fields.js";
export {
  listTelegramDirectoryGroupsFromConfig,
  listTelegramDirectoryPeersFromConfig,
} from "../channels/plugins/directory-config.js";
export {
  looksLikeTelegramTargetId,
  normalizeTelegramMessagingTarget,
} from "../channels/plugins/normalize/telegram.js";
export {
  parseTelegramReplyToMessageId,
  parseTelegramThreadId,
} from "../telegram/outbound-params.js";
export { collectTelegramStatusIssues } from "../channels/plugins/status-issues/telegram.js";
export { clearAccountEntryFields } from "../channels/plugins/config-helpers.js";
export { buildAccountScopedDmSecurityPolicy } from "../channels/plugins/helpers.js";
export {
  collectAllowlistProviderGroupPolicyWarnings,
  collectOpenGroupPolicyRouteAllowlistWarnings,
} from "../channels/plugins/group-policy-warnings.js";
export {
  createScopedAccountConfigAccessors,
  createScopedChannelConfigBase,
} from "./channel-config-helpers.js";
export { formatAllowFromLowercase } from "./allow-from.js";
export { createPluginRuntimeStore } from "./runtime-store.js";
export {
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
} from "../config/runtime-group-policy.js";
export {
  resolveTelegramGroupRequireMention,
  resolveTelegramGroupToolPolicy,
} from "../channels/plugins/group-mentions.js";
export { telegramOnboardingAdapter } from "../channels/plugins/onboarding/telegram.js";
export { TelegramConfigSchema } from "../config/zod-schema.providers-core.js";
export { buildTokenChannelStatusSummary } from "./status-helpers.js";

export const parseTelegramTopicConversation: FacadeModule["parseTelegramTopicConversation"] = ((
  ...args
) =>
  loadFacadeModule().parseTelegramTopicConversation(
    ...args,
  )) as FacadeModule["parseTelegramTopicConversation"];

export const singleAccountKeysToMove = createLazyFacadeArrayValue(
  () => loadFacadeModule().singleAccountKeysToMove,
);

export const collectTelegramSecurityAuditFindings: FacadeModule["collectTelegramSecurityAuditFindings"] =
  ((...args) =>
    loadFacadeModule().collectTelegramSecurityAuditFindings(
      ...args,
    )) as FacadeModule["collectTelegramSecurityAuditFindings"];

export const mergeTelegramAccountConfig: FacadeModule["mergeTelegramAccountConfig"] = ((...args) =>
  loadFacadeModule().mergeTelegramAccountConfig(
    ...args,
  )) as FacadeModule["mergeTelegramAccountConfig"];
