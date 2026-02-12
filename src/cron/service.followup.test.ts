import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-followup-"));
  return {
    storePath: path.join(dir, "cron", "jobs.json"),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

describe("CronService followup jobs", () => {
  it("removes followup job after non-heartbeat reply", async () => {
    const store = await makeStorePath();
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok",
      summary: "done",
      heartbeatOnly: false,
    }));
    const cron = new CronService({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
    });
    await cron.start();
    const job = await cron.add({
      name: "followup",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "hello" },
      followup: { stopOnReply: true, expiresAtMs: Date.now() + 60_000 },
    });

    const result = await cron.run(job.id, "force");
    expect(result).toEqual({ ok: true, ran: true });
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);

    const jobs = await cron.list({ includeDisabled: true });
    expect(jobs.find((entry) => entry.id === job.id)).toBeUndefined();

    cron.stop();
    await store.cleanup();
  });

  it("keeps followup job when reply is heartbeat-only", async () => {
    const store = await makeStorePath();
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok",
      summary: "waiting",
      heartbeatOnly: true,
    }));
    const cron = new CronService({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
    });
    await cron.start();
    const job = await cron.add({
      name: "followup-wait",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "hello" },
      followup: { stopOnReply: true, expiresAtMs: Date.now() + 60_000 },
    });

    const result = await cron.run(job.id, "force");
    expect(result).toEqual({ ok: true, ran: true });
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);

    const jobs = await cron.list({ includeDisabled: true });
    expect(jobs.find((entry) => entry.id === job.id)).toBeDefined();

    cron.stop();
    await store.cleanup();
  });

  it("removes expired followup job without running", async () => {
    const store = await makeStorePath();
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" }));
    const cron = new CronService({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
    });
    await cron.start();
    const job = await cron.add({
      name: "followup-expired",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "hello" },
      followup: { stopOnReply: true, expiresAtMs: Date.now() - 60_000 },
    });

    const result = await cron.run(job.id, "force");
    expect(result).toEqual({ ok: true, ran: false, reason: "not-due" });
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();

    const jobs = await cron.list({ includeDisabled: true });
    expect(jobs.find((entry) => entry.id === job.id)).toBeUndefined();

    cron.stop();
    await store.cleanup();
  });
});
