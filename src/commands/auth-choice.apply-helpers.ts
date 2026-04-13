import type { ApplyAuthChoiceParams } from "./auth-choice.apply.types.js";
import { applyDefaultModelChoice } from "./auth-choice.default-model.js";

export type {
  SecretInputModePromptCopy,
  SecretRefSetupPromptCopy,
} from "../plugins/provider-auth-input.js";
export {
  ensureApiKeyFromEnvOrPrompt,
  ensureApiKeyFromOptionEnvOrPrompt,
  maybeApplyApiKeyFromOption,
  normalizeSecretInputModeInput,
  normalizeTokenProviderInput,
  promptSecretRefForSetup,
  resolveSecretInputModeForEnvSelection,
} from "../plugins/provider-auth-input.js";
import type { OpenClawConfig } from "../config/types.js";
import type { SecretRef } from "../config/types.secrets.js";
import type { SecretRefSetupPromptCopy } from "../plugins/provider-auth-ref.js";
import type { WizardPrompter } from "../wizard/prompts.js";

export function createAuthChoiceAgentModelNoter(
  params: ApplyAuthChoiceParams,
): (model: string) => Promise<void> {
  return async (model: string) => {
    if (!params.agentId) {
      return;
    }
    await params.prompter.note(
      `Default model set to ${model} for agent "${params.agentId}".`,
      "Model configured",
    );
  };
}

export interface ApplyAuthChoiceModelState {
  config: ApplyAuthChoiceParams["config"];
  agentModelOverride: string | undefined;
}

export function createAuthChoiceModelStateBridge(bindings: {
  getConfig: () => ApplyAuthChoiceParams["config"];
  setConfig: (config: ApplyAuthChoiceParams["config"]) => void;
  getAgentModelOverride: () => string | undefined;
  setAgentModelOverride: (model: string | undefined) => void;
}): ApplyAuthChoiceModelState {
  return {
    get config() {
      return bindings.getConfig();
    },
    set config(config) {
      bindings.setConfig(config);
    },
    get agentModelOverride() {
      return bindings.getAgentModelOverride();
    },
    set agentModelOverride(model) {
      bindings.setAgentModelOverride(model);
    },
  };
}

export function createAuthChoiceDefaultModelApplier(
  params: ApplyAuthChoiceParams,
  state: ApplyAuthChoiceModelState,
): (
  options: Omit<
    Parameters<typeof applyDefaultModelChoice>[0],
    "config" | "setDefaultModel" | "noteAgentModel" | "prompter"
  >,
) => Promise<void> {
  const noteAgentModel = createAuthChoiceAgentModelNoter(params);

  return async (options) => {
    const applied = await applyDefaultModelChoice({
      config: state.config,
      setDefaultModel: params.setDefaultModel,
      noteAgentModel,
      prompter: params.prompter,
      ...options,
    });
    state.config = applied.config;
    state.agentModelOverride = applied.agentModelOverride ?? state.agentModelOverride;
  };
}

export function createAuthChoiceDefaultModelApplierForMutableState(
  params: ApplyAuthChoiceParams,
  getConfig: () => ApplyAuthChoiceParams["config"],
  setConfig: (config: ApplyAuthChoiceParams["config"]) => void,
  getAgentModelOverride: () => string | undefined,
  setAgentModelOverride: (model: string | undefined) => void,
): ReturnType<typeof createAuthChoiceDefaultModelApplier> {
  return createAuthChoiceDefaultModelApplier(
    params,
    createAuthChoiceModelStateBridge({
      getConfig,
      setConfig,
      getAgentModelOverride,
      setAgentModelOverride,
    }),
  );
}

// Legacy onboarding callers still import this helper from the auth-choice surface.
export async function promptSecretRefForOnboarding(params: {
  provider: string;
  config: OpenClawConfig;
  prompter: WizardPrompter;
  preferredEnvVar?: string;
  copy?: SecretRefSetupPromptCopy;
  env?: NodeJS.ProcessEnv;
}): Promise<{ ref: SecretRef; resolvedValue: string }> {
  const { promptSecretRefForSetup } = await import("../plugins/provider-auth-input.js");
  return await promptSecretRefForSetup(params);
}
