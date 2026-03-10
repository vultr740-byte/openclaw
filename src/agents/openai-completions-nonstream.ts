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

type ContextMessage = Context["messages"][number];
type AssistantContextMessage = Extract<ContextMessage, { role: "assistant" }>;
type AssistantContextBlock = AssistantContextMessage["content"][number];
type ToolResultContextMessage = Extract<ContextMessage, { role: "toolResult" }>;
type OpenAIRequestMessage = {
  role?: string;
  content?: unknown;
  [key: string]: unknown;
};

function sanitizeSurrogates(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "",
  );
}

function normalizeToolCallId(model: Model<"openai-completions">, id: string): string {
  if (id.includes("|")) {
    const [callId] = id.split("|");
    return callId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
  }
  if (model.provider === "openai") {
    return id.length > 40 ? id.slice(0, 40) : id;
  }
  return id;
}

function createSyntheticToolResult(toolCall: ToolCall): ToolResultContextMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text: "No result provided" }],
    isError: true,
    timestamp: Date.now(),
  };
}

function transformMessagesForRequest(
  messages: Context["messages"],
  model: Model<"openai-completions">,
): Context["messages"] {
  const toolCallIdMap = new Map<string, string>();
  const transformed = messages.map((msg): ContextMessage => {
    if (msg.role === "user") {
      return msg;
    }

    if (msg.role === "toolResult") {
      const normalizedId = toolCallIdMap.get(msg.toolCallId);
      return normalizedId && normalizedId !== msg.toolCallId
        ? { ...msg, toolCallId: normalizedId }
        : msg;
    }

    const isSameModel =
      msg.provider === model.provider && msg.api === model.api && msg.model === model.id;
    const transformedContent: AssistantContextMessage["content"] = [];
    for (const block of msg.content) {
      if (block.type === "thinking") {
        if (block.redacted) {
          if (isSameModel) {
            transformedContent.push(block);
          }
          continue;
        }
        if (isSameModel && block.thinkingSignature) {
          transformedContent.push(block);
          continue;
        }
        if (!block.thinking || block.thinking.trim() === "") {
          continue;
        }
        transformedContent.push(
          isSameModel ? block : ({ type: "text", text: block.thinking } as AssistantContextBlock),
        );
        continue;
      }

      if (block.type === "text") {
        transformedContent.push(
          isSameModel ? block : ({ type: "text", text: block.text } as AssistantContextBlock),
        );
        continue;
      }

      if (block.type === "toolCall") {
        let normalizedToolCall = block;
        if (!isSameModel && block.thoughtSignature) {
          normalizedToolCall = { ...block };
          delete normalizedToolCall.thoughtSignature;
        }
        if (!isSameModel) {
          const normalizedId = normalizeToolCallId(model, block.id);
          if (normalizedId !== block.id) {
            toolCallIdMap.set(block.id, normalizedId);
            normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
          }
        }
        transformedContent.push(normalizedToolCall);
        continue;
      }

      transformedContent.push(block);
    }

    return {
      ...msg,
      content: transformedContent,
    };
  });

  const result: Context["messages"] = [];
  let pendingToolCalls: ToolCall[] = [];
  let existingToolResultIds = new Set<string>();
  for (const msg of transformed) {
    if (msg.role === "assistant") {
      if (pendingToolCalls.length > 0) {
        for (const toolCall of pendingToolCalls) {
          if (!existingToolResultIds.has(toolCall.id)) {
            result.push(createSyntheticToolResult(toolCall));
          }
        }
        pendingToolCalls = [];
        existingToolResultIds = new Set<string>();
      }

      if (msg.stopReason === "error" || msg.stopReason === "aborted") {
        continue;
      }

      pendingToolCalls = msg.content.filter(
        (block): block is ToolCall => block.type === "toolCall",
      );
      if (pendingToolCalls.length > 0) {
        existingToolResultIds = new Set<string>();
      }
      result.push(msg);
      continue;
    }

    if (msg.role === "toolResult") {
      existingToolResultIds.add(msg.toolCallId);
      result.push(msg);
      continue;
    }

    if (pendingToolCalls.length > 0) {
      for (const toolCall of pendingToolCalls) {
        if (!existingToolResultIds.has(toolCall.id)) {
          result.push(createSyntheticToolResult(toolCall));
        }
      }
      pendingToolCalls = [];
      existingToolResultIds = new Set<string>();
    }
    result.push(msg);
  }

  return result;
}

