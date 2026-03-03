import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { findGitRoot } from "../infra/git-root.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import {
  formatUserTime,
  resolveUserTimeFormat,
  resolveUserTimezone,
  type ResolvedTimeFormat,
} from "./date-time.js";
import { normalizeWorkspaceDir } from "./workspace-dir.js";

export type RuntimeInfoInput = {
  agentId?: string;
  host: string;
  os: string;
  arch: string;
  node: string;
  model: string;
  defaultModel?: string;
  shell?: string;
  channel?: string;
  capabilities?: string[];
  /** Supported message actions for the current channel (e.g., react, edit, unsend) */
  channelActions?: string[];
  isContainer?: boolean;
  isRemote?: boolean;
  platform?: string;
  homeDir?: string;
  stateDir?: string;
  workspaceRoot?: string;
  repoRoot?: string;
};

export type SystemPromptRuntimeParams = {
  runtimeInfo: RuntimeInfoInput;
  userTimezone: string;
  userTime?: string;
  userTimeFormat?: ResolvedTimeFormat;
};

export function buildSystemPromptParams(params: {
  config?: OpenClawConfig;
  agentId?: string;
  runtime: Omit<RuntimeInfoInput, "agentId">;
  workspaceDir?: string;
  cwd?: string;
}): SystemPromptRuntimeParams {
  const runtimeFacts = resolveRuntimeEnvironmentFacts({
    workspaceDir: params.workspaceDir,
    cwd: params.cwd,
  });
  const repoRoot = resolveRepoRoot({
    config: params.config,
    workspaceDir: params.workspaceDir,
    cwd: params.cwd,
  });
  const userTimezone = resolveUserTimezone(params.config?.agents?.defaults?.userTimezone);
  const userTimeFormat = resolveUserTimeFormat(params.config?.agents?.defaults?.timeFormat);
  const userTime = formatUserTime(new Date(), userTimezone, userTimeFormat);
  return {
    runtimeInfo: {
      agentId: params.agentId,
      ...params.runtime,
      isContainer:
        typeof params.runtime.isContainer === "boolean"
          ? params.runtime.isContainer
          : runtimeFacts.isContainer,
      isRemote:
        typeof params.runtime.isRemote === "boolean"
          ? params.runtime.isRemote
          : runtimeFacts.isRemote,
      platform: params.runtime.platform?.trim() || runtimeFacts.platform,
      homeDir: params.runtime.homeDir?.trim() || runtimeFacts.homeDir,
      stateDir: params.runtime.stateDir?.trim() || runtimeFacts.stateDir,
      workspaceRoot: params.runtime.workspaceRoot?.trim() || runtimeFacts.workspaceRoot,
      repoRoot,
    },
    userTimezone,
    userTime,
    userTimeFormat,
  };
}

function resolveRuntimeEnvironmentFacts(params: { workspaceDir?: string; cwd?: string }): {
  isContainer: boolean;
  isRemote: boolean;
  platform?: string;
  homeDir?: string;
  stateDir?: string;
  workspaceRoot?: string;
} {
  const env = process.env;
  const platform = detectHostingPlatform(env);
  const homeDir = resolveRequiredHomeDir(env, os.homedir);
  const stateDir = resolveStateDir(env, () => homeDir);
  const workspaceRoot =
    normalizeWorkspaceDir(params.workspaceDir) ?? normalizeWorkspaceDir(params.cwd) ?? undefined;
  const isContainer = detectContainerizedRuntime(env, platform);
  const isRemote = detectRemoteRuntime(env, platform);
  return {
    isContainer,
    isRemote,
    platform,
    homeDir,
    stateDir,
    workspaceRoot,
  };
}

function detectHostingPlatform(env: NodeJS.ProcessEnv): string | undefined {
  if (env.RAILWAY_PROJECT_ID || env.RAILWAY_ENVIRONMENT_ID) {
    return "railway";
  }
  if (env.FLY_APP_NAME || env.FLY_REGION) {
    return "fly";
  }
  if (env.RENDER || env.RENDER_SERVICE_ID) {
    return "render";
  }
  if (env.HEROKU_APP_NAME || env.DYNO) {
    return "heroku";
  }
  if (env.KUBERNETES_SERVICE_HOST || env.KUBERNETES_PORT) {
    return "kubernetes";
  }
  if (env.VERCEL || env.VERCEL_URL) {
    return "vercel";
  }
  return undefined;
}

function detectContainerizedRuntime(env: NodeJS.ProcessEnv, platform?: string): boolean {
  if (env.OPENCLAW_CONTAINER?.trim() === "1") {
    return true;
  }
  if (platform && platform !== "vercel") {
    return true;
  }
  try {
    if (fs.existsSync("/.dockerenv")) {
      return true;
    }
  } catch {
    // ignore
  }
  try {
    const cgroup = fs.readFileSync("/proc/1/cgroup", "utf8");
    if (/\b(docker|containerd|kubepods|podman|lxc)\b/i.test(cgroup)) {
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

function detectRemoteRuntime(env: NodeJS.ProcessEnv, platform?: string): boolean {
  if (platform) {
    return true;
  }
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) {
    return true;
  }
  if (env.CODESPACES || env.GITPOD_WORKSPACE_ID) {
    return true;
  }
  return false;
}

function resolveRepoRoot(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  cwd?: string;
}): string | undefined {
  const configured = params.config?.agents?.defaults?.repoRoot?.trim();
  if (configured) {
    try {
      const resolved = path.resolve(configured);
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        return resolved;
      }
    } catch {
      // ignore invalid config path
    }
  }
  const candidates = [params.workspaceDir, params.cwd]
    .map((value) => value?.trim())
    .filter(Boolean) as string[];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    const root = findGitRoot(resolved);
    if (root) {
      return root;
    }
  }
  return undefined;
}
