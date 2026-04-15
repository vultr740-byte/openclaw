import { beforeEach, describe, expect, it, vi } from "vitest";

const requireSpy = vi.hoisted(() => vi.fn());
const jitiLoadSpy = vi.hoisted(() => vi.fn());

vi.mock("node:module", async () => {
  const actualModule = await vi.importActual<typeof import("node:module")>("node:module");
  const actualJiti = await vi.importActual<typeof import("jiti")>("jiti");

  return Object.assign({}, actualModule, {
    createRequire: () =>
      ((specifier: string) => {
        requireSpy(specifier);
        if (specifier === "jiti") {
          return Object.assign({}, actualJiti, {
            createJiti: (...args: Parameters<typeof actualJiti.createJiti>) => {
              const actualLoader = actualJiti.createJiti(...args);
              return (target: string) => {
                jitiLoadSpy(target);
                return actualLoader(target);
              };
            },
          });
        }
        return actualModule.createRequire(import.meta.url)(specifier);
      }) as NodeJS.Require,
  });
});

import { createRuntimeChannel } from "./runtime-channel.js";

function endsWithRuntimeSection(target: string, suffix: string): boolean {
  return target.endsWith(`${suffix}.ts`) || target.endsWith(`${suffix}.js`);
}

describe("runtimeContexts", () => {
  beforeEach(() => {
    requireSpy.mockClear();
    jitiLoadSpy.mockClear();
  });

  it("loads telegram section without loading discord section", () => {
    const runtime = createRuntimeChannel();

    expect(requireSpy).not.toHaveBeenCalledWith("jiti");

    expect(typeof runtime.telegram.monitorTelegramProvider).toBe("function");

    expect(requireSpy).toHaveBeenCalledWith("jiti");
    const loadedTargets = jitiLoadSpy.mock.calls.map(([target]) => String(target));
    expect(
      loadedTargets.some((target) => endsWithRuntimeSection(target, "runtime-channel-telegram")),
    ).toBe(true);
    expect(
      loadedTargets.some((target) => endsWithRuntimeSection(target, "runtime-channel-discord")),
    ).toBe(false);
  });

  it("registers, resolves, watches, and unregisters contexts", () => {
    const channel = createRuntimeChannel();
    const onEvent = vi.fn();
    const unsubscribe = channel.runtimeContexts.watch({
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      onEvent,
    });

    const lease = channel.runtimeContexts.register({
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      context: { client: "ok" },
    });

    expect(
      channel.runtimeContexts.get<{ client: string }>({
        channelId: "matrix",
        accountId: "default",
        capability: "approval.native",
      }),
    ).toEqual({ client: "ok" });
    expect(onEvent).toHaveBeenCalledWith({
      type: "registered",
      key: {
        channelId: "matrix",
        accountId: "default",
        capability: "approval.native",
      },
      context: { client: "ok" },
    });

    lease.dispose();

    expect(
      channel.runtimeContexts.get({
        channelId: "matrix",
        accountId: "default",
        capability: "approval.native",
      }),
    ).toBeUndefined();
    expect(onEvent).toHaveBeenLastCalledWith({
      type: "unregistered",
      key: {
        channelId: "matrix",
        accountId: "default",
        capability: "approval.native",
      },
    });

    unsubscribe();
  });

  it("auto-disposes registrations when the abort signal fires", () => {
    const channel = createRuntimeChannel();
    const controller = new AbortController();
    const lease = channel.runtimeContexts.register({
      channelId: "telegram",
      accountId: "default",
      capability: "approval.native",
      context: { token: "abc" },
      abortSignal: controller.signal,
    });

    controller.abort();

    expect(
      channel.runtimeContexts.get({
        channelId: "telegram",
        accountId: "default",
        capability: "approval.native",
      }),
    ).toBeUndefined();
    lease.dispose();
  });

  it("does not register contexts when the abort signal is already aborted", () => {
    const channel = createRuntimeChannel();
    const onEvent = vi.fn();
    const controller = new AbortController();
    controller.abort();
    channel.runtimeContexts.watch({
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      onEvent,
    });

    const lease = channel.runtimeContexts.register({
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      context: { client: "stale" },
      abortSignal: controller.signal,
    });

    expect(
      channel.runtimeContexts.get({
        channelId: "matrix",
        accountId: "default",
        capability: "approval.native",
      }),
    ).toBeUndefined();
    expect(onEvent).not.toHaveBeenCalled();
    lease.dispose();
  });

  it("isolates watcher exceptions so registration and disposal still complete", () => {
    const channel = createRuntimeChannel();
    const badWatcher = vi.fn((event) => {
      throw new Error(`boom:${event.type}`);
    });
    const goodWatcher = vi.fn();

    channel.runtimeContexts.watch({
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      onEvent: badWatcher,
    });
    channel.runtimeContexts.watch({
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      onEvent: goodWatcher,
    });

    const lease = channel.runtimeContexts.register({
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      context: { client: "ok" },
    });

    expect(
      channel.runtimeContexts.get({
        channelId: "matrix",
        accountId: "default",
        capability: "approval.native",
      }),
    ).toEqual({ client: "ok" });
    expect(badWatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "registered",
      }),
    );
    expect(goodWatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "registered",
      }),
    );

    lease.dispose();

    expect(
      channel.runtimeContexts.get({
        channelId: "matrix",
        accountId: "default",
        capability: "approval.native",
      }),
    ).toBeUndefined();
    expect(badWatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "unregistered",
      }),
    );
    expect(goodWatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "unregistered",
      }),
    );
  });

  it("auto-disposes when a watcher aborts during the registered event", () => {
    const channel = createRuntimeChannel();
    const controller = new AbortController();
    const onEvent = vi.fn((event) => {
      if (event.type === "registered") {
        controller.abort();
      }
    });

    channel.runtimeContexts.watch({
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      onEvent,
    });

    const lease = channel.runtimeContexts.register({
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      context: { client: "ok" },
      abortSignal: controller.signal,
    });

    expect(
      channel.runtimeContexts.get({
        channelId: "matrix",
        accountId: "default",
        capability: "approval.native",
      }),
    ).toBeUndefined();
    expect(onEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: "registered",
      }),
    );
    expect(onEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: "unregistered",
      }),
    );

    lease.dispose();
  });
});
