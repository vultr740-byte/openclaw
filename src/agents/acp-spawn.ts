import crypto from "node:crypto";
import { getAcpSessionManager } from "../acp/control-plane/manager.js";
import {
  cleanupFailedAcpSpawn,
  type AcpSpawnRuntimeCloseHandle,
} from "../acp/control-plane/spawn.js";
import { isAcpEnabledByPolicy, resolveAcpAgentPolicyError } from "../acp/policy.js";
import {
  resolveAcpSessionCwd,
  resolveAcpThreadSessionDetailLines,
} from "../acp/runtime/session-identifiers.js";
import type { AcpRuntimeSessionMode } from "../acp/runtime/types.js";
import {
  resolveThreadBindingIntroText,
  resolveThreadBindingThreadName,
} from "../channels/thread-bindings-messages.js";
import {
  formatThreadBindingDisabledError,
  formatThreadBindingSpawnDisabledError,
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
  resolveThreadBindingSpawnPolicy,
} from "../channels/thread-bindings-policy.js";
import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { callGateway } from "../gateway/call.js";
import { logVerbose } from "../globals.js";
import { resolveConversationIdFromTargets } from "../infra/outbound/conversation-id.js";
import {
  getSessionBindingService,
  isSessionBindingError,
  type SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import type { AgentInternalEvent } from "./internal-events.js";
import { resolveSandboxRuntimeStatus } from "./sandbox/runtime-status.js";
import { readLatestAssistantReply } from "./tools/agent-step.js";

export const ACP_SPAWN_MODES = ["run", "session"] as const;
export type SpawnAcpMode = (typeof ACP_SPAWN_MODES)[number];
export const ACP_SPAWN_SANDBOX_MODES = ["inherit", "require"] as const;
export type SpawnAcpSandboxMode = (typeof ACP_SPAWN_SANDBOX_MODES)[number];

export type SpawnAcpParams = {
  task: string;
  label?: string;
  agentId?: string;
  cwd?: string;
  mode?: SpawnAcpMode;
  thread?: boolean;
  sandbox?: SpawnAcpSandboxMode;
  /**
   * Overrides config `acp.spawn.deliverInitialRun` for this spawn call.
   * Defaults to config behavior (enabled unless explicitly false).
   */
  deliverInitialRun?: boolean;
};

export type SpawnAcpContext = {
  agentSessionKey?: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  sandboxed?: boolean;
};

export type SpawnAcpResult = {
  status: "accepted" | "forbidden" | "error";
  childSessionKey?: string;
  runId?: string;
  mode?: SpawnAcpMode;
  note?: string;
  error?: string;
};

export const ACP_SPAWN_ACCEPTED_NOTE =
  "initial ACP task queued in isolated session; follow-ups continue in the bound thread.";
export const ACP_SPAWN_SESSION_ACCEPTED_NOTE =
  "thread-bound ACP session stays active after this task; continue in-thread for follow-ups.";

type PreparedAcpThreadBinding = {
  channel: string;
  accountId: string;
  conversationId: string;
};

const ACP_SPAWN_COMPLETION_WAIT_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const ACP_SPAWN_COMPLETION_RESULT_MAX_CHARS = 4_000;
const ACP_SPAWN_COMPLETION_NOTIFY_MESSAGE =
  "A spawned ACP task completed. Use the internal completion context to continue orchestration, and avoid duplicating user-visible output that ACP already delivered.";

function resolveSpawnMode(params: {
  requestedMode?: SpawnAcpMode;
  threadRequested: boolean;
}): SpawnAcpMode {
  if (params.requestedMode === "run" || params.requestedMode === "session") {
    return params.requestedMode;
  }
  // Thread-bound spawns should default to persistent sessions.
  return params.threadRequested ? "session" : "run";
}

function resolveAcpSessionMode(mode: SpawnAcpMode): AcpRuntimeSessionMode {
  return mode === "session" ? "persistent" : "oneshot";
}

function resolveTargetAcpAgentId(params: {
  requestedAgentId?: string;
  cfg: OpenClawConfig;
}): { ok: true; agentId: string } | { ok: false; error: string } {
  const requested = normalizeOptionalAgentId(params.requestedAgentId);
  if (requested) {
    return { ok: true, agentId: requested };
  }

  const configuredDefault = normalizeOptionalAgentId(params.cfg.acp?.defaultAgent);
  if (configuredDefault) {
    return { ok: true, agentId: configuredDefault };
  }

  return {
    ok: false,
    error:
      "ACP target agent is not configured. Pass `agentId` in `sessions_spawn` or set `acp.defaultAgent` in config.",
  };
}

function normalizeOptionalAgentId(value: string | undefined | null): string | undefined {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return undefined;
  }
  return normalizeAgentId(trimmed);
}

function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "error";
}

