import type { StreamFn } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  Context,
  Model,
  OpenAICompletionsCompat,
  SimpleStreamOptions,
  StopReason,
  Tool,
  ToolCall,
  Usage,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream, getEnvApiKey } from "@mariozechner/pi-ai";
import { convertMessages } from "@mariozechner/pi-ai/dist/providers/openai-completions.js";

type OpenAIToolChoice =
  | "auto"
  | "none"
  | "required"
  | {
      type: "function";
      function: {
        name: string;
      };
    };

type OpenAICompatStreamOptions = SimpleStreamOptions & {
  toolChoice?: OpenAIToolChoice;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
};

type OpenAIChatCompletionTool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
};

type OpenAIChatCompletionChoice = {
  finish_reason?: "stop" | "length" | "tool_calls" | "content_filter" | null;
  message?: {
    role?: "assistant";
    content?: string | null;
    tool_calls?: Array<{
      id?: string;
      type?: "function";
      function?: {
        name?: string;
        arguments?: string | Record<string, unknown>;
      };
    }>;
    reasoning?: string;
    reasoning_content?: string;
    reasoning_text?: string;
  };
};

type OpenAIChatCompletionUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
};

type OpenAIChatCompletionResponse = {
  choices?: OpenAIChatCompletionChoice[];
  usage?: OpenAIChatCompletionUsage;
  error?: { message?: string };
};

function resolveOpenAICompat(
  model: Model<"openai-completions">,
): Required<OpenAICompletionsCompat> {
  const provider = model.provider;
  const baseUrl = model.baseUrl;
  const isZai = provider === "zai" || baseUrl.includes("api.z.ai");
  const isNonStandard =
    provider === "cerebras" ||
    baseUrl.includes("cerebras.ai") ||
    provider === "xai" ||
    baseUrl.includes("api.x.ai") ||
    provider === "mistral" ||
    baseUrl.includes("mistral.ai") ||
    baseUrl.includes("chutes.ai") ||
    baseUrl.includes("deepseek.com") ||
    isZai ||
    provider === "opencode" ||
    baseUrl.includes("opencode.ai");
  const useMaxTokens =
    provider === "mistral" || baseUrl.includes("mistral.ai") || baseUrl.includes("chutes.ai");
  const isGrok = provider === "xai" || baseUrl.includes("api.x.ai");
  const isMistral = provider === "mistral" || baseUrl.includes("mistral.ai");

  const detected: Required<OpenAICompletionsCompat> = {
    supportsStore: !isNonStandard,
    supportsDeveloperRole: !isNonStandard,
    supportsReasoningEffort: !isGrok && !isZai,
    supportsUsageInStreaming: true,
    maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
    requiresToolResultName: isMistral,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: isMistral,
    requiresMistralToolIds: isMistral,
    thinkingFormat: isZai ? "zai" : "openai",
    openRouterRouting: {},
    vercelGatewayRouting: {},
    supportsStrictMode: true,
  };

  const compat = model.compat ?? undefined;
  if (!compat) {
    return detected;
  }
  return {
    supportsStore: compat.supportsStore ?? detected.supportsStore,
    supportsDeveloperRole: compat.supportsDeveloperRole ?? detected.supportsDeveloperRole,
    supportsReasoningEffort: compat.supportsReasoningEffort ?? detected.supportsReasoningEffort,
    supportsUsageInStreaming: compat.supportsUsageInStreaming ?? detected.supportsUsageInStreaming,
    maxTokensField: compat.maxTokensField ?? detected.maxTokensField,
    requiresToolResultName: compat.requiresToolResultName ?? detected.requiresToolResultName,
    requiresAssistantAfterToolResult:
      compat.requiresAssistantAfterToolResult ?? detected.requiresAssistantAfterToolResult,
    requiresThinkingAsText: compat.requiresThinkingAsText ?? detected.requiresThinkingAsText,
    requiresMistralToolIds: compat.requiresMistralToolIds ?? detected.requiresMistralToolIds,
    thinkingFormat: compat.thinkingFormat ?? detected.thinkingFormat,
    openRouterRouting: compat.openRouterRouting ?? {},
    vercelGatewayRouting: compat.vercelGatewayRouting ?? detected.vercelGatewayRouting,
    supportsStrictMode: compat.supportsStrictMode ?? detected.supportsStrictMode,
  };
}

function hasToolHistory(messages: Context["messages"]): boolean {
  for (const msg of messages) {
    if (msg.role === "toolResult") {
      return true;
    }
    if (msg.role === "assistant" && msg.content.some((block) => block.type === "toolCall")) {
      return true;
    }
  }
  return false;
}

function convertTools(
  tools: Tool[],
  compat: Required<OpenAICompletionsCompat>,
): OpenAIChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
      ...(compat.supportsStrictMode ? { strict: false } : {}),
    },
  }));
}

