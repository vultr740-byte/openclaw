import { describe, expect, it } from "vitest";
import { __testing } from "./web-search.js";

const {
  inferPerplexityBaseUrlFromApiKey,
  resolvePerplexityBaseUrl,
  isDirectPerplexityBaseUrl,
  resolvePerplexityRequestModel,
  normalizeFreshness,
  resolveGrokApiKey,
  resolveGrokModel,
  resolveGrokInlineCitations,
  extractGrokContent,
  resolveOpenAiModel,
  resolveOpenAiBaseUrl,
  resolveOpenAiApiKeySync,
  extractOpenAiContent,
  extractOpenAiCitations,
  isOpenAiWebSearchUnsupported,
} = __testing;

describe("web_search perplexity baseUrl defaults", () => {
  it("detects a Perplexity key prefix", () => {
    expect(inferPerplexityBaseUrlFromApiKey("pplx-123")).toBe("direct");
  });

  it("detects an OpenRouter key prefix", () => {
    expect(inferPerplexityBaseUrlFromApiKey("sk-or-v1-123")).toBe("openrouter");
  });

  it("returns undefined for unknown key formats", () => {
    expect(inferPerplexityBaseUrlFromApiKey("unknown-key")).toBeUndefined();
  });

  it("prefers explicit baseUrl over key-based defaults", () => {
    expect(resolvePerplexityBaseUrl({ baseUrl: "https://example.com" }, "config", "pplx-123")).toBe(
      "https://example.com",
    );
  });

  it("defaults to direct when using PERPLEXITY_API_KEY", () => {
    expect(resolvePerplexityBaseUrl(undefined, "perplexity_env")).toBe("https://api.perplexity.ai");
  });

  it("defaults to OpenRouter when using OPENROUTER_API_KEY", () => {
    expect(resolvePerplexityBaseUrl(undefined, "openrouter_env")).toBe(
      "https://openrouter.ai/api/v1",
    );
  });

  it("defaults to direct when config key looks like Perplexity", () => {
    expect(resolvePerplexityBaseUrl(undefined, "config", "pplx-123")).toBe(
      "https://api.perplexity.ai",
    );
  });

  it("defaults to OpenRouter when config key looks like OpenRouter", () => {
    expect(resolvePerplexityBaseUrl(undefined, "config", "sk-or-v1-123")).toBe(
      "https://openrouter.ai/api/v1",
    );
  });

  it("defaults to OpenRouter for unknown config key formats", () => {
    expect(resolvePerplexityBaseUrl(undefined, "config", "weird-key")).toBe(
      "https://openrouter.ai/api/v1",
    );
  });
});

describe("web_search perplexity model normalization", () => {
  it("detects direct Perplexity host", () => {
    expect(isDirectPerplexityBaseUrl("https://api.perplexity.ai")).toBe(true);
    expect(isDirectPerplexityBaseUrl("https://api.perplexity.ai/")).toBe(true);
    expect(isDirectPerplexityBaseUrl("https://openrouter.ai/api/v1")).toBe(false);
  });

  it("strips provider prefix for direct Perplexity", () => {
    expect(resolvePerplexityRequestModel("https://api.perplexity.ai", "perplexity/sonar-pro")).toBe(
      "sonar-pro",
    );
  });

  it("keeps prefixed model for OpenRouter", () => {
    expect(
      resolvePerplexityRequestModel("https://openrouter.ai/api/v1", "perplexity/sonar-pro"),
    ).toBe("perplexity/sonar-pro");
  });

  it("keeps model unchanged when URL is invalid", () => {
    expect(resolvePerplexityRequestModel("not-a-url", "perplexity/sonar-pro")).toBe(
      "perplexity/sonar-pro",
    );
  });
});

