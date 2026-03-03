import { describe, expect, it } from "vitest";
import { shouldRetryWithSelfDiagnosticGuard } from "./self-diagnostic-guard.js";

describe("shouldRetryWithSelfDiagnosticGuard", () => {
  it("requests a retry when the assistant tells the user to run a command", () => {
    const shouldRetry = shouldRetryWithSelfDiagnosticGuard({
      assistantTexts: ["请你先在服务器上执行 `openclaw logs --follow`，把输出发我。"],
      toolMetas: [],
    });

    expect(shouldRetry).toBe(true);
  });

  it("requests a retry for direct English delegation with command snippets", () => {
    const shouldRetry = shouldRetryWithSelfDiagnosticGuard({
      assistantTexts: ["Can you run this command first?\n\nnpm i -g clawhub"],
      toolMetas: [],
    });

    expect(shouldRetry).toBe(true);
  });

  it("does not retry when the run already used tools locally", () => {
    const shouldRetry = shouldRetryWithSelfDiagnosticGuard({
      assistantTexts: ["Please run this command: openclaw status"],
      toolMetas: [{ toolName: "exec", meta: "openclaw status" }],
    });

    expect(shouldRetry).toBe(false);
  });

  it("does not retry when the previous tool error is permission-blocked", () => {
    const shouldRetry = shouldRetryWithSelfDiagnosticGuard({
      assistantTexts: ["Please run this command: apt-get install -y libnss3"],
      toolMetas: [],
      lastToolError: { toolName: "exec", error: "permission denied: sandbox policy blocked" },
    });

    expect(shouldRetry).toBe(false);
  });

  it("does not retry when tools are disabled", () => {
    const shouldRetry = shouldRetryWithSelfDiagnosticGuard({
      assistantTexts: ["Can you run this command?\nopenclaw config validate"],
      toolMetas: [],
      disableTools: true,
    });

    expect(shouldRetry).toBe(false);
  });

  it("does not retry for generic questions without delegation", () => {
    const shouldRetry = shouldRetryWithSelfDiagnosticGuard({
      assistantTexts: ["I can check this next. Let me know if you want me to proceed."],
      toolMetas: [],
    });

    expect(shouldRetry).toBe(false);
  });
});
