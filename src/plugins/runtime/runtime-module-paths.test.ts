import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRuntimeModuleCandidates } from "./runtime-module-paths.js";

describe("resolveRuntimeModuleCandidates", () => {
  it("includes dist/plugins/runtime fallback for hashed root chunks", () => {
    const candidates = resolveRuntimeModuleCandidates("file:///workspace/dist/runtime-abc123.js", [
      "runtime-channel.js",
      "runtime-channel.ts",
    ]);

    expect(candidates).toEqual([
      path.join("/workspace/dist", "runtime-channel.js"),
      path.join("/workspace/dist", "runtime-channel.ts"),
      path.join("/workspace/dist/plugins/runtime", "runtime-channel.js"),
      path.join("/workspace/dist/plugins/runtime", "runtime-channel.ts"),
    ]);
  });

  it("deduplicates fallback candidates when already in plugins runtime", () => {
    const candidates = resolveRuntimeModuleCandidates(
      "file:///workspace/dist/plugins/runtime/runtime-channel.js",
      ["runtime-channel-telegram.js", "runtime-channel-telegram.ts"],
    );

    expect(candidates).toEqual([
      path.join("/workspace/dist/plugins/runtime", "runtime-channel-telegram.js"),
      path.join("/workspace/dist/plugins/runtime", "runtime-channel-telegram.ts"),
    ]);
  });
});
