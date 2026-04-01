import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";

const maybeInferMissingUserProfileFieldsMock = vi.hoisted(() => vi.fn());

vi.mock("../agents/profile-inference.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/profile-inference.js")>(
    "../agents/profile-inference.js",
  );
  return {
    ...actual,
    maybeInferMissingUserProfileFields: (...args: unknown[]) =>
      maybeInferMissingUserProfileFieldsMock(...args),
  };
});

installHeartbeatRunnerTestRuntime();

describe("heartbeat profile inference sidecar", () => {
  beforeEach(() => {
    process.env.TZ = "UTC";
    maybeInferMissingUserProfileFieldsMock.mockReset();
    maybeInferMissingUserProfileFieldsMock.mockResolvedValue({
      attemptedLanguage: true,
      attemptedTimezone: true,
      languageStatus: "inferred",
      timezoneStatus: "present",
    });
  });

  it("runs the profile inference sidecar before the heartbeat agent turn", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-heartbeat-profile-"));
    try {
      const workspaceDir = path.join(tmpDir, "workspace");
      const sessionsDir = path.join(tmpDir, "sessions");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(sessionsDir, { recursive: true });
      const storePath = path.join(sessionsDir, "sessions.json");

      await fs.writeFile(path.join(workspaceDir, "USER.md"), "# USER.md\n", "utf-8");
      await fs.writeFile(path.join(workspaceDir, "HEARTBEAT.md"), "- Check in\n", "utf-8");
      await fs.writeFile(
        storePath,
        JSON.stringify({
          "agent:main:main": {
            sessionId: "hb-profile",
            sessionFile: path.join(sessionsDir, "hb-profile.jsonl"),
            updatedAt: Date.now(),
            chatType: "direct",
            lastChannel: "whatsapp",
            lastTo: "12345",
          },
        }),
        "utf-8",
      );

      const cfg = {
        session: { store: storePath },
        agents: {
          defaults: {
            workspace: workspaceDir,
            heartbeat: { every: "5m", target: "none" },
          },
        },
      } as OpenClawConfig;

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        deps: { nowMs: () => Date.UTC(2026, 3, 5, 0, 0, 0) },
      });

      expect(result.status).toBe("ran");
      expect(maybeInferMissingUserProfileFieldsMock).toHaveBeenCalledTimes(1);
      expect(maybeInferMissingUserProfileFieldsMock).toHaveBeenCalledWith({
        cfg,
        agentId: "main",
        workspaceDir,
        storePath,
        nowMs: Date.UTC(2026, 3, 5, 0, 0, 0),
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