describe("web_search freshness normalization", () => {
  it("accepts Brave shortcut values", () => {
    expect(normalizeFreshness("pd")).toBe("pd");
    expect(normalizeFreshness("PW")).toBe("pw");
  });

  it("accepts valid date ranges", () => {
    expect(normalizeFreshness("2024-01-01to2024-01-31")).toBe("2024-01-01to2024-01-31");
  });

  it("rejects invalid date ranges", () => {
    expect(normalizeFreshness("2024-13-01to2024-01-31")).toBeUndefined();
    expect(normalizeFreshness("2024-02-30to2024-03-01")).toBeUndefined();
    expect(normalizeFreshness("2024-03-10to2024-03-01")).toBeUndefined();
  });
});

describe("web_search grok config resolution", () => {
  it("uses config apiKey when provided", () => {
    expect(resolveGrokApiKey({ apiKey: "xai-test-key" })).toBe("xai-test-key");
  });

  it("returns undefined when no apiKey is available", () => {
    const previous = process.env.XAI_API_KEY;
    try {
      delete process.env.XAI_API_KEY;
      expect(resolveGrokApiKey({})).toBeUndefined();
      expect(resolveGrokApiKey(undefined)).toBeUndefined();
    } finally {
      if (previous === undefined) {
        delete process.env.XAI_API_KEY;
      } else {
        process.env.XAI_API_KEY = previous;
      }
    }
  });

  it("uses default model when not specified", () => {
    expect(resolveGrokModel({})).toBe("grok-4-1-fast");
    expect(resolveGrokModel(undefined)).toBe("grok-4-1-fast");
  });

  it("uses config model when provided", () => {
    expect(resolveGrokModel({ model: "grok-3" })).toBe("grok-3");
  });

  it("defaults inlineCitations to false", () => {
    expect(resolveGrokInlineCitations({})).toBe(false);
    expect(resolveGrokInlineCitations(undefined)).toBe(false);
  });

  it("respects inlineCitations config", () => {
    expect(resolveGrokInlineCitations({ inlineCitations: true })).toBe(true);
    expect(resolveGrokInlineCitations({ inlineCitations: false })).toBe(false);
  });
});

describe("web_search grok response parsing", () => {
  it("extracts content from Responses API output blocks", () => {
    expect(
      extractGrokContent({
        output: [
          {
            content: [{ text: "hello from output" }],
          },
        ],
      }),
    ).toBe("hello from output");
  });

  it("falls back to deprecated output_text", () => {
    expect(extractGrokContent({ output_text: "hello from output_text" })).toBe(
      "hello from output_text",
    );
  });
});

describe("web_search openai config resolution", () => {
  it("uses openai model override when provided", () => {
    expect(resolveOpenAiModel({ openai: { model: "openai/gpt-5.2" } })).toBe("gpt-5.2");
  });

  it("uses current agent model when provider is openai", () => {
    expect(resolveOpenAiModel({ modelProvider: "openai", modelId: "gpt-5.2" })).toBe("gpt-5.2");
  });

  it("uses configured provider baseUrl when present", () => {
    expect(
      resolveOpenAiBaseUrl(undefined, {
        models: { providers: { openai: { baseUrl: "https://proxy.example/v1", models: [] } } },
      }),
    ).toBe("https://proxy.example/v1");
  });

  it("uses OPENAI_API_KEY when set", () => {
    const previous = process.env.OPENAI_API_KEY;
    try {
      process.env.OPENAI_API_KEY = "sk-test";
      expect(resolveOpenAiApiKeySync(undefined, undefined)).toBe("sk-test");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previous;
      }
    }
  });
});

describe("web_search openai response parsing", () => {
  it("extracts content from output_text", () => {
    expect(extractOpenAiContent({ output_text: "hello" })).toBe("hello");
  });

  it("extracts citations from annotations", () => {
    const citations = extractOpenAiCitations({
      output: [
        {
          content: [
            {
              type: "output_text",
              text: "hello",
              annotations: [{ url: "https://example.com" }],
            },
          ],
        },
      ],
    });
    expect(citations).toEqual(["https://example.com"]);
  });
});

describe("web_search openai unsupported detection", () => {
  it("flags unsupported tool responses", () => {
    expect(
      isOpenAiWebSearchUnsupported({
        status: 400,
        detail: "The model does not support web_search",
      }),
    ).toBe(true);
  });
});
