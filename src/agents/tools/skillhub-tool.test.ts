import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const fetchWithSsrFGuardMock = vi.fn();
const extractArchiveMock = vi.fn();

vi.mock("../../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
}));

vi.mock("../skills-install-extract.js", () => ({
  extractArchive: (...args: unknown[]) => extractArchiveMock(...args),
}));

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

async function createWorkspace() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skillhub-tool-"));
}

async function writeExtractedSkill(targetDir: string, slug = "calendar") {
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(
    path.join(targetDir, "SKILL.md"),
    `---\nname: ${slug}\ndescription: Test skill\n---\n\n# ${slug}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(targetDir, "_meta.json"), JSON.stringify({ slug }), "utf8");
}

describe("skillhub tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns normalized remote matches", async () => {
    const { createSkillhubTool } = await import("./skillhub-tool.js");
    const workspaceDir = await createWorkspace();
    try {
      fetchWithSsrFGuardMock
        .mockResolvedValueOnce({
          response: new Response(
            JSON.stringify({
              results: [
                {
                  displayName: "Calendar",
                  slug: "calendar",
                  summary: "Calendar management",
                  version: "1.0.0",
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
          finalUrl: "https://example.com/search?q=calendar&limit=3",
          release: vi.fn(async () => {}),
        })
        .mockResolvedValueOnce({
          response: new Response(
            JSON.stringify({
              latestVersion: {
                version: "1.0.0",
              },
              skill: {
                slug: "calendar",
                displayName: "Calendar",
                summary: "Calendar management",
                summary_zh: "Calendar management",
                homepage: "https://example.com/calendar",
                category: "Productivity",
                stats: {
                  downloads: 12,
                  stars: 3,
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
          finalUrl: "https://example.com/skills/calendar",
          release: vi.fn(async () => {}),
        });

      const tool = createSkillhubTool({
        workspaceDir,
        config: asConfig({
          skills: {
            hub: {
              searchUrl: "https://example.com/search",
              detailUrlTemplate: "https://example.com/skills/{slug}",
            },
          },
        }),
      });
      const result = await tool.execute("call-search", {
        action: "search",
        query: "calendar",
        limit: 3,
      });
      const details = result.details as {
        provider?: string;
        matches?: Array<{ slug?: string; homepage?: string; categories?: string[] }>;
      };

      expect(details.provider).toBe("skillhub");
      expect(details.matches?.[0]?.slug).toBe("calendar");
      expect(details.matches?.[0]?.homepage).toBe("https://example.com/calendar");
      expect(details.matches?.[0]?.categories).toEqual(["Productivity"]);
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(2);
      expect(fetchWithSsrFGuardMock.mock.calls[0]?.[0]?.policy).toMatchObject({
        allowedHostnames: expect.arrayContaining([
          "example.com",
          "api.skillhub.tencent.com",
          "skillhub-1388575217.cos.accelerate.myqcloud.com",
        ]),
        hostnameAllowlist: expect.arrayContaining([
          "example.com",
          "api.skillhub.tencent.com",
          "skillhub-1388575217.cos.accelerate.myqcloud.com",
        ]),
      });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("installs a remote skill into the workspace", async () => {
    const { createSkillhubTool } = await import("./skillhub-tool.js");
    const workspaceDir = await createWorkspace();
    try {
      fetchWithSsrFGuardMock
        .mockResolvedValueOnce({
          response: new Response(
            JSON.stringify({
              latestVersion: {
                version: "1.0.0",
              },
              skill: {
                slug: "calendar",
                displayName: "Calendar",
                summary: "Calendar management",
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
          finalUrl: "https://example.com/skills/calendar",
          release: vi.fn(async () => {}),
        })
        .mockResolvedValueOnce({
          response: new Response(Buffer.from("zip-bytes"), {
            status: 200,
            headers: { "content-type": "application/zip" },
          }),
          finalUrl: "https://example.com/download?slug=calendar",
          release: vi.fn(async () => {}),
        });

      extractArchiveMock.mockImplementationOnce(async ({ targetDir }: { targetDir: string }) => {
        await writeExtractedSkill(targetDir, "calendar");
        return { stdout: "", stderr: "", code: 0 };
      });

      const tool = createSkillhubTool({
        workspaceDir,
        config: asConfig({
          skills: {
            hub: {
              detailUrlTemplate: "https://example.com/skills/{slug}",
              primaryDownloadUrlTemplate: "https://example.com/download?slug={slug}",
            },
          },
        }),
      });
      const result = await tool.execute("call-install", { action: "install", slug: "calendar" });
      const details = result.details as {
        installed?: boolean;
        skill?: { slug?: string; version?: string };
      };

      expect(details.installed).toBe(true);
      expect(details.skill?.slug).toBe("calendar");
      expect(details.skill?.version).toBe("1.0.0");
      await expect(
        fs.readFile(path.join(workspaceDir, "skills", "calendar", "SKILL.md"), "utf8"),
      ).resolves.toContain("name: calendar");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("falls back to copy when final publish rename crosses devices", async () => {
    const { createSkillhubTool } = await import("./skillhub-tool.js");
    const workspaceDir = await createWorkspace();
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async () => {
      const error = new Error("cross-device link not permitted") as NodeJS.ErrnoException;
      error.code = "EXDEV";
      throw error;
    });
    try {
      fetchWithSsrFGuardMock
        .mockResolvedValueOnce({
          response: new Response(
            JSON.stringify({
              latestVersion: {
                version: "1.0.0",
              },
              skill: {
                slug: "summarize",
                displayName: "Summarize",
                summary: "Summarize content",
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
          finalUrl: "https://example.com/skills/summarize",
          release: vi.fn(async () => {}),
        })
        .mockResolvedValueOnce({
          response: new Response(Buffer.from("zip-bytes"), {
            status: 200,
            headers: { "content-type": "application/zip" },
          }),
          finalUrl: "https://example.com/download?slug=summarize",
          release: vi.fn(async () => {}),
        });

      extractArchiveMock.mockImplementationOnce(async ({ targetDir }: { targetDir: string }) => {
        await writeExtractedSkill(targetDir, "summarize");
        return { stdout: "", stderr: "", code: 0 };
      });

      const tool = createSkillhubTool({
        workspaceDir,
        config: asConfig({
          skills: {
            hub: {
              detailUrlTemplate: "https://example.com/skills/{slug}",
              primaryDownloadUrlTemplate: "https://example.com/download?slug={slug}",
            },
          },
        }),
      });

      const result = await tool.execute("call-install-exdev", {
        action: "install",
        slug: "summarize",
      });
      const details = result.details as {
        installed?: boolean;
        skill?: { slug?: string };
      };

      expect(details.installed).toBe(true);
      expect(details.skill?.slug).toBe("summarize");
      await expect(
        fs.readFile(path.join(workspaceDir, "skills", "summarize", "SKILL.md"), "utf8"),
      ).resolves.toContain("name: summarize");
    } finally {
      renameSpy.mockRestore();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("enriches search matches from the detail endpoint without a static index", async () => {
    const { createSkillhubTool } = await import("./skillhub-tool.js");
    const workspaceDir = await createWorkspace();
    try {
      fetchWithSsrFGuardMock
        .mockResolvedValueOnce({
          response: new Response(
            JSON.stringify({
              results: [
                {
                  displayName: "微信公众号文章解析",
                  slug: "wechat-article-extractor-skill",
                  summary: "Extract metadata and content from WeChat articles.",
                  version: "1.0.1",
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
          finalUrl: "https://example.com/search?q=%E5%BE%AE%E4%BF%A1&limit=8",
          release: vi.fn(async () => {}),
        })
        .mockResolvedValueOnce({
          response: new Response(
            JSON.stringify({
              latestVersion: {
                version: "1.0.1",
              },
              skill: {
                slug: "wechat-article-extractor-skill",
                displayName: "微信公众号文章解析",
                summary_zh: "提取微信公众号文章的元数据与内容。",
                category: "content-creation",
                stats: {
                  downloads: 3638,
                  stars: 4,
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
          finalUrl: "https://example.com/skills/wechat-article-extractor-skill",
          release: vi.fn(async () => {}),
        });

      const tool = createSkillhubTool({
        workspaceDir,
        config: asConfig({
          skills: {
            hub: {
              searchUrl: "https://example.com/search",
              detailUrlTemplate: "https://example.com/skills/{slug}",
            },
          },
        }),
      });

      const result = await tool.execute("call-search-wechat", {
        action: "search",
        query: "微信公众号文章",
        limit: 8,
      });
      const details = result.details as {
        count?: number;
        matches?: Array<{
          slug?: string;
          categories?: string[];
          downloads?: number;
          stars?: number;
          summary?: string;
        }>;
      };

      expect(details.count).toBe(1);
      expect(details.matches?.[0]?.slug).toBe("wechat-article-extractor-skill");
      expect(details.matches?.[0]?.categories).toEqual(["content-creation"]);
      expect(details.matches?.[0]?.downloads).toBe(3638);
      expect(details.matches?.[0]?.stars).toBe(4);
      expect(details.matches?.[0]?.summary).toContain("Extract metadata");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid install slugs", async () => {
    const { createSkillhubTool } = await import("./skillhub-tool.js");
    const workspaceDir = await createWorkspace();
    try {
      const tool = createSkillhubTool({ workspaceDir });
      await expect(
        tool.execute("call-install-invalid", { action: "install", slug: "../escape" }),
      ).rejects.toThrow('Invalid skill slug "../escape"');
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("respects skills.hub.enabled=false", async () => {
    const { createSkillhubTool } = await import("./skillhub-tool.js");
    const workspaceDir = await createWorkspace();
    try {
      const tool = createSkillhubTool({
        workspaceDir,
        config: asConfig({
          skills: {
            hub: {
              enabled: false,
            },
          },
        }),
      });
      await expect(
        tool.execute("call-disabled", { action: "search", query: "calendar" }),
      ).rejects.toThrow("Native SkillHub integration is disabled by config");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
