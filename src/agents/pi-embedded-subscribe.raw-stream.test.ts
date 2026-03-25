import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";

const mkdirSync = vi.fn();
const appendFile = vi.fn();

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const defaultFs = "default" in actual ? actual.default : actual;
  return {
    ...actual,
    default: {
      ...defaultFs,
      mkdirSync,
      promises: {
        ...defaultFs.promises,
        appendFile,
      },
    },
  };
});

vi.mock("../config/paths.js", () => ({
  resolveStateDir: () => "/state",
}));

describe("appendRawStream", () => {
  beforeEach(() => {
    vi.resetModules();
    mkdirSync.mockReset();
    appendFile.mockReset();
    appendFile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes all events by default when raw stream logging is enabled", async () => {
    await withEnvAsync(
      {
        OPENCLAW_RAW_STREAM: "1",
        OPENCLAW_RAW_STREAM_MODE: undefined,
        OPENCLAW_RAW_STREAM_PATH: undefined,
      },
      async () => {
        const { appendRawStream } = await import("./pi-embedded-subscribe.raw-stream.js");

        appendRawStream({
          event: "assistant_text_stream",
          evtType: "text_delta",
          delta: "hi",
        });

        expect(mkdirSync).toHaveBeenCalledWith("/state/logs", { recursive: true });
        expect(appendFile).toHaveBeenCalledWith(
          "/state/logs/raw-stream.jsonl",
          `${JSON.stringify({ event: "assistant_text_stream", evtType: "text_delta", delta: "hi" })}\n`,
        );
      },
    );
  });

  it("keeps only final assistant messages in final mode", async () => {
    await withEnvAsync(
      {
        OPENCLAW_RAW_STREAM: "1",
        OPENCLAW_RAW_STREAM_MODE: "final",
        OPENCLAW_RAW_STREAM_PATH: "/tmp/raw-stream.jsonl",
      },
      async () => {
        const { appendRawStream } = await import("./pi-embedded-subscribe.raw-stream.js");

        appendRawStream({
          event: "assistant_text_stream",
          evtType: "text_delta",
          delta: "ignore me",
        });
        appendRawStream({
          event: "assistant_message_end",
          rawText: "keep me",
        });

        expect(mkdirSync).toHaveBeenCalledTimes(1);
        expect(mkdirSync).toHaveBeenCalledWith("/tmp", { recursive: true });
        expect(appendFile).toHaveBeenCalledTimes(1);
        expect(appendFile).toHaveBeenCalledWith(
          "/tmp/raw-stream.jsonl",
          `${JSON.stringify({ event: "assistant_message_end", rawText: "keep me" })}\n`,
        );
      },
    );
  });

  it("falls back to full mode for invalid mode values and warns once", async () => {
    await withEnvAsync(
      {
        OPENCLAW_RAW_STREAM: "1",
        OPENCLAW_RAW_STREAM_MODE: "nope",
        OPENCLAW_RAW_STREAM_PATH: undefined,
      },
      async () => {
        const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
        const { appendRawStream } = await import("./pi-embedded-subscribe.raw-stream.js");

        appendRawStream({ event: "assistant_text_stream", evtType: "text_delta", delta: "a" });
        appendRawStream({ event: "assistant_text_stream", evtType: "text_delta", delta: "b" });

        expect(stderrWrite).toHaveBeenCalledTimes(1);
        expect(stderrWrite).toHaveBeenCalledWith(
          '[openclaw] Ignoring invalid OPENCLAW_RAW_STREAM_MODE="nope" (allowed: full|final).\n',
        );
        expect(appendFile).toHaveBeenCalledTimes(2);
      },
    );
  });
});
