import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { runCapability } from "./runner.js";
import { withMediaFixture } from "./runner.test-utils.js";

describe("runCapability auto image entries", () => {
  it("prefers the active provider before global OpenAI fallback when model is missing", async () => {
    let seenModel: string | undefined;
    await withMediaFixture(
      {
        filePrefix: "openclaw-auto-image-active-provider",
        extension: "png",
        mediaType: "image/png",
        fileContents: Buffer.from("image"),
      },
      async ({ ctx, media, cache }) => {
        const cfg = {
          models: {
            providers: {
              anthropic: {
                apiKey: "anthropic-test",
                models: [],
              },
            },
          },
          tools: {
            media: {
              image: {
                enabled: true,
              },
            },
          },
        } as unknown as OpenClawConfig;

        const result = await runCapability({
          capability: "image",
          cfg,
          ctx,
          attachments: cache,
          media,
          agentDir: process.cwd(),
          activeModel: { provider: "anthropic" },
          providerRegistry: new Map([
            [
              "anthropic",
              {
                id: "anthropic",
                capabilities: ["image"],
                describeImage: async (req: { model: string }) => {
                  seenModel = req.model;
                  return { text: "ok", model: req.model };
                },
              },
            ],
            [
              "openai",
              {
                id: "openai",
                capabilities: ["image"],
                describeImage: async () => ({ text: "openai" }),
              },
            ],
          ]),
        });

        expect(result.decision.outcome).toBe("success");
        expect(result.outputs[0]?.provider).toBe("anthropic");
        expect(result.outputs[0]?.text).toBe("ok");
        expect(seenModel).toBe("claude-opus-4-6");
      },
    );
  });
});