function truncateAcpCompletionResult(text: string): string {
  const normalized = text.trim();
  if (!normalized) {
    return "(no output)";
  }
  if (normalized.length <= ACP_SPAWN_COMPLETION_RESULT_MAX_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, ACP_SPAWN_COMPLETION_RESULT_MAX_CHARS)}\n...(truncated)`;
}

function resolveAcpCompletionStatus(params: { waitStatus?: string; waitError?: string }): {
  status: "ok" | "timeout" | "error" | "unknown";
  statusLabel: string;
} {
  const waitStatus = params.waitStatus?.trim().toLowerCase();
  if (waitStatus === "ok") {
    return { status: "ok", statusLabel: "completed successfully" };
  }
  if (waitStatus === "timeout") {
    return { status: "timeout", statusLabel: "timed out before completion" };
  }
  if (waitStatus === "error") {
    return {
      status: "error",
      statusLabel: `failed: ${(params.waitError?.trim() || "unknown error").slice(0, 240)}`,
    };
  }
  return { status: "unknown", statusLabel: "finished with unknown status" };
}

async function notifyRequesterOnAcpSpawnCompletion(params: {
  requesterSessionKey?: string;
  childSessionKey: string;
  childRunId: string;
  task: string;
  label?: string;
  spawnMode: SpawnAcpMode;
}) {
  const requesterSessionKey = params.requesterSessionKey?.trim();
  if (!requesterSessionKey) {
    return;
  }

  let waitStatus: string | undefined;
  let waitError: string | undefined;
  try {
    const wait = await callGateway<{ status?: string; error?: string }>({
      method: "agent.wait",
      params: {
        runId: params.childRunId,
        timeoutMs: ACP_SPAWN_COMPLETION_WAIT_TIMEOUT_MS,
      },
      timeoutMs: ACP_SPAWN_COMPLETION_WAIT_TIMEOUT_MS + 5_000,
    });
    waitStatus = typeof wait?.status === "string" ? wait.status : undefined;
    waitError = typeof wait?.error === "string" ? wait.error : undefined;
  } catch (err) {
    waitStatus = "error";
    waitError = summarizeError(err);
  }

  let resultText = "(no output)";
  try {
    const latestReply = await readLatestAssistantReply({
      sessionKey: params.childSessionKey,
      limit: 50,
    });
    resultText = truncateAcpCompletionResult(latestReply ?? "");
  } catch (err) {
    logVerbose(
      `acp-spawn: failed to read ACP completion output for ${params.childSessionKey}: ${summarizeError(err)}`,
    );
  }

  const completion = resolveAcpCompletionStatus({ waitStatus, waitError });
  const taskLabel = params.label?.trim() || params.task.trim() || "ACP task";
  const announceType = params.spawnMode === "session" ? "acp session task" : "acp task";
  const internalEvent: AgentInternalEvent = {
    type: "task_completion",
    source: "acp",
    childSessionKey: params.childSessionKey,
    announceType,
    taskLabel,
    status: completion.status,
    statusLabel: completion.statusLabel,
    result: resultText,
    replyInstruction:
      "Treat this as an orchestration state update. The ACP child result may already be posted in the bound chat. Do not resend duplicate user-facing content unless explicitly requested.",
  };

  try {
    await callGateway({
      method: "agent",
      params: {
        message: ACP_SPAWN_COMPLETION_NOTIFY_MESSAGE,
        sessionKey: requesterSessionKey,
        deliver: false,
        internalEvents: [internalEvent],
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: params.childSessionKey,
          sourceTool: "sessions_spawn",
        },
        idempotencyKey: `acp-spawn-completion:${params.childRunId}`,
      },
      timeoutMs: 10_000,
    });
  } catch (err) {
    logVerbose(
      `acp-spawn: failed to notify requester session ${requesterSessionKey}: ${summarizeError(err)}`,
    );
  }
}

function resolveConversationIdForThreadBinding(params: {
  to?: string;
  threadId?: string | number;
}): string | undefined {
  return resolveConversationIdFromTargets({
    threadId: params.threadId,
    targets: [params.to],
  });
}

function prepareAcpThreadBinding(params: {
  cfg: OpenClawConfig;
  channel?: string;
  accountId?: string;
  to?: string;
  threadId?: string | number;
}): { ok: true; binding: PreparedAcpThreadBinding } | { ok: false; error: string } {
  const channel = params.channel?.trim().toLowerCase();
  if (!channel) {
    return {
      ok: false,
      error: "thread=true for ACP sessions requires a channel context.",
    };
  }

  const accountId = params.accountId?.trim() || "default";
  const policy = resolveThreadBindingSpawnPolicy({
    cfg: params.cfg,
    channel,
    accountId,
    kind: "acp",
  });
  if (!policy.enabled) {
    return {
      ok: false,
      error: formatThreadBindingDisabledError({
        channel: policy.channel,
        accountId: policy.accountId,
        kind: "acp",
      }),
    };
  }
  if (!policy.spawnEnabled) {
    return {
      ok: false,
      error: formatThreadBindingSpawnDisabledError({
        channel: policy.channel,
        accountId: policy.accountId,
        kind: "acp",
      }),
    };
  }
  const bindingService = getSessionBindingService();
  const capabilities = bindingService.getCapabilities({
    channel: policy.channel,
    accountId: policy.accountId,
  });
  if (!capabilities.adapterAvailable) {
    return {
      ok: false,
      error: `Thread bindings are unavailable for ${policy.channel}.`,
    };
  }
  if (!capabilities.bindSupported || !capabilities.placements.includes("child")) {
    return {
      ok: false,
      error: `Thread bindings do not support ACP thread spawn for ${policy.channel}.`,
    };
  }
  const conversationId = resolveConversationIdForThreadBinding({
    to: params.to,
    threadId: params.threadId,
  });
  if (!conversationId) {
    return {
      ok: false,
      error: `Could not resolve a ${policy.channel} conversation for ACP thread spawn.`,
    };
  }

  return {
    ok: true,
    binding: {
      channel: policy.channel,
      accountId: policy.accountId,
      conversationId,
    },
  };
}

export async function spawnAcpDirect(
  params: SpawnAcpParams,
  ctx: SpawnAcpContext,
): Promise<SpawnAcpResult> {
  const cfg = loadConfig();
  if (!isAcpEnabledByPolicy(cfg)) {
    return {
      status: "forbidden",
      error: "ACP is disabled by policy (`acp.enabled=false`).",
    };
  }
  const sandboxMode = params.sandbox === "require" ? "require" : "inherit";
  const requesterRuntime = resolveSandboxRuntimeStatus({
    cfg,
    sessionKey: ctx.agentSessionKey,
  });
  const requesterSandboxed = ctx.sandboxed === true || requesterRuntime.sandboxed;
  if (requesterSandboxed) {
    return {
      status: "forbidden",
      error:
        'Sandboxed sessions cannot spawn ACP sessions because runtime="acp" runs on the host. Use runtime="subagent" from sandboxed sessions.',
    };
  }
  if (sandboxMode === "require") {
    return {
      status: "forbidden",
      error:
        'sessions_spawn sandbox="require" is unsupported for runtime="acp" because ACP sessions run outside the sandbox. Use runtime="subagent" or sandbox="inherit".',
    };
  }

  const requestThreadBinding = params.thread === true;
  const spawnMode = resolveSpawnMode({
    requestedMode: params.mode,
    threadRequested: requestThreadBinding,
  });
  if (spawnMode === "session" && !requestThreadBinding) {
    return {
      status: "error",
      error: 'mode="session" requires thread=true so the ACP session can stay bound to a thread.',
    };
  }

  const targetAgentResult = resolveTargetAcpAgentId({
    requestedAgentId: params.agentId,
    cfg,
  });
  if (!targetAgentResult.ok) {
    return {
      status: "error",
      error: targetAgentResult.error,
    };
  }
  const targetAgentId = targetAgentResult.agentId;
  const agentPolicyError = resolveAcpAgentPolicyError(cfg, targetAgentId);
  if (agentPolicyError) {
    return {
      status: "forbidden",
      error: agentPolicyError.message,
    };
  }

  const sessionKey = `agent:${targetAgentId}:acp:${crypto.randomUUID()}`;
  const runtimeMode = resolveAcpSessionMode(spawnMode);

  let preparedBinding: PreparedAcpThreadBinding | null = null;
  if (requestThreadBinding) {
    const prepared = prepareAcpThreadBinding({
      cfg,
      channel: ctx.agentChannel,
      accountId: ctx.agentAccountId,
      to: ctx.agentTo,
      threadId: ctx.agentThreadId,
    });
    if (!prepared.ok) {
      return {
        status: "error",
        error: prepared.error,
      };
    }
    preparedBinding = prepared.binding;
  }

  const acpManager = getAcpSessionManager();
  const bindingService = getSessionBindingService();
  let binding: SessionBindingRecord | null = null;
  let sessionCreated = false;
  let initializedRuntime: AcpSpawnRuntimeCloseHandle | undefined;
  try {
    await callGateway({
      method: "sessions.patch",
      params: {
        key: sessionKey,
        ...(params.label ? { label: params.label } : {}),
      },
      timeoutMs: 10_000,
    });
    sessionCreated = true;
    const initialized = await acpManager.initializeSession({
      cfg,
      sessionKey,
      agent: targetAgentId,
      mode: runtimeMode,
      cwd: params.cwd,
      backendId: cfg.acp?.backend,
    });
    initializedRuntime = {
      runtime: initialized.runtime,
      handle: initialized.handle,
    };

    if (preparedBinding) {
      binding = await bindingService.bind({
        targetSessionKey: sessionKey,
        targetKind: "session",
        conversation: {
          channel: preparedBinding.channel,
          accountId: preparedBinding.accountId,
          conversationId: preparedBinding.conversationId,
        },
        placement: "child",
        metadata: {
          threadName: resolveThreadBindingThreadName({
            agentId: targetAgentId,
            label: params.label || targetAgentId,
          }),
          agentId: targetAgentId,
          label: params.label || undefined,
          boundBy: "system",
          introText: resolveThreadBindingIntroText({
            agentId: targetAgentId,
            label: params.label || undefined,
            idleTimeoutMs: resolveThreadBindingIdleTimeoutMsForChannel({
              cfg,
              channel: preparedBinding.channel,
              accountId: preparedBinding.accountId,
            }),
            maxAgeMs: resolveThreadBindingMaxAgeMsForChannel({
              cfg,
              channel: preparedBinding.channel,
              accountId: preparedBinding.accountId,
            }),
            sessionCwd: resolveAcpSessionCwd(initialized.meta),
            sessionDetails: resolveAcpThreadSessionDetailLines({
              sessionKey,
              meta: initialized.meta,
            }),
          }),
        },
      });
      if (!binding?.conversation.conversationId) {
        throw new Error(
          `Failed to create and bind a ${preparedBinding.channel} thread for this ACP session.`,
        );
      }
    }
  } catch (err) {
    await cleanupFailedAcpSpawn({
      cfg,
      sessionKey,
      shouldDeleteSession: sessionCreated,
      deleteTranscript: true,
      runtimeCloseHandle: initializedRuntime,
    });
    return {
      status: "error",
      error: isSessionBindingError(err) ? err.message : summarizeError(err),
    };
  }

  const requesterOrigin = normalizeDeliveryContext({
    channel: ctx.agentChannel,
    accountId: ctx.agentAccountId,
    to: ctx.agentTo,
    threadId: ctx.agentThreadId,
  });
  // For thread-bound ACP spawns, force bootstrap delivery to the new child thread.
  const boundThreadIdRaw = binding?.conversation.conversationId;
  const boundThreadId = boundThreadIdRaw ? String(boundThreadIdRaw).trim() || undefined : undefined;
  const fallbackThreadIdRaw = requesterOrigin?.threadId;
  const fallbackThreadId =
    fallbackThreadIdRaw != null ? String(fallbackThreadIdRaw).trim() || undefined : undefined;
  const deliveryThreadId = boundThreadId ?? fallbackThreadId;
  const inferredDeliveryTo = boundThreadId
    ? `channel:${boundThreadId}`
    : requesterOrigin?.to?.trim() || (deliveryThreadId ? `channel:${deliveryThreadId}` : undefined);
  const deliverInitialRunByConfig = cfg.acp?.spawn?.deliverInitialRun !== false;
  const allowInitialDelivery = params.deliverInitialRun ?? deliverInitialRunByConfig;
  const hasDeliveryTarget =
    allowInitialDelivery && Boolean(requesterOrigin?.channel && inferredDeliveryTo);
  const childIdem = crypto.randomUUID();
  let childRunId: string = childIdem;
  try {
    const response = await callGateway<{ runId?: string }>({
      method: "agent",
      params: {
        message: params.task,
        sessionKey,
        channel: hasDeliveryTarget ? requesterOrigin?.channel : undefined,
        to: hasDeliveryTarget ? inferredDeliveryTo : undefined,
        accountId: hasDeliveryTarget ? (requesterOrigin?.accountId ?? undefined) : undefined,
        threadId: hasDeliveryTarget ? deliveryThreadId : undefined,
        idempotencyKey: childIdem,
        deliver: hasDeliveryTarget,
        label: params.label || undefined,
      },
      timeoutMs: 10_000,
    });
    if (typeof response?.runId === "string" && response.runId.trim()) {
      childRunId = response.runId.trim();
    }
  } catch (err) {
    await cleanupFailedAcpSpawn({
      cfg,
      sessionKey,
      shouldDeleteSession: true,
      deleteTranscript: true,
    });
    return {
      status: "error",
      error: summarizeError(err),
      childSessionKey: sessionKey,
    };
  }

  void notifyRequesterOnAcpSpawnCompletion({
    requesterSessionKey: ctx.agentSessionKey,
    childSessionKey: sessionKey,
    childRunId: childRunId,
    task: params.task,
    label: params.label,
    spawnMode,
  });

  return {
    status: "accepted",
    childSessionKey: sessionKey,
    runId: childRunId,
    mode: spawnMode,
    note: spawnMode === "session" ? ACP_SPAWN_SESSION_ACCEPTED_NOTE : ACP_SPAWN_ACCEPTED_NOTE,
  };
}