function convertMessagesForRequest(
  model: Model<"openai-completions">,
  context: Context,
  compat: Required<OpenAICompletionsCompat>,
): OpenAIRequestMessage[] {
  const params: OpenAIRequestMessage[] = [];
  const transformedMessages = transformMessagesForRequest(context.messages, model);
  if (context.systemPrompt) {
    const useDeveloperRole = model.reasoning && compat.supportsDeveloperRole;
    params.push({
      role: useDeveloperRole ? "developer" : "system",
      content: sanitizeSurrogates(context.systemPrompt),
    });
  }

  let lastRole: ContextMessage["role"] | null = null;
  for (let i = 0; i < transformedMessages.length; i += 1) {
    const msg = transformedMessages[i];
    if (
      compat.requiresAssistantAfterToolResult &&
      lastRole === "toolResult" &&
      msg.role === "user"
    ) {
      params.push({
        role: "assistant",
        content: "I have processed the tool results.",
      });
    }

    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        params.push({
          role: "user",
          content: sanitizeSurrogates(msg.content),
        });
      } else {
        const content = msg.content.map((item) =>
          item.type === "text"
            ? {
                type: "text",
                text: sanitizeSurrogates(item.text),
              }
            : {
                type: "image_url",
                image_url: {
                  url: `data:${item.mimeType};base64,${item.data}`,
                },
              },
        );
        const filteredContent = model.input.includes("image")
          ? content
          : content.filter((item) => item.type !== "image_url");
        if (filteredContent.length === 0) {
          continue;
        }
        params.push({
          role: "user",
          content: filteredContent,
        });
      }
      lastRole = msg.role;
      continue;
    }

    if (msg.role === "assistant") {
      const assistantMsg: OpenAIRequestMessage = {
        role: "assistant",
        content: compat.requiresAssistantAfterToolResult ? "" : null,
      };
      const textBlocks = msg.content.filter((block) => block.type === "text");
      const nonEmptyTextBlocks = textBlocks.filter(
        (block) => block.text && block.text.trim().length > 0,
      );
      if (nonEmptyTextBlocks.length > 0) {
        assistantMsg.content =
          model.provider === "github-copilot"
            ? nonEmptyTextBlocks.map((block) => sanitizeSurrogates(block.text)).join("")
            : nonEmptyTextBlocks.map((block) => ({
                type: "text",
                text: sanitizeSurrogates(block.text),
              }));
      }

      const thinkingBlocks = msg.content.filter((block) => block.type === "thinking");
      const nonEmptyThinkingBlocks = thinkingBlocks.filter(
        (block) => block.thinking && block.thinking.trim().length > 0,
      );
      if (nonEmptyThinkingBlocks.length > 0) {
        if (compat.requiresThinkingAsText) {
          const thinkingText = nonEmptyThinkingBlocks.map((block) => block.thinking).join("\n\n");
          const textContent = assistantMsg.content;
          if (Array.isArray(textContent)) {
            textContent.unshift({ type: "text", text: thinkingText });
          } else if (typeof textContent === "string" && textContent.length > 0) {
            assistantMsg.content = [
              { type: "text", text: thinkingText },
              { type: "text", text: textContent },
            ];
          } else {
            assistantMsg.content = [{ type: "text", text: thinkingText }];
          }
        } else {
          const signature = nonEmptyThinkingBlocks[0].thinkingSignature;
          if (signature && signature.length > 0) {
            assistantMsg[signature] = nonEmptyThinkingBlocks
              .map((block) => block.thinking)
              .join("\n");
          }
        }
      }

      const toolCalls = msg.content.filter((block) => block.type === "toolCall");
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: "function",
          function: {
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.arguments),
          },
        }));
        const reasoningDetails = toolCalls
          .filter((toolCall) => toolCall.thoughtSignature)
          .map((toolCall) => {
            try {
              return JSON.parse(toolCall.thoughtSignature ?? "");
            } catch {
              return null;
            }
          })
          .filter((detail): detail is Record<string, unknown> => !!detail);
        if (reasoningDetails.length > 0) {
          assistantMsg.reasoning_details = reasoningDetails;
        }
      }

      const content = assistantMsg.content;
      const hasContent =
        content !== null &&
        content !== undefined &&
        (typeof content === "string"
          ? content.length > 0
          : Array.isArray(content) && content.length > 0);
      if (!hasContent && !assistantMsg.tool_calls) {
        continue;
      }
      params.push(assistantMsg);
      lastRole = msg.role;
      continue;
    }

    const imageBlocks: Array<{
      type: "image_url";
      image_url: { url: string };
    }> = [];
    let j = i;
    for (; j < transformedMessages.length && transformedMessages[j].role === "toolResult"; j += 1) {
      const toolMsg = transformedMessages[j] as ToolResultContextMessage;
      const textResult = toolMsg.content
        .filter((contentItem) => contentItem.type === "text")
        .map((contentItem) => contentItem.text)
        .join("\n");
      const hasImages = toolMsg.content.some((contentItem) => contentItem.type === "image");
      const toolResultMsg: OpenAIRequestMessage = {
        role: "tool",
        content: sanitizeSurrogates(textResult.length > 0 ? textResult : "(see attached image)"),
        tool_call_id: toolMsg.toolCallId,
      };
      if (compat.requiresToolResultName && toolMsg.toolName) {
        toolResultMsg.name = toolMsg.toolName;
      }
      params.push(toolResultMsg);
      if (hasImages && model.input.includes("image")) {
        for (const block of toolMsg.content) {
          if (block.type === "image") {
            imageBlocks.push({
              type: "image_url",
              image_url: {
                url: `data:${block.mimeType};base64,${block.data}`,
              },
            });
          }
        }
      }
    }
    i = j - 1;
    if (imageBlocks.length > 0) {
      if (compat.requiresAssistantAfterToolResult) {
        params.push({
          role: "assistant",
          content: "I have processed the tool results.",
        });
      }
      params.push({
        role: "user",
        content: [
          {
            type: "text",
            text: "Attached image(s) from tool result:",
          },
          ...imageBlocks,
        ],
      });
      lastRole = "user";
    } else {
      lastRole = "toolResult";
    }
  }

  return params;
}

