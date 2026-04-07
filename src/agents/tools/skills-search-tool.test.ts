import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeSkill } from "../skills.e2e-test-helpers.js";
import type { SkillhubSearchMatch } from "./skillhub-tool.js";
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
        searchedRemote?: boolean;
        localMatches?: Array<{ name?: string; command?: string }>;
        matches?: Array<{ name?: string; command?: string }>;
      };
      const names = (details.localMatches ?? []).map((match) => match.name);
      expect(names).toContain("x-twitter-fetch");
      expect(details.searchedRemote).toBe(true);
      const target = (details.localMatches ?? []).find((match) => match.name === "x-twitter-fetch");
      expect(target?.command).toBe("/x_twitter_fetch");
    } finally {
      await cleanupWorkspace(paths);
    }
  });

  it("prioritizes domain-relevant skills for URL queries", async () => {
    const paths = await createWorkspace();
    try {
      await writeSkill({
        dir: path.join(paths.workspaceDir, "skills", "x-twitter-fetch"),
        name: "x-twitter-fetch",
        description: "Fetch X/Twitter post threads and replies.",
      });
      await writeSkill({
        dir: path.join(paths.workspaceDir, "skills", "web-notes"),
        name: "web-notes",
        description: "General notes for x.com and random websites.",
      });
      await writeSkill({
        dir: path.join(paths.workspaceDir, "skills", "markdown-converter"),
        name: "markdown-converter",
        description: "Convert markdown documents.",
      });

      const tool = createSkillsSearchTool({ workspaceDir: paths.workspaceDir });
      const result = await tool.execute("call-domain", {
        query: "https://x.com/elonmusk/status/123",
      });
      const details = result.details as {
        searchedRemote?: boolean;
        localMatches?: Array<{ name?: string }>;
      };
      const rankedNames = (details.localMatches ?? [])
        .map((match) => match.name)
        .filter((name): name is string => Boolean(name));
      const xRank = rankedNames.indexOf("x-twitter-fetch");
      const webNotesRank = rankedNames.indexOf("web-notes");
      expect(details.searchedRemote).toBe(true);
      expect(xRank).toBeGreaterThanOrEqual(0);
      expect(webNotesRank).toBeGreaterThanOrEqual(0);
      expect(xRank).toBeLessThan(webNotesRank);
    } finally {
      await cleanupWorkspace(paths);
    }
  });

  it("matches skills by generated slash command", async () => {
    const paths = await createWorkspace();
    try {
      await writeSkill({
        dir: path.join(paths.workspaceDir, "skills", "x-twitter-fetch"),
        name: "x-twitter-fetch",
        description: "Fetch X/Twitter post threads and replies.",
      });
      await writeSkill({
        dir: path.join(paths.workspaceDir, "skills", "rss-reader"),
        name: "rss-reader",
        description: "Read RSS feeds.",
      });

      const tool = createSkillsSearchTool({ workspaceDir: paths.workspaceDir });
      const result = await tool.execute("call-command", {
        query: "/x_twitter_fetch",
      });
      const details = result.details as {
        matches?: Array<{ name?: string; command?: string }>;
      };
      const first = details.matches?.[0];
      expect(first?.name).toBe("x-twitter-fetch");
      expect(first?.command).toBe("/x_twitter_fetch");
    } finally {
      await cleanupWorkspace(paths);
    }
  });

  it("matches x thread-reading queries to x-twitter-fetch", async () => {
    const paths = await createWorkspace();
    try {
      await writeSkill({
        dir: path.join(paths.workspaceDir, "skills", "x-twitter-fetch"),
        name: "x-twitter-fetch",
        description:
          "Fetch X/Twitter posts, thread context, replies, and user timelines from direct status URLs.",
      });
      await writeSkill({
        dir: path.join(paths.workspaceDir, "skills", "summarize"),
        name: "summarize",
        description: "Summarize arbitrary content and URLs.",
      });

      const tool = createSkillsSearchTool({ workspaceDir: paths.workspaceDir });
      const result = await tool.execute("call-thread-query", {
        query: "read X thread context and replies from a status URL",
        scope: "local",
      });
      const details = result.details as {
        matches?: Array<{ name?: string; command?: string }>;
        nextAction?: { type?: string; skillName?: string; command?: string };
      };

      expect(details.matches?.[0]?.name).toBe("x-twitter-fetch");
      expect(details.matches?.[0]?.command).toBe("/x_twitter_fetch");
      expect(details.nextAction?.type).toBe("read_local_skill");
      expect(details.nextAction?.skillName).toBe("x-twitter-fetch");
      expect(details.nextAction?.command).toBe("/x_twitter_fetch");
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

  it("includes remote SkillHub matches in auto mode and recommends remote when local is weak", async () => {
    const paths = await createWorkspace();
    try {
      await writeSkill({
        dir: path.join(paths.workspaceDir, "skills", "summarize"),
        name: "summarize",
        description: "Summarize arbitrary content.",
      });

      const remoteSearch = vi
        .fn<(params: { query: string; limit: number }) => Promise<SkillhubSearchMatch[]>>()
        .mockResolvedValue([
          {
            slug: "wechat-article-reader",
            name: "微信公众号文章导出",
            summary: "将微信公众号文章导出为 Markdown 格式。",
            version: "1.0.0",
          },
        ]);

      const tool = createSkillsSearchTool({
        workspaceDir: paths.workspaceDir,
        remoteSearch,
      });
      const result = await tool.execute("call-auto-remote", {
        query: "微信公众号文章",
      });
      const details = result.details as {
        scope?: string;
        recommendedSource?: string;
        searchedRemote?: boolean;
        remoteMatchCount?: number;
        nextAction?: { type?: string; slug?: string; skillName?: string };
        matches?: Array<{ source?: string; slug?: string; name?: string }>;
      };

      expect(details.scope).toBe("auto");
      expect(details.searchedRemote).toBe(true);
      expect(details.recommendedSource).toBe("remote");
      expect(details.remoteMatchCount).toBe(1);
      expect(details.nextAction?.type).toBe("install_remote_skill");
      expect(details.nextAction?.slug).toBe("wechat-article-reader");
      expect(details.nextAction?.skillName).toBe("微信公众号文章导出");
      expect(details.matches?.[0]?.source).toBe("remote");
      expect(details.matches?.[0]?.slug).toBe("wechat-article-reader");
      expect(remoteSearch).toHaveBeenCalledWith({
        query: "微信公众号文章",
        limit: 8,
        config: undefined,
      });
    } finally {
      await cleanupWorkspace(paths);
    }
  });

  it("still queries remote in auto mode when local search returns generic matches", async () => {
    const paths = await createWorkspace();
    try {
      await writeSkill({
        dir: path.join(paths.workspaceDir, "skills", "summarize"),
        name: "summarize",
        description: "Summarize arbitrary URLs and content.",
      });
      await writeSkill({
        dir: path.join(paths.workspaceDir, "skills", "browse"),
        name: "browse",
        description: "Browse web pages and inspect sites.",
      });

      const remoteSearch = vi
        .fn<(params: { query: string; limit: number }) => Promise<SkillhubSearchMatch[]>>()
        .mockResolvedValue([
          {
            slug: "wechat-article-reader",
            name: "WeChat MP Reader",
            summary: "Read and export WeChat public account articles.",
            version: "1.2.0",
          },
        ]);

      const tool = createSkillsSearchTool({
        workspaceDir: paths.workspaceDir,
        remoteSearch,
      });
      const result = await tool.execute("call-auto-generic-local", {
        query: "wechat public account article reader",
      });
      const details = result.details as {
        scope?: string;
        searchedRemote?: boolean;
        localMatchCount?: number;
        remoteMatchCount?: number;
        recommendedSource?: string;
        matches?: Array<{ source?: string; slug?: string; name?: string }>;
      };

      expect(details.scope).toBe("auto");
      expect(details.searchedRemote).toBe(true);
      expect(details.localMatchCount).toBeGreaterThan(0);
      expect(details.remoteMatchCount).toBe(1);
      expect(details.recommendedSource).toBe("remote");
      expect(details.matches?.some((match) => match.source === "local")).toBe(true);
      expect(details.matches?.[0]?.source).toBe("remote");
      expect(details.matches?.[0]?.slug).toBe("wechat-article-reader");
      expect(remoteSearch).toHaveBeenCalledWith({
        query: "wechat public account article reader",
        limit: 8,
        config: undefined,
      });
    } finally {
      await cleanupWorkspace(paths);
    }
  });

  it("prefers a strong local domain skill over generic remote results in auto mode", async () => {
    const paths = await createWorkspace();
    try {
      await writeSkill({
        dir: path.join(paths.workspaceDir, "skills", "wechat-article-extractor"),
        name: "wechat-article-extractor",
        description:
          "Extract metadata and content from WeChat Official Account articles on mp.weixin.qq.com.",
      });
      await writeSkill({
        dir: path.join(paths.workspaceDir, "skills", "summarize"),
        name: "summarize",
        description: "Summarize arbitrary URLs and content.",
      });

      const remoteSearch = vi
        .fn<(params: { query: string; limit: number }) => Promise<SkillhubSearchMatch[]>>()
        .mockResolvedValue([
          {
            slug: "self-improving-agent",
            name: "self-improving-agent",
            summary:
              "Captures learnings, errors, and corrections to enable continuous improvement.",
            version: "3.0.6",
            downloads: 100000,
            stars: 2000,
          },
          {
            slug: "find-skills",
            name: "Find Skills",
            summary: "Helps users discover and install agent skills.",
            version: "0.1.0",
            downloads: 90000,
            stars: 500,
          },
        ]);

      const tool = createSkillsSearchTool({
        workspaceDir: paths.workspaceDir,
        remoteSearch,
      });
      const result = await tool.execute("call-auto-local-wins", {
        query: "https://mp.weixin.qq.com/s/2NUlZtRMbNHpBvgAe3__Qg",
      });
      const details = result.details as {
        recommendedSource?: string;
        nextAction?: { type?: string; skillName?: string };
        localMatches?: Array<{ name?: string }>;
        matches?: Array<{ source?: string; name?: string }>;
      };

      expect(details.recommendedSource).toBe("local");
      expect(details.nextAction?.type).toBe("read_local_skill");
      expect(details.nextAction?.skillName).toBe("wechat-article-extractor");
      expect(details.localMatches?.[0]?.name).toBe("wechat-article-extractor");
      expect(details.matches?.[0]?.source).toBe("local");
      expect(details.matches?.[0]?.name).toBe("wechat-article-extractor");
    } finally {
      await cleanupWorkspace(paths);
    }
  });

  it("supports remote-only scope", async () => {
    const paths = await createWorkspace();
    try {
      const remoteSearch = vi
        .fn<(params: { query: string; limit: number }) => Promise<SkillhubSearchMatch[]>>()
        .mockResolvedValue([
          {
            slug: "wechat-reader",
            name: "WeChat Article Reader",
            summary: "Read WeChat public account articles.",
            version: "1.0.0",
          },
        ]);

      const tool = createSkillsSearchTool({
        workspaceDir: paths.workspaceDir,
        remoteSearch,
      });
      const result = await tool.execute("call-remote-only", {
        query: "wechat article",
        scope: "remote",
        limit: 3,
      });
      const details = result.details as {
        scope?: string;
        searchedRemote?: boolean;
        totalSkills?: number;
        localMatchCount?: number;
        remoteMatchCount?: number;
        nextAction?: { type?: string; slug?: string; skillName?: string };
        matches?: Array<{ source?: string; slug?: string }>;
      };

      expect(details.scope).toBe("remote");
      expect(details.searchedRemote).toBe(true);
      expect(details.totalSkills).toBeUndefined();
      expect(details.localMatchCount).toBe(0);
      expect(details.remoteMatchCount).toBe(1);
      expect(details.nextAction?.type).toBe("install_remote_skill");
      expect(details.nextAction?.slug).toBe("wechat-reader");
      expect(details.nextAction?.skillName).toBe("WeChat Article Reader");
      expect(details.matches?.[0]?.source).toBe("remote");
      expect(details.matches?.[0]?.slug).toBe("wechat-reader");
    } finally {
      await cleanupWorkspace(paths);
    }
  });

  it("returns a nextAction for the best local match", async () => {
    const paths = await createWorkspace();
    try {
      await writeSkill({
        dir: path.join(paths.workspaceDir, "skills", "jina-reader"),
        name: "jina-reader",
        description: "Read web pages and PDFs into LLM-friendly text.",
      });

      const tool = createSkillsSearchTool({ workspaceDir: paths.workspaceDir });
      const result = await tool.execute("call-local-next-action", {
        query: "read webpage content",
        scope: "local",
      });
      const details = result.details as {
        recommendedSource?: string;
        nextAction?: { type?: string; skillName?: string; path?: string; command?: string };
      };

      expect(details.recommendedSource).toBe("local");
      expect(details.nextAction?.type).toBe("read_local_skill");
      expect(details.nextAction?.skillName).toBe("jina-reader");
      expect(details.nextAction?.path).toContain("/skills/jina-reader/SKILL.md");
      expect(details.nextAction?.command).toBe("/jina_reader");
    } finally {
      await cleanupWorkspace(paths);
    }
  });

  it("supports excluding previously tried local skills so retries can advance", async () => {
    const paths = await createWorkspace();
    try {
      await writeSkill({
        dir: path.join(paths.workspaceDir, "skills", "jina-reader"),
        name: "jina-reader",
        description: "Read web pages and PDFs into LLM-friendly text.",
      });
      await writeSkill({
        dir: path.join(paths.workspaceDir, "skills", "summarize"),
        name: "summarize",
        description: "Summarize arbitrary content and URLs.",
      });

      const tool = createSkillsSearchTool({ workspaceDir: paths.workspaceDir });
      const result = await tool.execute("call-local-exclude", {
        query: "read webpage content",
        scope: "local",
        exclude: ["jina-reader", "/jina_reader"],
      });
      const details = result.details as {
        exclude?: string[];
        localMatches?: Array<{ name?: string }>;
        nextAction?: { type?: string; skillName?: string };
      };

      expect(details.exclude).toContain("jina-reader");
      expect(details.localMatches?.some((match) => match.name === "jina-reader")).toBe(false);
      expect(details.nextAction?.type).toBe("read_local_skill");
      expect(details.nextAction?.skillName).toBe("summarize");
    } finally {
      await cleanupWorkspace(paths);
    }
  });

  it("supports excluding previously tried remote skills so retries can advance", async () => {
    const paths = await createWorkspace();
    try {
      const remoteSearch = vi
        .fn<(params: { query: string; limit: number }) => Promise<SkillhubSearchMatch[]>>()
        .mockResolvedValue([
          {
            slug: "wechat-reader",
            name: "WeChat Article Reader",
            summary: "Read WeChat public account articles.",
            version: "1.0.0",
          },
          {
            slug: "wechat-exporter",
            name: "WeChat Article Exporter",
            summary: "Export WeChat public account articles.",
            version: "1.1.0",
          },
        ]);

      const tool = createSkillsSearchTool({
        workspaceDir: paths.workspaceDir,
        remoteSearch,
      });
      const result = await tool.execute("call-remote-exclude", {
        query: "wechat article",
        scope: "remote",
        exclude: ["wechat-reader"],
      });
      const details = result.details as {
        remoteMatches?: Array<{ slug?: string }>;
        nextAction?: { type?: string; slug?: string; skillName?: string };
      };

      expect(details.remoteMatches?.some((match) => match.slug === "wechat-reader")).toBe(false);
      expect(details.nextAction?.type).toBe("install_remote_skill");
      expect(details.nextAction?.slug).toBe("wechat-exporter");
      expect(details.nextAction?.skillName).toBe("WeChat Article Exporter");
    } finally {
      await cleanupWorkspace(paths);
    }
  });
});
