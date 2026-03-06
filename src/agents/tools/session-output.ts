import { callGateway } from "../../gateway/call.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import { readLatestAssistantReply } from "./agent-step.js";
import { extractAssistantText, sanitizeTextContent } from "./sessions-helpers.js";

type ToolResultMessage = {
  role?: unknown;
  content?: unknown;
};

function extractToolResultText(content: unknown): string {
  if (typeof content === "string") {
    return sanitizeTextContent(content);
  }
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const obj = content as {
      text?: unknown;
      output?: unknown;
      content?: unknown;
      result?: unknown;
      error?: unknown;
      summary?: unknown;
    };
    if (typeof obj.text === "string") {
      return sanitizeTextContent(obj.text);
    }
    if (typeof obj.output === "string") {
      return sanitizeTextContent(obj.output);
    }
    if (typeof obj.content === "string") {
      return sanitizeTextContent(obj.content);
    }
    if (typeof obj.result === "string") {
      return sanitizeTextContent(obj.result);
    }
    if (typeof obj.error === "string") {
      return sanitizeTextContent(obj.error);
    }
    if (typeof obj.summary === "string") {
      return sanitizeTextContent(obj.summary);
    }
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const joined = extractTextFromChatContent(content, {
    sanitizeText: sanitizeTextContent,
    normalizeText: (text) => text,
    joinWith: "\n",
  });
  return joined?.trim() ?? "";
}

function extractInlineTextContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return (
    extractTextFromChatContent(content, {
      sanitizeText: sanitizeTextContent,
      normalizeText: (text) => text.trim(),
      joinWith: "",
    }) ?? ""
  );
}

export function extractSessionOutputText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const role = (message as { role?: unknown }).role;
  const content = (message as { content?: unknown }).content;
  if (role === "assistant") {
    const assistantText = extractAssistantText(message);
    if (assistantText) {
      return assistantText;
    }
    if (typeof content === "string") {
      return sanitizeTextContent(content);
    }
    if (Array.isArray(content)) {
      return extractInlineTextContent(content);
    }
    return "";
  }
  if (role === "toolResult" || role === "tool") {
    return extractToolResultText((message as ToolResultMessage).content);
  }
  if (role == null) {
    if (typeof content === "string") {
      return sanitizeTextContent(content);
    }
    if (Array.isArray(content)) {
      return extractInlineTextContent(content);
    }
  }
  return "";
}

export async function readLatestSessionOutput(params: {
  sessionKey: string;
  limit?: number;
}): Promise<string | undefined> {
  try {
    const latestAssistant = await readLatestAssistantReply({
      sessionKey: params.sessionKey,
      limit: params.limit,
    });
    if (latestAssistant?.trim()) {
      return latestAssistant;
    }
  } catch {
    // Best-effort: fall back to richer history parsing below.
  }
  const history = await callGateway<{ messages?: Array<unknown> }>({
    method: "chat.history",
    params: { sessionKey: params.sessionKey, limit: params.limit ?? 50 },
  });
  const messages = Array.isArray(history?.messages) ? history.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = extractSessionOutputText(messages[i]);
    if (text) {
      return text;
    }
  }
  return undefined;
}
