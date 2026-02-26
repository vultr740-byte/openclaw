import type { OpenClawConfig } from "../config/config.js";
import type { AgentModelEntryConfig } from "../config/types.agent-defaults.js";
import {
  MissingEnvVarError,
  containsEnvVarReference,
  resolveConfigEnvVars,
} from "../config/env-substitution.js";
const toModelKey = (provider: string, model: string) => `${provider}/${model}`;

function resolveConfigKeyEnv(raw: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!containsEnvVarReference(raw)) {
    return raw;
  }
  try {
    const resolved = resolveConfigEnvVars({ value: raw }, env) as { value: string };
    return resolved.value;
  } catch (error) {
    if (error instanceof MissingEnvVarError) {
      return raw;
    }
    throw error;
  }
}

export function resolveConfiguredModelKey(
  raw: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveConfigKeyEnv(raw, env);
}

export function resolveAgentModelEntry(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  env?: NodeJS.ProcessEnv;
}): AgentModelEntryConfig | undefined {
  const models = params.cfg?.agents?.defaults?.models;
  if (!models) {
    return undefined;
  }
  const key = toModelKey(params.provider, params.modelId);
  const direct = models[key];
  if (direct) {
    return direct;
  }
  for (const [rawKey, entry] of Object.entries(models)) {
    const resolvedKey = resolveConfigKeyEnv(rawKey, params.env);
    if (resolvedKey === key) {
      return entry;
    }
  }
  return undefined;
}
