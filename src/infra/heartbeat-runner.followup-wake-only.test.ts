import { describe, expect, it, vi } from "vitest";
import { resetSystemEventsForTest, enqueueSystemEvent, peekSystemEvents } from "./system-events.js";

// We mock the outbound delivery to avoid network/plugin dependencies.
vi.mock("./outbound/deliver.js", () => ({
  deliverOutboundPayloads: vi.fn(async () => undefined),
}));

// Mock the LLM reply function to avoid model calls.
vi.mock("../auto-reply/reply.js", () => ({
  getReplyFromConfig: vi.fn(async () => ({ payload: { text: "HEARTBEAT_OK" } })),
}));

import { runHeartbeatOnce } from "./heartbeat-runner.ts";

describe("heartbeat runner followup wake-only", () => {
  it("does not drain system events for followup wake reasons", async () => {
    resetSystemEventsForTest();
    const sessionKey = "global";

    enqueueSystemEvent("one", { sessionKey });
    enqueueSystemEvent("two", { sessionKey });

    const cfg = {
      agents: {
        defaults: {
          heartbeat: {
            every: "30m",
            target: "last",
          },
        },
      },
      channels: {},
      session: { scope: "global" },
    } as const;

    const deps = {
      deliver: vi.fn(),
    } as const;

    await runHeartbeatOnce({
      cfg: cfg as unknown as Parameters<typeof runHeartbeatOnce>[0]["cfg"],
      agentId: "main",
      reason: "followup:xyz",
      deps: deps as unknown as Parameters<typeof runHeartbeatOnce>[0]["deps"],
    });

    // Events should still be present because followup wakes are wake-only.
    expect(peekSystemEvents(sessionKey)).toEqual(["one", "two"]);
  });
});