function mapReasoningEffort(
  effort: NonNullable<OpenAICompatStreamOptions["reasoningEffort"]>,
  reasoningEffortMap: Required<OpenAICompletionsCompat>["reasoningEffortMap"],
): string {
  return reasoningEffortMap[effort] ?? effort;
}

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
  const isGroq = provider === "groq" || baseUrl.includes("groq.com");
  const isMistral = provider === "mistral" || baseUrl.includes("mistral.ai");
  const reasoningEffortMap =
    isGroq && model.id === "qwen/qwen3-32b"
      ? {
          minimal: "default",
          low: "default",
          medium: "default",
          high: "default",
          xhigh: "default",
        }
      : {};

  const detected: Required<OpenAICompletionsCompat> = {
    supportsStore: !isNonStandard,
    supportsDeveloperRole: !isNonStandard,
    supportsReasoningEffort: !isGrok && !isZai,
    reasoningEffortMap,
    supportsUsageInStreaming: true,
    maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
    requiresToolResultName: isMistral,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: isMistral,
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
    reasoningEffortMap: compat.reasoningEffortMap ?? detected.reasoningEffortMap,
    supportsUsageInStreaming: compat.supportsUsageInStreaming ?? detected.supportsUsageInStreaming,
    maxTokensField: compat.maxTokensField ?? detected.maxTokensField,
    requiresToolResultName: compat.requiresToolResultName ?? detected.requiresToolResultName,
    requiresAssistantAfterToolResult:
      compat.requiresAssistantAfterToolResult ?? detected.requiresAssistantAfterToolResult,
    requiresThinkingAsText: compat.requiresThinkingAsText ?? detected.requiresThinkingAsText,
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
  const messages = convertMessagesForRequest(model, context, compat);
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
    params.reasoning_effort = mapReasoningEffort(
      options.reasoningEffort,
      compat.reasoningEffortMap,
    );
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
        const payloadOverride = await requestOptions?.onPayload?.(params, openaiModel);
        const requestPayload =
          payloadOverride && typeof payloadOverride === "object"
            ? (payloadOverride as Record<string, unknown>)
            : params;

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
          body: JSON.stringify(requestPayload),
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
