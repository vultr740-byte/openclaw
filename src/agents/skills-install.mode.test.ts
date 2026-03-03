import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTempWorkspace } from "./skills-install.download-test-utils.js";
import { installSkill } from "./skills-install.js";
import {
  runCommandWithTimeoutMock,
  scanDirectoryWithSummaryMock,
} from "./skills-install.test-mocks.js";

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

vi.mock("../security/skill-scanner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../security/skill-scanner.js")>()),
  scanDirectoryWithSummary: (...args: unknown[]) => scanDirectoryWithSummaryMock(...args),
}));

async function writeNodeInstallSkill(workspaceDir: string, name: string): Promise<void> {
  const skillDir = path.join(workspaceDir, "skills", name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: ${name}
description: test skill
metadata: {"openclaw":{"install":[{"id":"deps","kind":"node","package":"example-package"}]}}
---

# ${name}
`,
    "utf-8",
  );
}

function findNpmInstallArgv(): string[] {
  const call = runCommandWithTimeoutMock.mock.calls.find(
    (entry) => Array.isArray(entry[0]) && entry[0][0] === "npm",
  );
  if (!call) {
    throw new Error("npm install call not found");
  }
  return call[0] as string[];
}

describe("skills-install install mode", () => {
  beforeEach(() => {
    runCommandWithTimeoutMock.mockClear();
    scanDirectoryWithSummaryMock.mockClear();
    scanDirectoryWithSummaryMock.mockResolvedValue({ critical: 0, warn: 0, findings: [] });
    runCommandWithTimeoutMock.mockResolvedValue({
      code: 0,
      stdout: "ok",
      stderr: "",
      signal: null,
      killed: false,
    });
  });

  it("auto mode in container redirects npm global install to state local prefix", async () => {
    await withTempWorkspace(async ({ workspaceDir, stateDir }) => {
      await writeNodeInstallSkill(workspaceDir, "pkg-skill");
      const prevRailwayProject = process.env.RAILWAY_PROJECT_ID;
      process.env.RAILWAY_PROJECT_ID = "project-id";
      try {
        const result = await installSkill({
          workspaceDir,
          skillName: "pkg-skill",
          installId: "deps",
          config: {
            skills: {
              install: {
                mode: "auto",
                nodeManager: "npm",
              },
            },
          },
        });
        expect(result.ok).toBe(true);
        const argv = findNpmInstallArgv();
        expect(argv).toContain("-g");
        expect(argv).toContain("--prefix");
        expect(argv).toContain(path.join(stateDir, "tools", "runtime"));
      } finally {
        if (prevRailwayProject === undefined) {
          delete process.env.RAILWAY_PROJECT_ID;
        } else {
          process.env.RAILWAY_PROJECT_ID = prevRailwayProject;
        }
      }
    });
  });

  it("auto mode falls back to workspace prefix when state dir is not writable", async () => {
    await withTempWorkspace(async ({ workspaceDir, stateDir }) => {
      await writeNodeInstallSkill(workspaceDir, "pkg-skill-ws");
      const stateFile = path.join(stateDir, "blocked-state-path");
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(stateFile, "blocked", "utf-8");

      const prevStateDir = process.env.OPENCLAW_STATE_DIR;
      const prevRailwayProject = process.env.RAILWAY_PROJECT_ID;
      process.env.OPENCLAW_STATE_DIR = stateFile;
      process.env.RAILWAY_PROJECT_ID = "project-id";
      try {
        const result = await installSkill({
          workspaceDir,
          skillName: "pkg-skill-ws",
          installId: "deps",
          config: {
            skills: {
              install: {
                mode: "auto",
                nodeManager: "npm",
              },
            },
          },
        });
        expect(result.ok).toBe(true);
        const argv = findNpmInstallArgv();
        expect(argv).toContain("--prefix");
        expect(argv).toContain(path.join(workspaceDir, ".openclaw", "tools", "runtime"));
      } finally {
        if (prevStateDir === undefined) {
          delete process.env.OPENCLAW_STATE_DIR;
        } else {
          process.env.OPENCLAW_STATE_DIR = prevStateDir;
        }
        if (prevRailwayProject === undefined) {
          delete process.env.RAILWAY_PROJECT_ID;
        } else {
          process.env.RAILWAY_PROJECT_ID = prevRailwayProject;
        }
      }
    });
  });

  it("global mode keeps npm global install command unchanged", async () => {
    await withTempWorkspace(async ({ workspaceDir }) => {
      await writeNodeInstallSkill(workspaceDir, "pkg-skill-global");
      const prevRailwayProject = process.env.RAILWAY_PROJECT_ID;
      process.env.RAILWAY_PROJECT_ID = "project-id";
      try {
        const result = await installSkill({
          workspaceDir,
          skillName: "pkg-skill-global",
          installId: "deps",
          config: {
            skills: {
              install: {
                mode: "global",
                nodeManager: "npm",
              },
            },
          },
        });
        expect(result.ok).toBe(true);
        const argv = findNpmInstallArgv();
        expect(argv).toEqual(["npm", "install", "-g", "--ignore-scripts", "example-package"]);
      } finally {
        if (prevRailwayProject === undefined) {
          delete process.env.RAILWAY_PROJECT_ID;
        } else {
          process.env.RAILWAY_PROJECT_ID = prevRailwayProject;
        }
      }
    });
  });
});
