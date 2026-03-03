import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { withEnv } from "../test-utils/env.js";
import { buildSystemPromptParams } from "./system-prompt-params.js";

async function makeTempDir(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `openclaw-${label}-`));
}

async function makeRepoRoot(root: string): Promise<void> {
  await fs.mkdir(path.join(root, ".git"), { recursive: true });
}

function buildParams(params: { config?: OpenClawConfig; workspaceDir?: string; cwd?: string }) {
  return buildSystemPromptParams({
    config: params.config,
    workspaceDir: params.workspaceDir,
    cwd: params.cwd,
    runtime: {
      host: "host",
      os: "os",
      arch: "arch",
      node: "node",
      model: "model",
    },
  });
}

describe("buildSystemPromptParams repo root", () => {
  it("detects repo root from workspaceDir", async () => {
    const temp = await makeTempDir("workspace");
    const repoRoot = path.join(temp, "repo");
    const workspaceDir = path.join(repoRoot, "nested", "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    await makeRepoRoot(repoRoot);

    const { runtimeInfo } = buildParams({ workspaceDir });

    expect(runtimeInfo.repoRoot).toBe(repoRoot);
  });

  it("falls back to cwd when workspaceDir has no repo", async () => {
    const temp = await makeTempDir("cwd");
    const repoRoot = path.join(temp, "repo");
    const workspaceDir = path.join(temp, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    await makeRepoRoot(repoRoot);

    const { runtimeInfo } = buildParams({ workspaceDir, cwd: repoRoot });

    expect(runtimeInfo.repoRoot).toBe(repoRoot);
  });

  it("uses configured repoRoot when valid", async () => {
    const temp = await makeTempDir("config");
    const repoRoot = path.join(temp, "config-root");
    const workspaceDir = path.join(temp, "workspace");
    await fs.mkdir(repoRoot, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });
    await makeRepoRoot(workspaceDir);

    const config: OpenClawConfig = {
      agents: {
        defaults: {
          repoRoot,
        },
      },
    };

    const { runtimeInfo } = buildParams({ config, workspaceDir });

    expect(runtimeInfo.repoRoot).toBe(repoRoot);
  });

  it("ignores invalid repoRoot config and auto-detects", async () => {
    const temp = await makeTempDir("invalid");
    const repoRoot = path.join(temp, "repo");
    const workspaceDir = path.join(repoRoot, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    await makeRepoRoot(repoRoot);

    const config: OpenClawConfig = {
      agents: {
        defaults: {
          repoRoot: path.join(temp, "missing"),
        },
      },
    };

    const { runtimeInfo } = buildParams({ config, workspaceDir });

    expect(runtimeInfo.repoRoot).toBe(repoRoot);
  });

  it("returns undefined when no repo is found", async () => {
    const workspaceDir = await makeTempDir("norepo");

    const { runtimeInfo } = buildParams({ workspaceDir });

    expect(runtimeInfo.repoRoot).toBeUndefined();
  });
});

describe("buildSystemPromptParams runtime environment facts", () => {
  it("detects hosted container runtime hints from environment", async () => {
    const workspaceDir = await makeTempDir("runtime-facts");
    const home = await makeTempDir("runtime-home");
    const stateDir = path.join(home, "openclaw-state");
    await fs.mkdir(stateDir, { recursive: true });

    const { runtimeInfo } = withEnv(
      {
        HOME: home,
        OPENCLAW_STATE_DIR: stateDir,
        RAILWAY_PROJECT_ID: "project-id",
        RAILWAY_ENVIRONMENT_ID: "env-id",
      },
      () => buildParams({ workspaceDir }),
    );

    expect(runtimeInfo.platform).toBe("railway");
    expect(runtimeInfo.isContainer).toBe(true);
    expect(runtimeInfo.isRemote).toBe(true);
    expect(runtimeInfo.homeDir).toBe(home);
    expect(runtimeInfo.stateDir).toBe(stateDir);
    expect(runtimeInfo.workspaceRoot).toBe(workspaceDir);
  });

  it("respects explicit runtime hints over auto-detected values", async () => {
    const workspaceDir = await makeTempDir("runtime-override");

    const { runtimeInfo } = withEnv(
      {
        RAILWAY_PROJECT_ID: "project-id",
        RAILWAY_ENVIRONMENT_ID: "env-id",
      },
      () =>
        buildSystemPromptParams({
          workspaceDir,
          runtime: {
            host: "host",
            os: "os",
            arch: "arch",
            node: "node",
            model: "model",
            isContainer: false,
            isRemote: false,
            platform: "manual",
          },
        }),
    );

    expect(runtimeInfo.platform).toBe("manual");
    expect(runtimeInfo.isContainer).toBe(false);
    expect(runtimeInfo.isRemote).toBe(false);
  });
});