function maybeAddOpenRouterAnthropicCacheControl(
  model: Model<"openai-completions">,
  messages: Array<{ role?: string; content?: unknown }>,
): void {
  if (model.provider !== "openrouter" || !model.id.startsWith("anthropic/")) {
    return;
  }

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role !== "user" && msg.role !== "assistant") {
      continue;
    }

    const content = msg.content;
    if (typeof content === "string") {
      msg.content = [
        { type: "text", text: content, cache_control: { type: "ephemeral" } } as unknown,
      ];
      return;
    }

    if (!Array.isArray(content)) {
      continue;
    }

    for (let j = content.length - 1; j >= 0; j -= 1) {
      const part = content[j] as { type?: unknown };
      if (part?.type === "text") {
        Object.assign(part, { cache_control: { type: "ephemeral" } });
        return;
      }
    }
  }
}

function resolveChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("OpenAI-compatible baseUrl is required");
  }
  if (trimmed.endsWith("/chat/completions")) {
    return trimmed;
  }
  return `${trimmed}/chat/completions`;
}

function hasHeader(headers: Record<string, string>, headerName: string): boolean {
  const normalized = headerName.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === normalized);
}

function mapStopReason(
  reason: OpenAIChatCompletionChoice["finish_reason"],
): Extract<StopReason, "stop" | "length" | "toolUse" | "error"> {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
      return "toolUse";
    case "content_filter":
      return "error";
    default:
      return "stop";
  }
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function calculateUsage(
  model: Model<"openai-completions">,
  usageLike: OpenAIChatCompletionUsage | undefined,
): Usage {
  const usage = emptyUsage();
  if (!usageLike) {
    return usage;
  }
  const cachedTokens = usageLike.prompt_tokens_details?.cached_tokens ?? 0;
  const reasoningTokens = usageLike.completion_tokens_details?.reasoning_tokens ?? 0;
  const input = Math.max(0, (usageLike.prompt_tokens ?? 0) - cachedTokens);
  const output = Math.max(0, (usageLike.completion_tokens ?? 0) + reasoningTokens);
  usage.input = input;
  usage.output = output;
  usage.cacheRead = cachedTokens;
  usage.cacheWrite = 0;
  usage.totalTokens = input + output + cachedTokens;
  usage.cost.input = (model.cost.input / 1_000_000) * usage.input;
  usage.cost.output = (model.cost.output / 1_000_000) * usage.output;
  usage.cost.cacheRead = (model.cost.cacheRead / 1_000_000) * usage.cacheRead;
  usage.cost.cacheWrite = (model.cost.cacheWrite / 1_000_000) * usage.cacheWrite;
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
  return usage;
}

function parseToolCallArgs(
  rawArgs: string | Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!rawArgs) {
    return {};
  }
  if (typeof rawArgs === "object") {
    return rawArgs;
  }
  const trimmed = rawArgs.trim();
  if (!trimmed) {
    return {};
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

function extractThinking(
  message: OpenAIChatCompletionChoice["message"],
): { text: string; signature?: string } | undefined {
  if (!message) {
    return undefined;
  }
  const candidates: Array<{ key: string; value?: string }> = [
    { key: "reasoning", value: message.reasoning },
    { key: "reasoning_content", value: message.reasoning_content },
    { key: "reasoning_text", value: message.reasoning_text },
  ];
  for (const candidate of candidates) {
    if (candidate.value && candidate.value.trim().length > 0) {
      return { text: candidate.value, signature: candidate.key };
    }
  }
  return undefined;
}

function buildAssistantMessage(
  model: Model<"openai-completions">,
  choice: OpenAIChatCompletionChoice,
  usage: Usage,
): AssistantMessage {
  const message = choice.message ?? {};
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: mapStopReason(choice.finish_reason ?? "stop"),
    timestamp: Date.now(),
  };

  const thinking = extractThinking(message);
  if (thinking) {
    output.content.push({
      type: "thinking",
      thinking: thinking.text,
      ...(thinking.signature ? { thinkingSignature: thinking.signature } : {}),
    });
  }

  if (typeof message.content === "string" && message.content.length > 0) {
    output.content.push({ type: "text", text: message.content });
  }

  if (Array.isArray(message.tool_calls)) {
    message.tool_calls.forEach((call, index) => {
      const name = call.function?.name ?? "";
      const args = parseToolCallArgs(call.function?.arguments);
      const toolCall: ToolCall = {
        type: "toolCall",
        id: call.id || `toolcall_${index + 1}`,
        name,
        arguments: args,
      };
      output.content.push(toolCall);
    });
  }

  return output;
}

