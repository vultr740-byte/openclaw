import path from "node:path";
import { analyzeShellCommand } from "../infra/exec-approvals-analysis.js";
import { extractShellWrapperInlineCommand } from "../infra/exec-wrapper-resolution.js";
import { splitShellArgs } from "../utils/shell-argv.js";

const LIFECYCLE_ACTIONS = new Set(["run", "start", "stop", "restart"] as const);
const HELP_FLAGS = new Set(["-h", "--help"]);
const WRAPPER_BINARIES = new Set(["sudo", "command", "nohup", "time"]);
const MAX_INLINE_SHELL_WRAPPER_DEPTH = 4;

type LifecycleAction = "run" | "start" | "stop" | "restart";

export type GatewayLifecycleCommandMatch = {
  action: LifecycleAction;
};

function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

function resolveOpenClawCommandIndex(tokens: string[]): number {
  if (tokens.length === 0) {
    return -1;
  }

  let cursor = 0;

  while (cursor < tokens.length && isEnvAssignment(tokens[cursor])) {
    cursor += 1;
  }

  if (tokens[cursor] === "env") {
    cursor += 1;
    while (cursor < tokens.length) {
      const token = tokens[cursor];
      if (token.startsWith("-") || isEnvAssignment(token)) {
        cursor += 1;
        continue;
      }
      break;
    }
  }

  while (cursor < tokens.length && WRAPPER_BINARIES.has(tokens[cursor])) {
    cursor += 1;
    while (cursor < tokens.length && tokens[cursor].startsWith("-")) {
      cursor += 1;
    }
  }

  if (cursor >= tokens.length) {
    return -1;
  }
  return path.basename(tokens[cursor]) === "openclaw" ? cursor : -1;
}

function detectGatewayLifecycleInTokens(tokens: string[]): GatewayLifecycleCommandMatch | null {
  if (!tokens || tokens.length === 0) {
    return null;
  }

  const openclawIndex = resolveOpenClawCommandIndex(tokens);
  if (openclawIndex < 0) {
    return null;
  }

  for (let gatewayIndex = openclawIndex + 1; gatewayIndex < tokens.length; gatewayIndex += 1) {
    if (tokens[gatewayIndex] !== "gateway") {
      continue;
    }
    const subcommand = tokens[gatewayIndex + 1];
    if (!subcommand || subcommand.startsWith("-")) {
      const tail = tokens.slice(gatewayIndex + 1);
      if (tail.some((token) => HELP_FLAGS.has(token))) {
        continue;
      }
      return { action: "run" };
    }
    if (LIFECYCLE_ACTIONS.has(subcommand as LifecycleAction)) {
      return { action: subcommand as LifecycleAction };
    }
  }

  return null;
}

function detectGatewayLifecycleInSegmentArgv(
  argv: string[],
  depth: number,
): GatewayLifecycleCommandMatch | null {
  const directMatch = detectGatewayLifecycleInTokens(argv);
  if (directMatch) {
    return directMatch;
  }
  if (depth >= MAX_INLINE_SHELL_WRAPPER_DEPTH) {
    return null;
  }
  const inlineCommand = extractShellWrapperInlineCommand(argv)?.trim();
  if (!inlineCommand) {
    return null;
  }
  return detectGatewayLifecycleInShellCommand(inlineCommand, depth + 1);
}

function detectGatewayLifecycleInShellCommand(
  command: string,
  depth: number,
): GatewayLifecycleCommandMatch | null {
  const analysis = analyzeShellCommand({
    command,
    platform: process.platform,
  });
  if (analysis.ok && analysis.segments.length > 0) {
    for (const segment of analysis.segments) {
      const detected = detectGatewayLifecycleInSegmentArgv(segment.argv, depth);
      if (detected) {
        return detected;
      }
    }
    return null;
  }
  const fallbackTokens = splitShellArgs(command);
  if (!fallbackTokens || fallbackTokens.length === 0) {
    return null;
  }
  return detectGatewayLifecycleInSegmentArgv(fallbackTokens, depth);
}

export function detectGatewayLifecycleCommand(
  command: string,
): GatewayLifecycleCommandMatch | null {
  const trimmed = command.trim();
  if (!trimmed) {
    return null;
  }
  return detectGatewayLifecycleInShellCommand(trimmed, 0);
}
