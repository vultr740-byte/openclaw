import { Type } from "@sinclair/typebox";
import { formatCliCommand } from "../../cli/command-format.js";
import type { OpenClawConfig } from "../../config/config.js";
import { wrapWebContent } from "../../security/external-content.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import { resolveApiKeyForProvider } from "../model-auth.js";
import { parseModelRef } from "../model-selection.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import {
  CacheEntry,
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_TIMEOUT_SECONDS,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
  withTimeout,
  writeCache,
} from "./web-shared.js";

const SEARCH_PROVIDERS = ["openai", "brave", "perplexity", "grok"] as const;
const DEFAULT_SEARCH_COUNT = 5;
const MAX_SEARCH_COUNT = 10;

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_PERPLEXITY_BASE_URL = "https://openrouter.ai/api/v1";
const PERPLEXITY_DIRECT_BASE_URL = "https://api.perplexity.ai";
const DEFAULT_PERPLEXITY_MODEL = "perplexity/sonar-pro";
const PERPLEXITY_KEY_PREFIXES = ["pplx-"];
const OPENROUTER_KEY_PREFIXES = ["sk-or-"];

const XAI_API_ENDPOINT = "https://api.x.ai/v1/responses";
const DEFAULT_GROK_MODEL = "grok-4-1-fast";

const SEARCH_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();
const BRAVE_FRESHNESS_SHORTCUTS = new Set(["pd", "pw", "pm", "py"]);
const BRAVE_FRESHNESS_RANGE = /^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/;

const WebSearchSchema = Type.Object({
  query: Type.String({ description: "Search query string." }),
  count: Type.Optional(
    Type.Number({
      description: "Number of results to return (1-10).",
      minimum: 1,
      maximum: MAX_SEARCH_COUNT,
    }),
  ),
  country: Type.Optional(
    Type.String({
      description:
        "2-letter country code for region-specific results (e.g., 'DE', 'US', 'ALL'). Default: 'US'.",
    }),
  ),
  search_lang: Type.Optional(
    Type.String({
      description: "ISO language code for search results (e.g., 'de', 'en', 'fr').",
    }),
  ),
  ui_lang: Type.Optional(
    Type.String({
      description: "ISO language code for UI elements.",
    }),
  ),
  freshness: Type.Optional(
    Type.String({
      description:
        "Filter results by discovery time. Brave supports 'pd', 'pw', 'pm', 'py', and date range 'YYYY-MM-DDtoYYYY-MM-DD'. Perplexity supports 'pd', 'pw', 'pm', and 'py'.",
    }),
  ),
});

type WebSearchConfig = NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web
  ? Web extends { search?: infer Search }
    ? Search
    : undefined
  : undefined;

type BraveSearchResult = {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
};

type BraveSearchResponse = {
  web?: {
    results?: BraveSearchResult[];
  };
};

type PerplexityConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};

type OpenAiConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};

type PerplexityApiKeySource = "config" | "perplexity_env" | "openrouter_env" | "none";

type GrokConfig = {
  apiKey?: string;
  model?: string;
  inlineCitations?: boolean;
};

type GrokSearchResponse = {
  output?: Array<{
    type?: string;
    role?: string;
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{
        type?: string;
        url?: string;
        start_index?: number;
        end_index?: number;
      }>;
    }>;
  }>;
  output_text?: string; // deprecated field - kept for backwards compatibility
  citations?: string[];
  inline_citations?: Array<{
    start_index: number;
    end_index: number;
    url: string;
  }>;
};

type OpenAiSearchResponse = {
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{ url?: string }>;
    }>;
  }>;
  citations?: string[];
};

type OpenAiSearchErrorResponse = {
  error?: {
    message?: string;
    type?: string;
    code?: string;
    param?: string;
  };
};

type PerplexitySearchResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  citations?: string[];
};

type PerplexityBaseUrlHint = "direct" | "openrouter";

function extractGrokContent(data: GrokSearchResponse): {
  text: string | undefined;
  annotationCitations: string[];
} {
  // xAI Responses API format: find the message output with text content
  for (const output of data.output ?? []) {
    if (output.type !== "message") {
      continue;
    }
    for (const block of output.content ?? []) {
      if (block.type === "output_text" && typeof block.text === "string" && block.text) {
        // Extract url_citation annotations from this content block
        const urls = (block.annotations ?? [])
          .filter((a) => a.type === "url_citation" && typeof a.url === "string")
          .map((a) => a.url as string);
        return { text: block.text, annotationCitations: [...new Set(urls)] };
      }
    }
  }
  // Fallback: deprecated output_text field
  const text = typeof data.output_text === "string" ? data.output_text : undefined;
  return { text, annotationCitations: [] };
}

