import { describe, expect, it } from "vitest";
import { sessionKeysMatch } from "../../packages/webchat/src/session-keys.js";

describe("webchat sessionKeysMatch", () => {
  it("matches identical keys case-insensitively", () => {
    expect(sessionKeysMatch("MAIN", "main")).toBe(true);
  });

  it("matches canonical and bare keys for the same session rest", () => {
    expect(sessionKeysMatch("agent:codex:main", "main")).toBe(true);
    expect(sessionKeysMatch("main", "agent:codex:main")).toBe(true);
  });

  it("does not match canonical keys for different agents", () => {
    expect(sessionKeysMatch("agent:codex:main", "agent:other:main")).toBe(false);
  });

  it("does not match canonical key against different bare key", () => {
    expect(sessionKeysMatch("agent:codex:main", "other")).toBe(false);
  });
});
