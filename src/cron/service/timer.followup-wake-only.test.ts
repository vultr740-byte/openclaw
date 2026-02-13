import { describe, expect, it, vi } from "vitest";
import type { CronJob } from "../types.js";
import { executeJob } from "./timer.js";

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  const now = Date.now();
  return {
    id: "job-1",
    name: "test",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "at", at: new Date(now + 1000).toISOString() },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "Hello" },
    state: {},
    ...overrides,
  } as CronJob;
}

describe("cron timer followup wake-only", () => {
  it("does not enqueueSystemEvent or requestHeartbeatNow for followup jobs", async () => {
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    const state = {
      deps: {
        nowMs: () => Date.now(),
        cronEnabled: true,
        cronConfig: {},
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        enqueueSystemEvent,
        requestHeartbeatNow,
        runHeartbeatOnce: vi.fn(),
      },
      store: { version: 1, jobs: [] as CronJob[] },
      timer: null,
      running: false,
    } satisfies {
      deps: {
        nowMs: () => number;
        cronEnabled: boolean;
        cronConfig: unknown;
        log: {
          debug: (...args: unknown[]) => void;
          info: (...args: unknown[]) => void;
          warn: (...args: unknown[]) => void;
          error: (...args: unknown[]) => void;
        };
        enqueueSystemEvent: typeof enqueueSystemEvent;
        requestHeartbeatNow: typeof requestHeartbeatNow;
        runHeartbeatOnce: (...args: unknown[]) => unknown;
      };
      store: { version: 1; jobs: CronJob[] };
      timer: unknown;
      running: boolean;
    };

    const cronState = state as unknown as Parameters<typeof executeJob>[0];

    const job = makeJob({ followup: { stopOnReply: true } });
    state.store.jobs.push(job);

    await executeJob(cronState, job, Date.now(), { forced: false });

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeatNow).not.toHaveBeenCalled();
  });
});
