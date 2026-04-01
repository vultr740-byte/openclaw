import fs from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { makeTempWorkspace, writeWorkspaceFile } from "../test-helpers/workspace.js";
import {
  readWorkspaceOnboardingStateForDir,
  writeWorkspaceOnboardingStateForDir,
} from "./workspace.js";

const runEmbeddedPiAgentMock = vi.hoisted(() => vi.fn());

vi.mock("./pi-embedded.js", () => ({
  runEmbeddedPiAgent: (...args: unknown[]) => runEmbeddedPiAgentMock(...args),
}));

import { maybeInferMissingUserProfileFields } from "./profile-inference.js";

const baseConfig = (workspaceDir: string): OpenClawConfig =>
  ({
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: { primary: "openai/gpt-5.2" },
      },
    },
  }) as OpenClawConfig;

async function createSessionTranscript(params: {
  dir: string;
  sessionId: string;
  messages: Array<{
    role: "user" | "assistant";
    text: string;
    timestampMs: number;
    provenance?: unknown;
  }>;
}): Promise<string> {
  const sessionFile = path.join(params.dir, `${params.sessionId}.jsonl`);
  const session = SessionManager.open(sessionFile);
  for (const message of params.messages) {
    if (message.role === "user") {
      session.appendMessage({
        role: "user",
        content: [{ type: "text", text: message.text }],
        timestamp: message.timestampMs,
        ...(message.provenance ? { provenance: message.provenance } : {}),
      });
      continue;
    }
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: message.text }],
      provider: "openclaw",
      model: "test-model",
      api: "openai-responses",
      stopReason: "stop",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      timestamp: message.timestampMs,
    });
  }
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "flush" }],
    provider: "openclaw",
    model: "test-model",
    api: "openai-responses",
    stopReason: "stop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    timestamp: params.messages.at(-1)?.timestampMs ?? Date.now(),
  });
  return sessionFile;
}

beforeEach(() => {
  runEmbeddedPiAgentMock.mockReset();
});

