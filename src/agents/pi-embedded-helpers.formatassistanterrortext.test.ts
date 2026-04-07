import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import {
  BILLING_ERROR_USER_MESSAGE,
  formatBillingErrorMessage,
  formatAssistantErrorText,
  formatRawAssistantErrorForUi,
  resolveBillingRechargeUrl,
} from "./pi-embedded-helpers.js";
import { makeAssistantMessageFixture } from "./test-helpers/assistant-message-fixtures.js";

describe("formatAssistantErrorText", () => {
  const makeAssistantError = (errorMessage: string): AssistantMessage =>
    makeAssistantMessageFixture({
      errorMessage,
      content: [{ type: "text", text: errorMessage }],
    });

  it("returns a friendly message for context overflow", () => {
    const msg = makeAssistantError("request_too_large");
    expect(formatAssistantErrorText(msg)).toContain("Context overflow");
  });
  it("returns context overflow for Anthropic 'Request size exceeds model context window'", () => {
    // This is the new Anthropic error format that wasn't being detected.
    // Without the fix, this falls through to the invalidRequest regex and returns
    // "LLM request rejected: Request size exceeds model context window"
    // instead of the context overflow message, preventing auto-compaction.
    const msg = makeAssistantError(
      '{"type":"error","error":{"type":"invalid_request_error","message":"Request size exceeds model context window"}}',
    );
    expect(formatAssistantErrorText(msg)).toContain("Context overflow");
  });
  it("returns context overflow for Kimi 'model token limit' errors", () => {
    const msg = makeAssistantError(
      "error, status code: 400, message: Invalid request: Your request exceeded model token limit: 262144 (requested: 291351)",
    );
    expect(formatAssistantErrorText(msg)).toContain("Context overflow");
  });
  it("returns a reasoning-required message for mandatory reasoning endpoint errors", () => {
    const msg = makeAssistantError(
      "400 Reasoning is mandatory for this endpoint and cannot be disabled.",
    );
    const result = formatAssistantErrorText(msg);
    expect(result).toContain("Reasoning is required");
    expect(result).toContain("/think minimal");
    expect(result).not.toContain("Context overflow");
  });
  it("returns a friendly message for Anthropic role ordering", () => {
    const msg = makeAssistantError('messages: roles must alternate between "user" and "assistant"');
    expect(formatAssistantErrorText(msg)).toContain("Message ordering conflict");
  });
  it("returns a friendly message for Anthropic overload errors", () => {
    const msg = makeAssistantError(
      '{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_123"}',
    );
    expect(formatAssistantErrorText(msg)).toBe(
      "The AI service is temporarily overloaded. Please try again in a moment.",
    );
  });
  it("returns a recovery hint when tool call input is missing", () => {
    const msg = makeAssistantError("tool_use.input: Field required");
    const result = formatAssistantErrorText(msg);
    expect(result).toContain("Session history looks corrupted");
    expect(result).toContain("/new");
  });
  it("handles JSON-wrapped role errors", () => {
    const msg = makeAssistantError('{"error":{"message":"400 Incorrect role information"}}');
    const result = formatAssistantErrorText(msg);
    expect(result).toContain("Message ordering conflict");
    expect(result).not.toContain("400");
  });
  it("suppresses raw error JSON payloads that are not otherwise classified", () => {
    const msg = makeAssistantError(
      '{"type":"error","error":{"message":"Something exploded","type":"server_error"}}',
    );
    expect(formatAssistantErrorText(msg)).toBe("LLM error server_error: Something exploded");
  });
  it("returns a friendly billing message for credit balance errors", () => {
    const msg = makeAssistantError("Your credit balance is too low to access the Anthropic API.");
    const result = formatAssistantErrorText(msg);
    expect(result).toBe(BILLING_ERROR_USER_MESSAGE);
  });
  it("returns a friendly billing message for HTTP 402 errors", () => {
    const msg = makeAssistantError("HTTP 402 Payment Required");
    const result = formatAssistantErrorText(msg);
    expect(result).toBe(BILLING_ERROR_USER_MESSAGE);
  });
  it("returns a friendly billing message for 402 status code errors without a body", () => {
    const msg = makeAssistantError("402 status code (no body)");
    const result = formatAssistantErrorText(msg);
    expect(result).toBe(BILLING_ERROR_USER_MESSAGE);
  });
  it("returns a friendly billing message for insufficient credits", () => {
    const msg = makeAssistantError("insufficient credits");
    const result = formatAssistantErrorText(msg);
    expect(result).toBe(BILLING_ERROR_USER_MESSAGE);
  });
  it("keeps billing message generic when provider is given", () => {
    const msg = makeAssistantError("insufficient credits");
    const result = formatAssistantErrorText(msg, { provider: "Anthropic" });
    expect(result).toBe(formatBillingErrorMessage("Anthropic", "test-model"));
    expect(result).toBe(BILLING_ERROR_USER_MESSAGE);
    expect(result).not.toContain("Anthropic");
    expect(result).not.toContain("test-model");
  });
  it("does not expose the active assistant model in billing message context", () => {
    const msg = makeAssistantError("insufficient credits");
    msg.model = "claude-3-5-sonnet";
    const result = formatAssistantErrorText(msg, { provider: "Anthropic" });
    expect(result).toBe(formatBillingErrorMessage("Anthropic", "claude-3-5-sonnet"));
    expect(result).toBe(BILLING_ERROR_USER_MESSAGE);
    expect(result).not.toContain("Anthropic");
    expect(result).not.toContain("claude-3-5-sonnet");
  });
  it("returns generic billing message when provider is not given", () => {
    const msg = makeAssistantError("insufficient credits");
    const result = formatAssistantErrorText(msg);
    expect(result).toContain("Model balance is insufficient");
    expect(result).toBe(BILLING_ERROR_USER_MESSAGE);
  });
  it("keeps billing copy generic even when OPENCLAW_RECHARGE_TARGET is configured", () => {
    const msg = makeAssistantError("insufficient credits");
    const result = withEnv({ OPENCLAW_RECHARGE_TARGET: "weixin_cf69eddb0947fd8e" }, () =>
      formatAssistantErrorText(msg),
    );
    expect(result).toBe(BILLING_ERROR_USER_MESSAGE);
  });
  it("builds the recharge link from the normalized recharge target", () => {
    const result = withEnv({ OPENCLAW_RECHARGE_TARGET: "weixin_74339e895533e12f" }, () =>
      resolveBillingRechargeUrl(),
    );
    expect(result).toBe("https://www.xialiao.app/recharge/weixin_74339e895533e12f");
  });
  it("returns null when OPENCLAW_RECHARGE_TARGET is missing", () => {
    const result = withEnv({ OPENCLAW_RECHARGE_TARGET: "" }, () => resolveBillingRechargeUrl());
    expect(result).toBeNull();
  });
  it("still encodes path-breaking characters in the recharge link", () => {
    const result = withEnv({ OPENCLAW_RECHARGE_TARGET: "weixin account/with spaces" }, () =>
      resolveBillingRechargeUrl(),
    );
    expect(result).toBe("https://www.xialiao.app/recharge/weixin%20account%2Fwith%20spaces");
  });
  it("returns a friendly message for rate limit errors", () => {
    const msg = makeAssistantError("429 rate limit reached");
    expect(formatAssistantErrorText(msg)).toContain("rate limit reached");
  });

  it("returns a friendly message for empty stream chunk errors", () => {
    const msg = makeAssistantError("request ended without sending any chunks");
    expect(formatAssistantErrorText(msg)).toBe("LLM request timed out.");
  });
});

describe("formatRawAssistantErrorForUi", () => {
  it("renders HTTP code + type + message from Anthropic payloads", () => {
    const text = formatRawAssistantErrorForUi(
      '429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limited."},"request_id":"req_123"}',
    );

    expect(text).toContain("HTTP 429");
    expect(text).toContain("rate_limit_error");
    expect(text).toContain("Rate limited.");
    expect(text).toContain("req_123");
  });

  it("renders a generic unknown error message when raw is empty", () => {
    expect(formatRawAssistantErrorForUi("")).toContain("unknown error");
  });

  it("formats plain HTTP status lines", () => {
    expect(formatRawAssistantErrorForUi("500 Internal Server Error")).toBe(
      "HTTP 500: Internal Server Error",
    );
  });

  it("sanitizes HTML error pages into a clean unavailable message", () => {
    const htmlError = `521 <!DOCTYPE html>
<html lang="en-US">
  <head><title>Web server is down | example.com | Cloudflare</title></head>
  <body>Ray ID: abc123</body>
</html>`;

    expect(formatRawAssistantErrorForUi(htmlError)).toBe(
      "The AI service is temporarily unavailable (HTTP 521). Please try again in a moment.",
    );
  });
});
