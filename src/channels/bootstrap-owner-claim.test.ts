import { describe, expect, it } from "vitest";
import {
  normalizeBootstrapChannelId,
  parseBootstrapChannelIds,
  resolveBootstrapOwnerClaimModeForChannel,
  resolveRequestedBootstrapOwnerClaimMode,
  supportsBootstrapOwnerClaim,
} from "./bootstrap-owner-claim.js";

describe("bootstrap owner claim helpers", () => {
  it("normalizes bootstrap channel aliases", () => {
    expect(normalizeBootstrapChannelId("tg")).toBe("telegram");
    expect(normalizeBootstrapChannelId("qq")).toBe("qqbot");
    expect(normalizeBootstrapChannelId("weixin")).toBe("weixin");
    expect(normalizeBootstrapChannelId("discord")).toBe("discord");
  });

  it("parses and deduplicates bootstrap channel lists", () => {
    expect(parseBootstrapChannelIds("discord, tg;qqbot\nweixin;discord")).toEqual([
      "discord",
      "telegram",
      "qqbot",
      "weixin",
    ]);
  });

  it("defaults owner claim to off when no bootstrap channel is configured", () => {
    expect(resolveRequestedBootstrapOwnerClaimMode({})).toBe("off");
  });

  it("defaults owner claim to first-dm when bootstrap channels are configured", () => {
    expect(
      resolveRequestedBootstrapOwnerClaimMode({
        OPENCLAW_BOOTSTRAP_CHANNEL: "discord",
      }),
    ).toBe("first-dm");
  });

  it("respects explicit owner-claim opt-out and channel support", () => {
    expect(
      resolveBootstrapOwnerClaimModeForChannel("discord", {
        OPENCLAW_BOOTSTRAP_CHANNEL: "discord",
        OPENCLAW_BOOTSTRAP_OWNER_MODE: "off",
      }),
    ).toBe("off");
    expect(
      resolveBootstrapOwnerClaimModeForChannel("qqbot", {
        OPENCLAW_BOOTSTRAP_CHANNEL: "qq",
      }),
    ).toBe("off");
    expect(
      resolveBootstrapOwnerClaimModeForChannel("telegram", {
        OPENCLAW_BOOTSTRAP_CHANNEL: "telegram",
      }),
    ).toBe("first-dm");
    expect(supportsBootstrapOwnerClaim("telegram")).toBe(true);
    expect(supportsBootstrapOwnerClaim("qqbot")).toBe(false);
  });
});
