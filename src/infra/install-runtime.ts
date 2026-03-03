import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export type InstallMode = "auto" | "global";
export type InstallTarget = "global" | "state" | "workspace";

export type InstallTargetResolution = {
  mode: InstallMode;
  target: InstallTarget;
  containerized: boolean;
  stateDir: string;
  workspaceDir: string;
};

export type InstallRuntimeEnv = {
  HOME: string;
  XDG_CONFIG_HOME: string;
  XDG_CACHE_HOME: string;
  XDG_STATE_HOME: string;
  XDG_DATA_HOME: string;
};

const STATE_INSTALL_SUBDIR = path.join("tools", "runtime");
const WORKSPACE_INSTALL_SUBDIR = path.join(".openclaw", "tools", "runtime");

function hasContainerEnvHint(env: NodeJS.ProcessEnv): boolean {
  if (env.RAILWAY_PROJECT_ID?.trim()) {
    return true;
  }
  if (env.RAILWAY_SERVICE_ID?.trim()) {
    return true;
  }
  if (env.RAILWAY_ENVIRONMENT_ID?.trim()) {
    return true;
  }
  if (env.KUBERNETES_SERVICE_HOST?.trim()) {
    return true;
  }
  if (env.CONTAINER?.trim()) {
    return true;
  }
  if (env.container?.trim()) {
    return true;
  }
  return false;
}

function hasContainerFileHint(): boolean {
  for (const marker of ["/.dockerenv", "/run/.containerenv"]) {
    try {
      if (fs.existsSync(marker)) {
        return true;
      }
    } catch {
      // Best-effort runtime hinting only.
    }
  }
  return false;
}

function hasContainerCgroupHint(): boolean {
  try {
    const cgroup = fs.readFileSync("/proc/1/cgroup", "utf-8").toLowerCase();
    return (
      cgroup.includes("docker") ||
      cgroup.includes("containerd") ||
      cgroup.includes("kubepods") ||
      cgroup.includes("podman") ||
      cgroup.includes("lxc")
    );
  } catch {
    return false;
  }
}

export function isContainerizedRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  if (hasContainerEnvHint(env)) {
    return true;
  }
  if (hasContainerFileHint()) {
    return true;
  }
  return hasContainerCgroupHint();
}

export function normalizeInstallMode(mode?: string | null): InstallMode {
  const normalized = mode?.trim().toLowerCase();
  if (normalized === "global") {
    return "global";
  }
  return "auto";
}

export function canWriteDirectory(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = fs.mkdtempSync(path.join(dir, ".openclaw-install-probe-"));
    fs.rmSync(probe, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function resolveInstallTarget(params: {
  mode?: string | null;
  workspaceDir: string;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  containerized?: boolean;
  canWriteStateDir?: boolean;
}): InstallTargetResolution {
  const env = params.env ?? process.env;
  const mode = normalizeInstallMode(params.mode);
  const workspaceDir = path.resolve(params.workspaceDir);
  const stateDir = path.resolve(params.stateDir ?? resolveStateDir(env));
  const containerized = params.containerized ?? isContainerizedRuntime(env);

  if (mode === "global") {
    return { mode, target: "global", containerized, stateDir, workspaceDir };
  }

  if (!containerized) {
    return { mode, target: "global", containerized, stateDir, workspaceDir };
  }

  const writableState = params.canWriteStateDir ?? canWriteDirectory(stateDir);
  const target: InstallTarget = writableState ? "state" : "workspace";
  return { mode, target, containerized, stateDir, workspaceDir };
}

export function resolveInstallRootDir(
  resolution: Pick<InstallTargetResolution, "target" | "stateDir" | "workspaceDir">,
): string | undefined {
  if (resolution.target === "state") {
    return path.join(resolution.stateDir, STATE_INSTALL_SUBDIR);
  }
  if (resolution.target === "workspace") {
    return path.join(resolution.workspaceDir, WORKSPACE_INSTALL_SUBDIR);
  }
  return undefined;
}

export function resolveInstallBinDir(
  resolution: Pick<InstallTargetResolution, "target" | "stateDir" | "workspaceDir">,
): string | undefined {
  const root = resolveInstallRootDir(resolution);
  if (!root) {
    return undefined;
  }
  return path.join(root, "bin");
}

export function resolveInstallRuntimeEnv(
  resolution: Pick<InstallTargetResolution, "target" | "stateDir" | "workspaceDir">,
): InstallRuntimeEnv | undefined {
  const root = resolveInstallRootDir(resolution);
  if (!root) {
    return undefined;
  }
  const home = path.join(root, "home");
  return {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
  };
}
