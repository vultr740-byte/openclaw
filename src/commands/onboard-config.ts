import type { OpenClawConfig } from "../config/config.js";
import type { DmScope } from "../config/types.base.js";
import type { ToolProfileId } from "../config/types.tools.js";
import type { ExecAsk, ExecSecurity, ExecTarget } from "../infra/exec-approvals.js";

export const ONBOARDING_DEFAULT_DM_SCOPE: DmScope = "per-channel-peer";
export const ONBOARDING_DEFAULT_TOOLS_PROFILE: ToolProfileId = "coding";
export const ONBOARDING_DEFAULT_EXEC_HOST: ExecTarget = "gateway";
export const ONBOARDING_DEFAULT_EXEC_SECURITY: ExecSecurity = "full";
export const ONBOARDING_DEFAULT_EXEC_ASK: ExecAsk = "off";

export function applyLocalSetupWorkspaceConfig(
  baseConfig: OpenClawConfig,
  workspaceDir: string,
): OpenClawConfig {
  return {
    ...baseConfig,
    agents: {
      ...baseConfig.agents,
      defaults: {
        ...baseConfig.agents?.defaults,
        workspace: workspaceDir,
      },
    },
    gateway: {
      ...baseConfig.gateway,
      mode: "local",
    },
    session: {
      ...baseConfig.session,
      dmScope: baseConfig.session?.dmScope ?? ONBOARDING_DEFAULT_DM_SCOPE,
    },
    tools: {
      ...baseConfig.tools,
      profile: baseConfig.tools?.profile ?? ONBOARDING_DEFAULT_TOOLS_PROFILE,
      exec: {
        ...baseConfig.tools?.exec,
        host: baseConfig.tools?.exec?.host ?? ONBOARDING_DEFAULT_EXEC_HOST,
        security: baseConfig.tools?.exec?.security ?? ONBOARDING_DEFAULT_EXEC_SECURITY,
        ask: baseConfig.tools?.exec?.ask ?? ONBOARDING_DEFAULT_EXEC_ASK,
      },
    },
  };
}
