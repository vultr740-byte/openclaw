type ToolMetaEntry = { toolName: string; meta?: string };
type LastToolError = {
  toolName: string;
  error?: string;
};

const DELEGATION_PATTERNS = [
  /\b(?:can|could)\s+you\s+(?:please\s+)?(?:run|execute)\b/i,
  /\b(?:please\s+)?(?:you\s+)?(?:run|execute)\s+(?:this|the following)\b/i,
  /\b(?:you\s+(?:can|should|need to|must)\s+(?:run|execute))\b/i,
  /(?:请|你)(?:先)?(?:在[^\n。；:：]{0,20})?(?:终端|服务器|机器|环境)?(?:上)?(?:执行|运行)/,
  /(?:你(?:可以|需要|应该))(?:先)?(?:执行|运行)/,
] as const;

const COMMAND_HINT_PATTERNS = [
  /```[\s\S]{0,1200}(?:npm|pnpm|yarn|bun|pip|python|node|apt(?:-get)?|brew|openclaw|railway|docker|git|clawhub)[\s\S]{0,1200}```/i,
  /`[^`\n]*(?:npm|pnpm|yarn|bun|pip|python|node|apt(?:-get)?|brew|openclaw|railway|docker|git|clawhub)[^`\n]*`/i,
  /(^|\n)\s*(?:npm|pnpm|yarn|bun|pip|python|node|apt(?:-get)?|brew|openclaw|railway|docker|git|clawhub)\b/m,
] as const;

const PASSIVE_TOOL_PREFIXES = ["message", "sessions_send"] as const;

const PERMISSION_BLOCKED_KEYWORDS = [
  "permission denied",
  "access denied",
  "not allowed",
  "forbidden",
  "unauthorized",
  "requires approval",
  "requires elevated",
  "sandbox",
  "eacces",
  "operation not permitted",
  "no sudo",
] as const;

function looksLikeUserDelegation(text: string): boolean {
  if (!text.trim()) {
    return false;
  }
  return DELEGATION_PATTERNS.some((pattern) => pattern.test(text));
}

function hasCommandHint(text: string): boolean {
  if (!text.trim()) {
    return false;
  }
  return COMMAND_HINT_PATTERNS.some((pattern) => pattern.test(text));
}

function hasSelfWorkToolCall(toolMetas: ToolMetaEntry[] | undefined): boolean {
  if (!toolMetas?.length) {
    return false;
  }
  for (const entry of toolMetas) {
    const name = entry.toolName.trim().toLowerCase();
    if (!name) {
      continue;
    }
    if (PASSIVE_TOOL_PREFIXES.some((prefix) => name === prefix || name.startsWith(`${prefix}_`))) {
      continue;
    }
    return true;
  }
  return false;
}

function isBlockedByPermissions(lastToolError: LastToolError | undefined): boolean {
  const errorLower = lastToolError?.error?.toLowerCase() ?? "";
  if (!errorLower) {
    return false;
  }
  return PERMISSION_BLOCKED_KEYWORDS.some((keyword) => errorLower.includes(keyword));
}

export function shouldRetryWithSelfDiagnosticGuard(params: {
  assistantTexts: string[] | undefined;
  toolMetas: ToolMetaEntry[] | undefined;
  lastToolError?: LastToolError;
  disableTools?: boolean;
}): boolean {
  if (params.disableTools) {
    return false;
  }
  if (!params.assistantTexts?.length) {
    return false;
  }
  if (hasSelfWorkToolCall(params.toolMetas)) {
    return false;
  }
  if (isBlockedByPermissions(params.lastToolError)) {
    return false;
  }

  return params.assistantTexts.some(
    (text) => looksLikeUserDelegation(text) && hasCommandHint(text),
  );
}
