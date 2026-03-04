import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeSkill } from "../skills.e2e-test-helpers.js";
import { createSkillsSearchTool } from "./skills-search-tool.js";

async function createWorkspace() {
  const workspaceDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "openclaw-skills-search-workspace-"),
  );
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-search-home-"));
  vi.stubEnv("HOME", homeDir);
  return { workspaceDir, homeDir };
}

async function cleanupWorkspace(paths: { workspaceDir: string; homeDir: string }) {
  vi.unstubAllEnvs();
  await fs.rm(paths.workspaceDir, { recursive: true, force: true });
  await fs.rm(paths.homeDir, { recursive: true, force: true });
}

describe("skills_search tool", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns matching skills with command hints", async () => {
    const paths = await createWorkspace();
    try {
      await writeSkill({
        dir: path.join(paths.workspaceDir, "skills", "x-twitter-fetch"),
        name: "x-twitter-fetch",
        description: "Fetch X/Twitter post threads and replies.",
      });
      await writeSkill({
        dir: path.join(paths.workspaceDir, "skills", "markdown-converter"),
        name: "markdown-converter",
        description: "Convert markdown documents.",
      });

      const tool = createSkillsSearchTool({ workspaceDir: paths.workspaceDir });
      const result = await tool.execute("call1", {
        query: "https://x.com/elonmusk/status/123",
      });
      const details = result.details as {
        matches?: Array<{ name?: string; command?: string }>;
      };
      const names = (details.matches ?? []).map((match) => match.name);
      expect(names).toContain("x-twitter-fetch");
      const target = (details.matches ?? []).find((match) => match.name === "x-twitter-fetch");
      expect(target?.command).toBe("/x_twitter_fetch");
    } finally {
      await cleanupWorkspace(paths);
    }
  });

  it("excludes skills disabled for model invocation", async () => {
    const paths = await createWorkspace();
    try {
      await writeSkill({
        dir: path.join(paths.workspaceDir, "skills", "hidden-skill"),
        name: "hidden-skill",
        description: "Should not be model discoverable",
        frontmatterExtra: "disable-model-invocation: true",
      });

      const tool = createSkillsSearchTool({ workspaceDir: paths.workspaceDir });
      const result = await tool.execute("call2", {
        query: "hidden-skill",
      });
      const details = result.details as {
        matches?: Array<{ name?: string }>;
      };
      const names = (details.matches ?? []).map((match) => match.name);
      expect(names).not.toContain("hidden-skill");
    } finally {
      await cleanupWorkspace(paths);
    }
  });
});