class OpenAiWebSearchUnsupportedError extends Error {
  readonly provider = "openai";
  readonly detail: string;

  constructor(detail: string) {
    super("OpenAI web_search unsupported");
    this.detail = detail;
  }
}

function extractOpenAiContent(data: OpenAiSearchResponse): string | undefined {
  if (typeof data.output_text === "string" && data.output_text) {
    return data.output_text;
  }
  const outputs = Array.isArray(data.output) ? data.output : [];
  const parts: string[] = [];
  for (const output of outputs) {
    const content = Array.isArray(output?.content) ? output.content : [];
    for (const part of content) {
      if (part?.type === "output_text" && typeof part.text === "string") {
        parts.push(part.text);
        continue;
      }
      if (typeof part?.text === "string" && part.text) {
        parts.push(part.text);
      }
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function extractOpenAiCitations(data: OpenAiSearchResponse): string[] {
  const urls = new Set<string>();
  if (Array.isArray(data.citations)) {
    for (const entry of data.citations) {
      if (typeof entry === "string" && entry) {
        urls.add(entry);
      }
    }
  }
  const outputs = Array.isArray(data.output) ? data.output : [];
  for (const output of outputs) {
    const content = Array.isArray(output?.content) ? output.content : [];
    for (const part of content) {
      const annotations = Array.isArray(part?.annotations) ? part.annotations : [];
      for (const annotation of annotations) {
        if (typeof annotation?.url === "string" && annotation.url) {
          urls.add(annotation.url);
        }
      }
    }
  }
  return Array.from(urls);
}

function resolveSearchConfig(cfg?: OpenClawConfig): WebSearchConfig {
  const search = cfg?.tools?.web?.search;
  if (!search || typeof search !== "object") {
    return undefined;
  }
  return search as WebSearchConfig;
}

function resolveSearchEnabled(params: { search?: WebSearchConfig; sandboxed?: boolean }): boolean {
  if (typeof params.search?.enabled === "boolean") {
    return params.search.enabled;
  }
  if (params.sandboxed) {
    return true;
  }
  return true;
}

function resolveOpenAiConfig(search?: WebSearchConfig): OpenAiConfig {
  if (!search || typeof search !== "object") {
    return {};
  }
  const openai = "openai" in search ? search.openai : undefined;
  if (!openai || typeof openai !== "object") {
    return {};
  }
  return openai as OpenAiConfig;
}

function isOpenAiProvider(provider?: string): boolean {
  const normalized = provider?.trim().toLowerCase();
  return normalized === "openai" || normalized === "openai-codex";
}

function normalizeOpenAiModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return trimmed;
  }
  return trimmed.startsWith("openai/") ? trimmed.slice("openai/".length) : trimmed;
}

function resolveOpenAiModel(params: {
  openai?: OpenAiConfig;
  cfg?: OpenClawConfig;
  modelProvider?: string;
  modelId?: string;
}): string | undefined {
  const fromConfig =
    params.openai && "model" in params.openai && typeof params.openai.model === "string"
      ? params.openai.model.trim()
      : "";
  if (fromConfig) {
    return normalizeOpenAiModel(fromConfig);
  }
  if (isOpenAiProvider(params.modelProvider) && params.modelId?.trim()) {
    return normalizeOpenAiModel(params.modelId);
  }
  const primary = params.cfg?.agents?.defaults?.model?.primary;
  if (typeof primary === "string" && primary.trim()) {
    const parsed = parseModelRef(primary, "openai");
    if (parsed?.provider === "openai") {
      return normalizeOpenAiModel(parsed.model);
    }
  }
  const providerModel = params.cfg?.models?.providers?.openai?.models?.[0]?.id;
  if (typeof providerModel === "string" && providerModel.trim()) {
    return normalizeOpenAiModel(providerModel);
  }
  return undefined;
}

function resolveOpenAiBaseUrl(openai?: OpenAiConfig, cfg?: OpenClawConfig): string {
  const fromConfig =
    openai && "baseUrl" in openai && typeof openai.baseUrl === "string"
      ? openai.baseUrl.trim()
      : "";
  if (fromConfig) {
    return fromConfig;
  }
  const providerBaseUrl = cfg?.models?.providers?.openai?.baseUrl?.trim();
  if (providerBaseUrl) {
    return providerBaseUrl;
  }
  return DEFAULT_OPENAI_BASE_URL;
}

function resolveOpenAiApiKeySync(openai?: OpenAiConfig, cfg?: OpenClawConfig): string | undefined {
  const fromConfig =
    openai && "apiKey" in openai && typeof openai.apiKey === "string"
      ? normalizeApiKey(openai.apiKey)
      : "";
  if (fromConfig) {
    return fromConfig;
  }
  const fromProviderConfig = normalizeApiKey(cfg?.models?.providers?.openai?.apiKey);
  if (fromProviderConfig) {
    return fromProviderConfig;
  }
  const fromEnv = normalizeApiKey(process.env.OPENAI_API_KEY);
  return fromEnv || undefined;
}

async function resolveOpenAiApiKey(params: {
  openai?: OpenAiConfig;
  cfg?: OpenClawConfig;
  agentDir?: string;
}): Promise<string | undefined> {
  const fromSync = resolveOpenAiApiKeySync(params.openai, params.cfg);
  if (fromSync) {
    return fromSync;
  }
  try {
    const resolved = await resolveApiKeyForProvider({
      provider: "openai",
      cfg: params.cfg,
      agentDir: params.agentDir,
    });
    return normalizeApiKey(resolved.apiKey);
  } catch {
    return undefined;
  }
}

function resolveSearchApiKey(search?: WebSearchConfig): string | undefined {
  const fromConfig =
    search && "apiKey" in search && typeof search.apiKey === "string"
      ? normalizeSecretInput(search.apiKey)
      : "";
  const fromEnv = normalizeSecretInput(process.env.BRAVE_API_KEY);
  return fromConfig || fromEnv || undefined;
}

function missingSearchKeyPayload(provider: (typeof SEARCH_PROVIDERS)[number]) {
  if (provider === "openai") {
    return {
      error: "missing_openai_api_key",
      message:
        "web_search (openai) needs an OpenAI API key. Set OPENAI_API_KEY in the Gateway environment, configure tools.web.search.openai.apiKey, or set models.providers.openai.apiKey.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }
  if (provider === "perplexity") {
    return {
      error: "missing_perplexity_api_key",
      message:
        "web_search (perplexity) needs an API key. Set PERPLEXITY_API_KEY or OPENROUTER_API_KEY in the Gateway environment, or configure tools.web.search.perplexity.apiKey.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }
  if (provider === "grok") {
    return {
      error: "missing_xai_api_key",
      message:
        "web_search (grok) needs an xAI API key. Set XAI_API_KEY in the Gateway environment, or configure tools.web.search.grok.apiKey.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }
  return {
    error: "missing_brave_api_key",
    message: `web_search needs a Brave Search API key. Run \`${formatCliCommand("openclaw configure --section web")}\` to store it, or set BRAVE_API_KEY in the Gateway environment.`,
    docs: "https://docs.openclaw.ai/tools/web",
  };
}

function resolveSearchProvider(params: {
  search?: WebSearchConfig;
  cfg?: OpenClawConfig;
  modelProvider?: string;
  modelId?: string;
}): (typeof SEARCH_PROVIDERS)[number] {
  const raw =
    params.search && "provider" in params.search && typeof params.search.provider === "string"
      ? params.search.provider.trim().toLowerCase()
      : "";
  if (raw === "openai") {
    return "openai";
  }
  if (raw === "perplexity") {
    return "perplexity";
  }
  if (raw === "grok") {
    return "grok";
  }
  if (raw === "brave") {
    return "brave";
  }

  const openaiConfig = resolveOpenAiConfig(params.search);
  const openaiKey = resolveOpenAiApiKeySync(openaiConfig, params.cfg);
  if (openaiKey) {
    return "openai";
  }

  return "brave";
}

function resolvePerplexityConfig(search?: WebSearchConfig): PerplexityConfig {
  if (!search || typeof search !== "object") {
    return {};
  }
  const perplexity = "perplexity" in search ? search.perplexity : undefined;
  if (!perplexity || typeof perplexity !== "object") {
    return {};
  }
  return perplexity as PerplexityConfig;
}

function resolvePerplexityApiKey(perplexity?: PerplexityConfig): {
  apiKey?: string;
  source: PerplexityApiKeySource;
} {
  const fromConfig = normalizeApiKey(perplexity?.apiKey);
  if (fromConfig) {
    return { apiKey: fromConfig, source: "config" };
  }

  const fromEnvPerplexity = normalizeApiKey(process.env.PERPLEXITY_API_KEY);
  if (fromEnvPerplexity) {
    return { apiKey: fromEnvPerplexity, source: "perplexity_env" };
  }

  const fromEnvOpenRouter = normalizeApiKey(process.env.OPENROUTER_API_KEY);
  if (fromEnvOpenRouter) {
    return { apiKey: fromEnvOpenRouter, source: "openrouter_env" };
  }

  return { apiKey: undefined, source: "none" };
}

function normalizeApiKey(key: unknown): string {
  return normalizeSecretInput(key);
}

function inferPerplexityBaseUrlFromApiKey(apiKey?: string): PerplexityBaseUrlHint | undefined {
  if (!apiKey) {
    return undefined;
  }
  const normalized = apiKey.toLowerCase();
  if (PERPLEXITY_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "direct";
  }
  if (OPENROUTER_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "openrouter";
  }
  return undefined;
}

function resolvePerplexityBaseUrl(
  perplexity?: PerplexityConfig,
  apiKeySource: PerplexityApiKeySource = "none",
  apiKey?: string,
): string {
  const fromConfig =
    perplexity && "baseUrl" in perplexity && typeof perplexity.baseUrl === "string"
      ? perplexity.baseUrl.trim()
      : "";
  if (fromConfig) {
    return fromConfig;
  }
  if (apiKeySource === "perplexity_env") {
    return PERPLEXITY_DIRECT_BASE_URL;
  }
  if (apiKeySource === "openrouter_env") {
    return DEFAULT_PERPLEXITY_BASE_URL;
  }
  if (apiKeySource === "config") {
    const inferred = inferPerplexityBaseUrlFromApiKey(apiKey);
    if (inferred === "direct") {
      return PERPLEXITY_DIRECT_BASE_URL;
    }
    if (inferred === "openrouter") {
      return DEFAULT_PERPLEXITY_BASE_URL;
    }
  }
  return DEFAULT_PERPLEXITY_BASE_URL;
}

function resolvePerplexityModel(perplexity?: PerplexityConfig): string {
  const fromConfig =
    perplexity && "model" in perplexity && typeof perplexity.model === "string"
      ? perplexity.model.trim()
      : "";
  return fromConfig || DEFAULT_PERPLEXITY_MODEL;
}

function isDirectPerplexityBaseUrl(baseUrl: string): boolean {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return false;
  }
  try {
    return new URL(trimmed).hostname.toLowerCase() === "api.perplexity.ai";
  } catch {
    return false;
  }
}

function resolvePerplexityRequestModel(baseUrl: string, model: string): string {
  if (!isDirectPerplexityBaseUrl(baseUrl)) {
    return model;
  }
  return model.startsWith("perplexity/") ? model.slice("perplexity/".length) : model;
}

function resolveGrokConfig(search?: WebSearchConfig): GrokConfig {
  if (!search || typeof search !== "object") {
    return {};
  }
  const grok = "grok" in search ? search.grok : undefined;
  if (!grok || typeof grok !== "object") {
    return {};
  }
  return grok as GrokConfig;
}

function resolveGrokApiKey(grok?: GrokConfig): string | undefined {
  const fromConfig = normalizeApiKey(grok?.apiKey);
  if (fromConfig) {
    return fromConfig;
  }
  const fromEnv = normalizeApiKey(process.env.XAI_API_KEY);
  return fromEnv || undefined;
}

function resolveGrokModel(grok?: GrokConfig): string {
  const fromConfig =
    grok && "model" in grok && typeof grok.model === "string" ? grok.model.trim() : "";
  return fromConfig || DEFAULT_GROK_MODEL;
}

function resolveGrokInlineCitations(grok?: GrokConfig): boolean {
  return grok?.inlineCitations === true;
}

function resolveSearchCount(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const clamped = Math.max(1, Math.min(MAX_SEARCH_COUNT, Math.floor(parsed)));
  return clamped;
}

function normalizeFreshness(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const lower = trimmed.toLowerCase();
  if (BRAVE_FRESHNESS_SHORTCUTS.has(lower)) {
    return lower;
  }

  const match = trimmed.match(BRAVE_FRESHNESS_RANGE);
  if (!match) {
    return undefined;
  }

  const [, start, end] = match;
  if (!isValidIsoDate(start) || !isValidIsoDate(end)) {
    return undefined;
  }
  if (start > end) {
    return undefined;
  }

  return `${start}to${end}`;
}

/**
 * Map normalized freshness values (pd/pw/pm/py) to Perplexity's
 * search_recency_filter values (day/week/month/year).
 */
function freshnessToPerplexityRecency(freshness: string | undefined): string | undefined {
  if (!freshness) {
    return undefined;
  }
  const map: Record<string, string> = {
    pd: "day",
    pw: "week",
    pm: "month",
    py: "year",
  };
  return map[freshness] ?? undefined;
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return false;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function resolveSiteName(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function resolveOpenAiErrorDetail(detail: string): { message: string; code?: string } {
  if (!detail) {
    return { message: "" };
  }
  try {
    const parsed = JSON.parse(detail) as OpenAiSearchErrorResponse;
    if (parsed?.error?.message) {
      return {
        message: parsed.error.message,
        code: typeof parsed.error.code === "string" ? parsed.error.code : undefined,
      };
    }
  } catch {}
  return { message: detail };
}

function isOpenAiWebSearchUnsupported(params: { status: number; detail: string; code?: string }) {
  const status = params.status;
  if (status !== 400 && status !== 404 && status !== 422) {
    return false;
  }
  const normalized = params.detail.toLowerCase();
  const code = params.code?.toLowerCase();
  if (code && (code.includes("unsupported") || code.includes("not_supported"))) {
    return true;
  }
  if (!normalized.includes("web_search") && !normalized.includes("web search")) {
    return normalized.includes("tool") && normalized.includes("unsupported");
  }
  return (
    normalized.includes("does not support") ||
    normalized.includes("not supported") ||
    normalized.includes("unsupported") ||
    normalized.includes("unknown tool") ||
    normalized.includes("unrecognized")
  );
}

async function runOpenAiSearch(params: {
  query: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
}): Promise<{ content: string; citations: string[] }> {
  const baseUrl = params.baseUrl.trim().replace(/\/$/, "");
  const endpoint = `${baseUrl}/responses`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify({
      model: params.model,
      input: params.query,
      tools: [{ type: "web_search" }],
    }),
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const detail = await readResponseText(res);
    const parsed = resolveOpenAiErrorDetail(detail);
    if (
      isOpenAiWebSearchUnsupported({
        status: res.status,
        detail: parsed.message,
        code: parsed.code,
      })
    ) {
      throw new OpenAiWebSearchUnsupportedError(parsed.message || detail || res.statusText);
    }
    throw new Error(
      `OpenAI API error (${res.status}): ${parsed.message || detail || res.statusText}`,
    );
  }

  const data = (await res.json()) as OpenAiSearchResponse;
  const content = extractOpenAiContent(data) ?? "No response";
  const citations = extractOpenAiCitations(data);
  return { content, citations };
}

async function runPerplexitySearch(params: {
  query: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
  freshness?: string;
}): Promise<{ content: string; citations: string[] }> {
  const baseUrl = params.baseUrl.trim().replace(/\/$/, "");
  const endpoint = `${baseUrl}/chat/completions`;
  const model = resolvePerplexityRequestModel(baseUrl, params.model);

  const body: Record<string, unknown> = {
    model,
    messages: [
      {
        role: "user",
        content: params.query,
      },
    ],
  };

  const recencyFilter = freshnessToPerplexityRecency(params.freshness);
  if (recencyFilter) {
    body.search_recency_filter = recencyFilter;
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.apiKey}`,
      "HTTP-Referer": "https://openclaw.ai",
      "X-Title": "OpenClaw Web Search",
    },
    body: JSON.stringify(body),
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const detailResult = await readResponseText(res, { maxBytes: 64_000 });
    const detail = detailResult.text;
    throw new Error(`Perplexity API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as PerplexitySearchResponse;
  const content = data.choices?.[0]?.message?.content ?? "No response";
  const citations = data.citations ?? [];

  return { content, citations };
}

async function runGrokSearch(params: {
  query: string;
  apiKey: string;
  model: string;
  timeoutSeconds: number;
  inlineCitations: boolean;
}): Promise<{
  content: string;
  citations: string[];
  inlineCitations?: GrokSearchResponse["inline_citations"];
}> {
  const body: Record<string, unknown> = {
    model: params.model,
    input: [
      {
        role: "user",
        content: params.query,
      },
    ],
    tools: [{ type: "web_search" }],
  };

  // Note: xAI's /v1/responses endpoint does not support the `include`
  // parameter (returns 400 "Argument not supported: include"). Inline
  // citations are returned automatically when available — we just parse
  // them from the response without requesting them explicitly (#12910).

  const res = await fetch(XAI_API_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const detailResult = await readResponseText(res, { maxBytes: 64_000 });
    const detail = detailResult.text;
    throw new Error(`xAI API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as GrokSearchResponse;
  const { text: extractedText, annotationCitations } = extractGrokContent(data);
  const content = extractedText ?? "No response";
  // Prefer top-level citations; fall back to annotation-derived ones
  const citations = (data.citations ?? []).length > 0 ? data.citations! : annotationCitations;
  const inlineCitations = data.inline_citations;

  return { content, citations, inlineCitations };
}

async function runWebSearch(params: {
  query: string;
  count: number;
  apiKey: string;
  timeoutSeconds: number;
  cacheTtlMs: number;
  provider: (typeof SEARCH_PROVIDERS)[number];
  country?: string;
  search_lang?: string;
  ui_lang?: string;
  freshness?: string;
  openaiBaseUrl?: string;
  openaiModel?: string;
  perplexityBaseUrl?: string;
  perplexityModel?: string;
  grokModel?: string;
  grokInlineCitations?: boolean;
}): Promise<Record<string, unknown>> {
  const cacheKey = normalizeCacheKey(
    params.provider === "brave"
      ? `${params.provider}:${params.query}:${params.count}:${params.country || "default"}:${params.search_lang || "default"}:${params.ui_lang || "default"}:${params.freshness || "default"}`
      : params.provider === "perplexity"
        ? `${params.provider}:${params.query}:${params.perplexityBaseUrl ?? DEFAULT_PERPLEXITY_BASE_URL}:${params.perplexityModel ?? DEFAULT_PERPLEXITY_MODEL}:${params.freshness || "default"}`
        : params.provider === "openai"
          ? `${params.provider}:${params.query}:${params.openaiBaseUrl ?? DEFAULT_OPENAI_BASE_URL}:${params.openaiModel ?? "default"}`
          : `${params.provider}:${params.query}:${params.grokModel ?? DEFAULT_GROK_MODEL}:${String(params.grokInlineCitations ?? false)}`,
  );
  const cached = readCache(SEARCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const start = Date.now();

  if (params.provider === "openai") {
    const { content, citations } = await runOpenAiSearch({
      query: params.query,
      apiKey: params.apiKey,
      baseUrl: params.openaiBaseUrl ?? DEFAULT_OPENAI_BASE_URL,
      model: params.openaiModel ?? "",
      timeoutSeconds: params.timeoutSeconds,
    });

    const payload = {
      query: params.query,
      provider: params.provider,
      model: params.openaiModel ?? "",
      tookMs: Date.now() - start,
      content: wrapWebContent(content),
      citations,
    };
    writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  }

  if (params.provider === "perplexity") {
    const { content, citations } = await runPerplexitySearch({
      query: params.query,
      apiKey: params.apiKey,
      baseUrl: params.perplexityBaseUrl ?? DEFAULT_PERPLEXITY_BASE_URL,
      model: params.perplexityModel ?? DEFAULT_PERPLEXITY_MODEL,
      timeoutSeconds: params.timeoutSeconds,
      freshness: params.freshness,
    });

    const payload = {
      query: params.query,
      provider: params.provider,
      model: params.perplexityModel ?? DEFAULT_PERPLEXITY_MODEL,
      tookMs: Date.now() - start,
      externalContent: {
        untrusted: true,
        source: "web_search",
        provider: params.provider,
        wrapped: true,
      },
      content: wrapWebContent(content),
      citations,
    };
    writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  }

  if (params.provider === "grok") {
    const { content, citations, inlineCitations } = await runGrokSearch({
      query: params.query,
      apiKey: params.apiKey,
      model: params.grokModel ?? DEFAULT_GROK_MODEL,
      timeoutSeconds: params.timeoutSeconds,
      inlineCitations: params.grokInlineCitations ?? false,
    });

    const payload = {
      query: params.query,
      provider: params.provider,
      model: params.grokModel ?? DEFAULT_GROK_MODEL,
      tookMs: Date.now() - start,
      externalContent: {
        untrusted: true,
        source: "web_search",
        provider: params.provider,
        wrapped: true,
      },
      content: wrapWebContent(content),
      citations,
      inlineCitations,
    };
    writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  }

  if (params.provider !== "brave") {
    throw new Error("Unsupported web search provider.");
  }

  const url = new URL(BRAVE_SEARCH_ENDPOINT);
  url.searchParams.set("q", params.query);
  url.searchParams.set("count", String(params.count));
  if (params.country) {
    url.searchParams.set("country", params.country);
  }
  if (params.search_lang) {
    url.searchParams.set("search_lang", params.search_lang);
  }
  if (params.ui_lang) {
    url.searchParams.set("ui_lang", params.ui_lang);
  }
  if (params.freshness) {
    url.searchParams.set("freshness", params.freshness);
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": params.apiKey,
    },
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const detailResult = await readResponseText(res, { maxBytes: 64_000 });
    const detail = detailResult.text;
    throw new Error(`Brave Search API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as BraveSearchResponse;
  const results = Array.isArray(data.web?.results) ? (data.web?.results ?? []) : [];
  const mapped = results.map((entry) => {
    const description = entry.description ?? "";
    const title = entry.title ?? "";
    const url = entry.url ?? "";
    const rawSiteName = resolveSiteName(url);
    return {
      title: title ? wrapWebContent(title, "web_search") : "",
      url, // Keep raw for tool chaining
      description: description ? wrapWebContent(description, "web_search") : "",
      published: entry.age || undefined,
      siteName: rawSiteName || undefined,
    };
  });

  const payload = {
    query: params.query,
    provider: params.provider,
    count: mapped.length,
    tookMs: Date.now() - start,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: params.provider,
      wrapped: true,
    },
    results: mapped,
  };
  writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
  return payload;
}

export function createWebSearchTool(options?: {
  config?: OpenClawConfig;
  sandboxed?: boolean;
  modelProvider?: string;
  modelId?: string;
  agentDir?: string;
}): AnyAgentTool | null {
  const search = resolveSearchConfig(options?.config);
  if (!resolveSearchEnabled({ search, sandboxed: options?.sandboxed })) {
    return null;
  }

  const openaiConfig = resolveOpenAiConfig(search);
  const openaiModel = resolveOpenAiModel({
    openai: openaiConfig,
    cfg: options?.config,
    modelProvider: options?.modelProvider,
    modelId: options?.modelId,
  });
  const openaiBaseUrl = resolveOpenAiBaseUrl(openaiConfig, options?.config);
  const provider = resolveSearchProvider({
    search,
    cfg: options?.config,
    modelProvider: options?.modelProvider,
    modelId: options?.modelId,
  });
  const perplexityConfig = resolvePerplexityConfig(search);
  const grokConfig = resolveGrokConfig(search);

  const description =
    provider === "openai"
      ? "Search the web using OpenAI web_search. Returns AI-synthesized answers with citations when available."
      : provider === "perplexity"
        ? "Search the web using Perplexity Sonar (direct or via OpenRouter). Returns AI-synthesized answers with citations from real-time web search."
        : provider === "grok"
          ? "Search the web using xAI Grok. Returns AI-synthesized answers with citations from real-time web search."
          : "Search the web using Brave Search API. Supports region-specific and localized search via country and language parameters. Returns titles, URLs, and snippets for fast research.";

  return {
    label: "Web Search",
    name: "web_search",
    description,
    parameters: WebSearchSchema,
    execute: async (_toolCallId, args) => {
      const perplexityAuth = resolvePerplexityApiKey(perplexityConfig);
      const grokApiKey = resolveGrokApiKey(grokConfig);
      const braveApiKey = resolveSearchApiKey(search);
      const openaiApiKey =
        provider === "openai"
          ? await resolveOpenAiApiKey({
              openai: openaiConfig,
              cfg: options?.config,
              agentDir: options?.agentDir,
            })
          : undefined;

      const apiKey =
        provider === "openai"
          ? openaiApiKey
          : provider === "perplexity"
            ? perplexityAuth?.apiKey
            : provider === "grok"
              ? grokApiKey
              : braveApiKey;

      if (!apiKey) {
        return jsonResult(missingSearchKeyPayload(provider));
      }
      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      const count =
        readNumberParam(params, "count", { integer: true }) ?? search?.maxResults ?? undefined;
      const country = readStringParam(params, "country");
      const search_lang = readStringParam(params, "search_lang");
      const ui_lang = readStringParam(params, "ui_lang");
      const rawFreshness = readStringParam(params, "freshness");
      if (rawFreshness && provider !== "brave" && provider !== "perplexity") {
        return jsonResult({
          error: "unsupported_freshness",
          message: "freshness is only supported by the Brave and Perplexity web_search providers.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }
      const freshness = rawFreshness ? normalizeFreshness(rawFreshness) : undefined;
      if (rawFreshness && !freshness) {
        return jsonResult({
          error: "invalid_freshness",
          message:
            "freshness must be one of pd, pw, pm, py, or a range like YYYY-MM-DDtoYYYY-MM-DD.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }
      if (provider === "openai" && !openaiModel) {
        return jsonResult({
          error: "missing_openai_model",
          message:
            "web_search (openai) needs a model. Set tools.web.search.openai.model, use an OpenAI agent model, or choose a different provider.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }

      const executeSearch = async (providerOverride?: (typeof SEARCH_PROVIDERS)[number]) => {
        const selected = providerOverride ?? provider;
        const selectedKey =
          selected === "openai"
            ? openaiApiKey
            : selected === "perplexity"
              ? perplexityAuth?.apiKey
              : selected === "grok"
                ? grokApiKey
                : braveApiKey;
        if (!selectedKey) {
          return jsonResult(missingSearchKeyPayload(selected));
        }
        const result = await runWebSearch({
          query,
          count: resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
          apiKey: selectedKey,
          timeoutSeconds: resolveTimeoutSeconds(search?.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS),
          cacheTtlMs: resolveCacheTtlMs(search?.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES),
          provider: selected,
          country,
          search_lang,
          ui_lang,
          freshness,
          openaiBaseUrl,
          openaiModel: openaiModel ?? "",
          perplexityBaseUrl: resolvePerplexityBaseUrl(
            perplexityConfig,
            perplexityAuth?.source,
            perplexityAuth?.apiKey,
          ),
          perplexityModel: resolvePerplexityModel(perplexityConfig),
          grokModel: resolveGrokModel(grokConfig),
          grokInlineCitations: resolveGrokInlineCitations(grokConfig),
        });
        return jsonResult(result);
      };

      if (provider !== "openai") {
        return executeSearch();
      }

      try {
        return await executeSearch();
      } catch (error) {
        if (!(error instanceof OpenAiWebSearchUnsupportedError)) {
          throw error;
        }
        const fallbackProvider = braveApiKey
          ? "brave"
          : perplexityAuth?.apiKey
            ? "perplexity"
            : grokApiKey
              ? "grok"
              : undefined;
        if (!fallbackProvider) {
          return jsonResult({
            error: "unsupported_openai_web_search",
            message:
              "OpenAI web_search is not supported by this endpoint, and no fallback provider is configured.",
            docs: "https://docs.openclaw.ai/tools/web",
          });
        }
        return executeSearch(fallbackProvider);
      }
    },
  };
}

export const __testing = {
  inferPerplexityBaseUrlFromApiKey,
  resolvePerplexityBaseUrl,
  isDirectPerplexityBaseUrl,
  resolvePerplexityRequestModel,
  normalizeFreshness,
  freshnessToPerplexityRecency,
  resolveOpenAiModel,
  resolveOpenAiBaseUrl,
  resolveOpenAiApiKeySync,
  resolveGrokApiKey,
  resolveGrokModel,
  resolveGrokInlineCitations,
  extractGrokContent,
  extractOpenAiContent,
  extractOpenAiCitations,
  isOpenAiWebSearchUnsupported,
} as const;