describe("maybeInferMissingUserProfileFields", () => {
  it("runs a one-time agent task and records inferred statuses", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-profile-inference-");
    const sessionsDir = path.join(workspaceDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    await writeWorkspaceFile({
      dir: workspaceDir,
      name: "USER.md",
      content: ["# USER.md - About Your Human", "", "Free-form notes here.", ""].join("\n"),
    });

    const sessionId = "dm-session";
    const sessionFile = await createSessionTranscript({
      dir: sessionsDir,
      sessionId,
      messages: Array.from({ length: 4 }, (_, index) => ({
        role: "user" as const,
        text: `你好，我现在方便聊这个需求，第${index + 1}条消息。`,
        timestampMs: Date.UTC(2026, 0, index + 1, index + 1, 0, 0),
      })),
    });
    const storePath = path.join(sessionsDir, "sessions.json");
    await fs.writeFile(
      storePath,
      JSON.stringify({
        "agent:main:direct:user-1": {
          sessionId,
          sessionFile,
          updatedAt: Date.now(),
          chatType: "direct",
        },
      }),
      "utf-8",
    );

    await fs.writeFile(
      path.join(workspaceDir, "USER.md"),
      [
        "# USER.md - About Your Human",
        "",
        "- Preferred language: zh",
        "- Timezone: Asia/Shanghai",
        "",
      ].join("\n"),
      "utf-8",
    );

    runEmbeddedPiAgentMock
      .mockResolvedValueOnce({
        payloads: [
          {
            text: '{"language":"unknown","timezone":"unknown"}',
          },
        ],
        meta: { durationMs: 10 },
      })
      .mockResolvedValueOnce({
        payloads: [
          {
            text: '{"language":"inferred","timezone":"inferred"}',
          },
        ],
        meta: { durationMs: 10 },
      });

    const result = await maybeInferMissingUserProfileFields({
      cfg: baseConfig(workspaceDir),
      agentId: "main",
      workspaceDir,
      storePath,
      nowMs: Date.UTC(2026, 3, 1, 0, 0, 0),
    });

    expect(result).toEqual({
      attemptedLanguage: true,
      attemptedTimezone: true,
      languageStatus: "inferred",
      timezoneStatus: "inferred",
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(2);
    const inspectionCall = runEmbeddedPiAgentMock.mock.calls[0]?.[0] as {
      prompt: string;
    };
    const inferenceCall = runEmbeddedPiAgentMock.mock.calls[1]?.[0] as {
      prompt: string;
      workspaceDir: string;
      agentId: string;
      trigger: string;
    };
    expect(inspectionCall.prompt).toContain("Do not infer from transcript history in this pass.");
    expect(inspectionCall.prompt).not.toContain("Transcript evidence from recent direct messages:");
    expect(inferenceCall.workspaceDir).toBe(workspaceDir);
    expect(inferenceCall.agentId).toBe("main");
    expect(inferenceCall.trigger).toBe("heartbeat");
    expect(inferenceCall.prompt).toContain("Read USER.md from the workspace.");
    expect(inferenceCall.prompt).toContain("Transcript evidence from recent direct messages:");
    expect(inferenceCall.prompt).toContain("你好，我现在方便聊这个需求");

    const state = await readWorkspaceOnboardingStateForDir(workspaceDir);
    expect(state.languageInferenceAttemptedAt).toBe("2026-04-01T00:00:00.000Z");
    expect(state.timezoneInferenceAttemptedAt).toBe("2026-04-01T00:00:00.000Z");
  });

  it("skips once both attempt markers already exist", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-profile-inference-");
    await writeWorkspaceFile({
      dir: workspaceDir,
      name: "USER.md",
      content: "# USER.md - About Your Human\n",
    });
    await writeWorkspaceOnboardingStateForDir(workspaceDir, {
      version: 1,
      languageInferenceAttemptedAt: "2026-04-01T00:00:00.000Z",
      timezoneInferenceAttemptedAt: "2026-04-01T00:00:00.000Z",
    });

    const result = await maybeInferMissingUserProfileFields({
      cfg: baseConfig(workspaceDir),
      agentId: "main",
      workspaceDir,
      storePath: path.join(workspaceDir, "sessions", "sessions.json"),
      nowMs: Date.UTC(2026, 3, 2, 0, 0, 0),
    });

    expect(result).toEqual({
      attemptedLanguage: false,
      attemptedTimezone: false,
    });
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  });

  it("passes only recent direct-user evidence to the agent", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-profile-inference-");
    const sessionsDir = path.join(workspaceDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    await writeWorkspaceFile({
      dir: workspaceDir,
      name: "USER.md",
      content: "# USER.md - About Your Human\n",
    });

    const dmSessionFile = await createSessionTranscript({
      dir: sessionsDir,
      sessionId: "dm-1",
      messages: [
        {
          role: "user",
          text: "你好，这条是转发的，不应该参与推断",
          timestampMs: Date.UTC(2026, 0, 1, 2, 0, 0),
          provenance: { kind: "inter_session" },
        },
        {
          role: "user",
          text: "hola this direct message should stay",
          timestampMs: Date.UTC(2026, 0, 2, 14, 0, 0),
        },
      ],
    });
    const groupSessionFile = await createSessionTranscript({
      dir: sessionsDir,
      sessionId: "group-1",
      messages: [
        {
          role: "user",
          text: "group message should be ignored",
          timestampMs: Date.UTC(2026, 0, 3, 14, 0, 0),
        },
      ],
    });
    const storePath = path.join(sessionsDir, "sessions.json");
    await fs.writeFile(
      storePath,
      JSON.stringify({
        "agent:main:direct:user-3": {
          sessionId: "dm-1",
          sessionFile: dmSessionFile,
          updatedAt: Date.now(),
          chatType: "direct",
        },
        "agent:main:telegram:group:-100123": {
          sessionId: "group-1",
          sessionFile: groupSessionFile,
          updatedAt: Date.now(),
          chatType: "group",
        },
      }),
      "utf-8",
    );

    runEmbeddedPiAgentMock
      .mockResolvedValueOnce({
        payloads: [
          {
            text: '{"language":"unknown","timezone":"unknown"}',
          },
        ],
        meta: { durationMs: 10 },
      })
      .mockResolvedValueOnce({
        payloads: [
          {
            text: '{"language":"unknown","timezone":"unknown"}',
          },
        ],
        meta: { durationMs: 10 },
      });

    const result = await maybeInferMissingUserProfileFields({
      cfg: baseConfig(workspaceDir),
      agentId: "main",
      workspaceDir,
      storePath,
      nowMs: Date.UTC(2026, 3, 4, 0, 0, 0),
    });

    expect(result).toEqual({
      attemptedLanguage: true,
      attemptedTimezone: true,
      languageStatus: "unknown",
      timezoneStatus: "unknown",
    });

    const inspectionCall = runEmbeddedPiAgentMock.mock.calls[0]?.[0] as { prompt: string };
    const inferenceCall = runEmbeddedPiAgentMock.mock.calls[1]?.[0] as { prompt: string };
    expect(inspectionCall.prompt).not.toContain("hola this direct message should stay");
    expect(inferenceCall.prompt).toContain("hola this direct message should stay");
    expect(inferenceCall.prompt).not.toContain("group message should be ignored");
    expect(inferenceCall.prompt).not.toContain("这条是转发的");
  });

  it("stops after inspection when USER.md already expresses both fields", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-profile-inference-");
    await writeWorkspaceFile({
      dir: workspaceDir,
      name: "USER.md",
      content: ["# USER.md", "", "- Prefers Chinese", "- Based in Asia/Shanghai", ""].join("\n"),
    });

    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [
        {
          text: '{"language":"present","timezone":"present"}',
        },
      ],
      meta: { durationMs: 10 },
    });

    const result = await maybeInferMissingUserProfileFields({
      cfg: baseConfig(workspaceDir),
      agentId: "main",
      workspaceDir,
      storePath: path.join(workspaceDir, "sessions", "sessions.json"),
      nowMs: Date.UTC(2026, 3, 6, 0, 0, 0),
    });

    expect(result).toEqual({
      attemptedLanguage: true,
      attemptedTimezone: true,
      languageStatus: "present",
      timezoneStatus: "present",
    });
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const onlyCall = runEmbeddedPiAgentMock.mock.calls[0]?.[0] as { prompt: string };
    expect(onlyCall.prompt).toContain("Do not infer from transcript history in this pass.");
    expect(onlyCall.prompt).not.toContain("Transcript evidence from recent direct messages:");
  });

  it("does not mark attempts when the agent run fails", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-profile-inference-");
    await writeWorkspaceFile({
      dir: workspaceDir,
      name: "USER.md",
      content: "# USER.md - About Your Human\n",
    });
    runEmbeddedPiAgentMock.mockRejectedValue(new Error("boom"));

    const result = await maybeInferMissingUserProfileFields({
      cfg: baseConfig(workspaceDir),
      agentId: "main",
      workspaceDir,
      storePath: path.join(workspaceDir, "sessions", "sessions.json"),
      nowMs: Date.UTC(2026, 3, 5, 0, 0, 0),
    });

    expect(result).toEqual({
      attemptedLanguage: false,
      attemptedTimezone: false,
      languageStatus: undefined,
      timezoneStatus: undefined,
    });

    const state = await readWorkspaceOnboardingStateForDir(workspaceDir);
    expect(state.languageInferenceAttemptedAt).toBeUndefined();
    expect(state.timezoneInferenceAttemptedAt).toBeUndefined();
  });
});
