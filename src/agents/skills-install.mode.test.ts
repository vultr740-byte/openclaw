import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTempWorkspace } from "./skills-install.download-test-utils.js";
import { installSkill } from "./skills-install.js";
import {
  hasBinaryMock,
  runCommandWithTimeoutMock,
  scanDirectoryWithSummaryMock,
} from "./skills-install.test-mocks.js";

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

vi.mock("../shared/config-eval.js", async () => {
  const actual = await vi.importActual<typeof import("../shared/config-eval.js")>(
    "../shared/config-eval.js",
  );
  return {
    ...actual,
    hasBinary: (bin: string) => hasBinaryMock(bin),
  };
});

vi.mock("../security/skill-scanner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../security/skill-scanner.js")>()),
  scanDirectoryWithSummary: (...args: unknown[]) => scanDirectoryWithSummaryMock(...args),
}));

async function writeInstallSkill(
  workspaceDir: string,
  name: string,
  installSpec: Record<string, string>,
): Promise<void> {
  const skillDir = path.join(workspaceDir, "skills", name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: ${name}
description: test skill
metadata: ${JSON.stringify({ openclaw: { install: [{ id: "deps", ...installSpec }] } })}
---

# ${name}
`,
    "utf-8",
  );
}

function findNpmInstallArgv(): string[] {
  const call = findInstallCall("npm");
  if (!call) {
    throw new Error("npm install call not found");
  }
  return call[0];
}

function findInstallCall(
  executable: string,
): [string[], { timeoutMs?: number; env?: Record<string, string | undefined> }] | undefined {
  return runCommandWithTimeoutMock.mock.calls.find(
    (entry) => Array.isArray(entry[0]) && entry[0][0] === executable,
  ) as [string[], { timeoutMs?: number; env?: Record<string, string | undefined> }] | undefined;
}

describe("skills-install install mode", () => {
  beforeEach(() => {
    runCommandWithTimeoutMock.mockClear();
    scanDirectoryWithSummaryMock.mockClear();
    hasBinaryMock.mockClear();
    hasBinaryMock.mockReturnValue(false);
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
      await writeInstallSkill(workspaceDir, "pkg-skill", {
        kind: "node",
        package: "example-package",
      });
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
      await writeInstallSkill(workspaceDir, "pkg-skill-ws", {
        kind: "node",
        package: "example-package",
      });
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
      await writeInstallSkill(workspaceDir, "pkg-skill-global", {
        kind: "node",
        package: "example-package",
      });
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

  it("auto mode localizes pnpm installs to the runtime prefix", async () => {
    await withTempWorkspace(async ({ workspaceDir, stateDir }) => {
      await writeInstallSkill(workspaceDir, "pkg-skill-pnpm", {
        kind: "node",
        package: "example-package",
      });
      const prevRailwayProject = process.env.RAILWAY_PROJECT_ID;
      process.env.RAILWAY_PROJECT_ID = "project-id";
      try {
        const result = await installSkill({
          workspaceDir,
          skillName: "pkg-skill-pnpm",
          installId: "deps",
          config: {
            skills: {
              install: {
                mode: "auto",
                nodeManager: "pnpm",
              },
            },
          },
        });
        expect(result.ok).toBe(true);
        const call = findInstallCall("pnpm");
        expect(call?.[0]).toEqual([
          "pnpm",
          "add",
          "-g",
          "--global-dir",
          path.join(stateDir, "tools", "runtime"),
          "--global-bin-dir",
          path.join(stateDir, "tools", "runtime", "bin"),
          "--ignore-scripts",
          "example-package",
        ]);
      } finally {
        if (prevRailwayProject === undefined) {
          delete process.env.RAILWAY_PROJECT_ID;
        } else {
          process.env.RAILWAY_PROJECT_ID = prevRailwayProject;
        }
      }
    });
  });

  it("auto mode localizes bun installs via BUN_INSTALL", async () => {
    await withTempWorkspace(async ({ workspaceDir, stateDir }) => {
      await writeInstallSkill(workspaceDir, "pkg-skill-bun", {
        kind: "node",
        package: "example-package",
      });
      const prevRailwayProject = process.env.RAILWAY_PROJECT_ID;
      process.env.RAILWAY_PROJECT_ID = "project-id";
      try {
        const result = await installSkill({
          workspaceDir,
          skillName: "pkg-skill-bun",
          installId: "deps",
          config: {
            skills: {
              install: {
                mode: "auto",
                nodeManager: "bun",
              },
            },
          },
        });
        expect(result.ok).toBe(true);
        const call = findInstallCall("bun");
        expect(call?.[0]).toEqual(["bun", "add", "-g", "--ignore-scripts", "example-package"]);
        expect(call?.[1]?.env).toEqual({
          BUN_INSTALL: path.join(stateDir, "tools", "runtime"),
        });
      } finally {
        if (prevRailwayProject === undefined) {
          delete process.env.RAILWAY_PROJECT_ID;
        } else {
          process.env.RAILWAY_PROJECT_ID = prevRailwayProject;
        }
      }
    });
  });

  it("auto mode directs go installs into the runtime bin directory", async () => {
    await withTempWorkspace(async ({ workspaceDir, stateDir }) => {
      await writeInstallSkill(workspaceDir, "pkg-skill-go", {
        kind: "go",
        module: "example.com/tool@latest",
      });
      hasBinaryMock.mockImplementation((bin: string) => bin === "go");
      const prevRailwayProject = process.env.RAILWAY_PROJECT_ID;
      process.env.RAILWAY_PROJECT_ID = "project-id";
      try {
        const result = await installSkill({
          workspaceDir,
          skillName: "pkg-skill-go",
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
        const call = findInstallCall("go");
        expect(call?.[0]).toEqual(["go", "install", "example.com/tool@latest"]);
        expect(call?.[1]?.env).toEqual({
          GOBIN: path.join(stateDir, "tools", "runtime", "bin"),
        });
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