function buildRequestParams(
  model: Model<"openai-completions">,
  context: Context,
  options: OpenAICompatStreamOptions | undefined,
  compat: Required<OpenAICompletionsCompat>,
): Record<string, unknown> {
  const messages = convertMessages(model, context, compat);
  maybeAddOpenRouterAnthropicCacheControl(
    model,
    messages as Array<{ role?: string; content?: unknown }>,
  );

  const params: Record<string, unknown> = {
    model: model.id,
    messages,
    stream: false,
  };

  if (compat.supportsStore) {
    params.store = false;
  }

  if (options?.maxTokens) {
    if (compat.maxTokensField === "max_tokens") {
      params.max_tokens = options.maxTokens;
    } else {
      params.max_completion_tokens = options.maxTokens;
    }
  }

  if (options?.temperature !== undefined) {
    params.temperature = options.temperature;
  }

  if (context.tools) {
    params.tools = convertTools(context.tools, compat);
  } else if (hasToolHistory(context.messages)) {
    params.tools = [];
  }

  if (options?.toolChoice) {
    params.tool_choice = options.toolChoice;
  }

  if (compat.thinkingFormat === "zai" && model.reasoning) {
    params.thinking = { type: options?.reasoningEffort ? "enabled" : "disabled" };
  } else if (compat.thinkingFormat === "qwen" && model.reasoning) {
    params.enable_thinking = Boolean(options?.reasoningEffort);
  } else if (options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
    params.reasoning_effort = options.reasoningEffort;
  }

  if (model.baseUrl.includes("openrouter.ai") && model.compat?.openRouterRouting) {
    params.provider = model.compat.openRouterRouting;
  }
  if (model.baseUrl.includes("ai-gateway.vercel.sh") && model.compat?.vercelGatewayRouting) {
    const routing = model.compat.vercelGatewayRouting;
    if (routing.only || routing.order) {
      const gatewayOptions: Record<string, string[]> = {};
      if (routing.only) {
        gatewayOptions.only = routing.only;
      }
      if (routing.order) {
        gatewayOptions.order = routing.order;
      }
      params.providerOptions = { gateway: gatewayOptions };
    }
  }

  return params;
}

export function createOpenAICompletionsNonStreamingStreamFn(): StreamFn {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      const startedAt = Date.now();
      const output: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: emptyUsage(),
        stopReason: "stop",
        timestamp: startedAt,
      };

      try {
        if (model.api !== "openai-completions") {
          throw new Error(
            `Non-streaming fallback only supports openai-completions (got ${model.api})`,
          );
        }
        const openaiModel = model as Model<"openai-completions">;
        const compat = resolveOpenAICompat(openaiModel);
        const apiKey = options?.apiKey || getEnvApiKey(openaiModel.provider);
        if (!apiKey) {
          throw new Error(`No API key for provider: ${openaiModel.provider}`);
        }

        const requestOptions = options as OpenAICompatStreamOptions | undefined;
        const params = buildRequestParams(openaiModel, context, requestOptions, compat);
        requestOptions?.onPayload?.(params);

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          ...openaiModel.headers,
        };

        if (openaiModel.provider === "github-copilot") {
          const messages = context.messages || [];
          const lastMessage = messages[messages.length - 1];
          const isAgentCall = lastMessage ? lastMessage.role !== "user" : false;
          headers["X-Initiator"] = isAgentCall ? "agent" : "user";
          headers["Openai-Intent"] = "conversation-edits";
          const hasImages = messages.some((msg) => {
            if (msg.role === "user" && Array.isArray(msg.content)) {
              return msg.content.some((c) => c.type === "image");
            }
            if (msg.role === "toolResult" && Array.isArray(msg.content)) {
              return msg.content.some((c) => c.type === "image");
            }
            return false;
          });
          if (hasImages) {
            headers["Copilot-Vision-Request"] = "true";
          }
        }

        if (requestOptions?.headers) {
          Object.assign(headers, requestOptions.headers);
        }
        if (!hasHeader(headers, "authorization")) {
          headers.Authorization = `Bearer ${apiKey}`;
        }

        const response = await fetch(resolveChatCompletionsUrl(openaiModel.baseUrl), {
          method: "POST",
          headers,
          body: JSON.stringify(params),
          signal: requestOptions?.signal,
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => "unknown error");
          throw new Error(`OpenAI-compatible API error ${response.status}: ${errorText}`);
        }

        const data = (await response.json()) as OpenAIChatCompletionResponse;
        if (data.error?.message) {
          throw new Error(data.error.message);
        }
        const choice = data.choices?.[0];
        if (!choice || !choice.message) {
          throw new Error("OpenAI-compatible API returned no choices");
        }

        const usage = calculateUsage(openaiModel, data.usage);
        const message = buildAssistantMessage(openaiModel, choice, usage);
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          if (!message.errorMessage && choice.finish_reason === "content_filter") {
            message.errorMessage = "OpenAI-compatible API blocked the response (content_filter).";
          }
          stream.push({ type: "error", reason: message.stopReason, error: message });
        } else {
          stream.push({ type: "done", reason: message.stopReason, message });
        }
      } catch (error) {
        const wasAborted = requestSignalAborted(options);
        output.stopReason = wasAborted ? "aborted" : "error";
        output.errorMessage =
          error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : JSON.stringify(error);
        stream.push({ type: "error", reason: output.stopReason, error: output });
      } finally {
        stream.end();
      }
    })();
    return stream;
  };
}

function requestSignalAborted(options: SimpleStreamOptions | undefined): boolean {
  if (!options?.signal) {
    return false;
  }
  if ("aborted" in options.signal) {
    return options.signal.aborted;
  }
  return false;
}
