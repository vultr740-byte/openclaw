import { Type } from "@sinclair/typebox";
import crypto from "node:crypto";
import { normalizeDeliveryContext } from "../../utils/delivery-context.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readNumberParam, readStringParam } from "./common.js";
import { callGatewayTool } from "./gateway.js";

const FOLLOWUP_ACTIONS = ["schedule", "cancel"] as const;

const DEFAULT_INTERVAL_MS = 30_000;
const MAX_DURATION_MS = 10 * 60_000;

const FollowupToolSchema = Type.Object({
  action: stringEnum(FOLLOWUP_ACTIONS),
  task: Type.Optional(Type.String()),
  label: Type.Optional(Type.String()),
  jobId: Type.Optional(Type.String()),
  maxDurationMs: Type.Optional(Type.Number({ minimum: 1000 })),
});

function clampDurationMs(raw: number | undefined, fallback: number) {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fallback;
  }
  const normalized = Math.max(1000, Math.floor(raw));
  return Math.min(Math.max(normalized, DEFAULT_INTERVAL_MS), MAX_DURATION_MS);
}

function buildFollowupPrompt(params: {
  task: string;
  sessionKey?: string;
  intervalMs: number;
  expiresAtMs: number;
}) {
  const lines = [
    "Follow-up polling task.",
    `Interval: ${Math.round(params.intervalMs / 1000)}s`,
    `Expires: ${new Date(params.expiresAtMs).toISOString()}`,
  ];
  if (params.sessionKey) {
    lines.push(
      `Session context key: ${params.sessionKey} (use sessions_history if you need context).`,
    );
  }
  lines.push(
    "If the requested result is NOT ready yet, reply with HEARTBEAT_OK and nothing else.",
    "If ready, provide the full response now.",
    "Do not send messages via tools; return plain text only.",
    "",
    `Task: ${params.task}`,
  );
  return lines.join("\n");
}

export function createFollowupTool(opts?: {
  agentSessionKey?: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
}): AnyAgentTool {
  return {
    label: "Followup",
    name: "followup",
    description:
      "Schedule a follow-up polling job when you promise to reply later. Fixed 30s interval, max 10 minutes. Reply HEARTBEAT_OK when still waiting.",
    parameters: FollowupToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      if (action === "cancel") {
        const jobId = readStringParam(params, "jobId", { required: true, label: "jobId" });
        const removed = await callGatewayTool<{ removed?: boolean }>(
          "cron.remove",
          {},
          { id: jobId },
        );
        return jsonResult({ status: "ok", removed: Boolean(removed?.removed), jobId });
      }

      if (action !== "schedule") {
        return jsonResult({ status: "error", error: `Unknown action: ${action}` });
      }

      const task = readStringParam(params, "task", { required: true, label: "task" });
      const label = readStringParam(params, "label");
      const maxDurationMs = clampDurationMs(
        readNumberParam(params, "maxDurationMs"),
        MAX_DURATION_MS,
      );

      const delivery = normalizeDeliveryContext({
        channel: opts?.agentChannel,
        to: opts?.agentTo,
        accountId: opts?.agentAccountId,
        threadId: opts?.agentThreadId,
      });

      if (!delivery?.channel || !delivery.to) {
        return jsonResult({
          status: "error",
          error: "followup.schedule requires a routable channel target",
        });
      }

      const now = Date.now();
      const expiresAtMs = now + maxDurationMs;
      const nameSuffix = label?.trim() ? label.trim() : crypto.randomUUID().slice(0, 8);
      const jobName = `followup:${nameSuffix}`;
      const prompt = buildFollowupPrompt({
        task,
        sessionKey: opts?.agentSessionKey,
        intervalMs: DEFAULT_INTERVAL_MS,
        expiresAtMs,
      });

      const job = {
        name: jobName,
        description: `Followup poll every ${Math.round(DEFAULT_INTERVAL_MS / 1000)}s until ${new Date(
          expiresAtMs,
        ).toISOString()}.`,
        schedule: {
          kind: "every",
          everyMs: DEFAULT_INTERVAL_MS,
          anchorMs: now + DEFAULT_INTERVAL_MS,
        },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message: prompt,
          timeoutSeconds: 60,
        },
        delivery: {
          mode: "announce",
          channel: delivery.channel,
          to: delivery.to,
          accountId: delivery.accountId,
          threadId: delivery.threadId,
        },
        followup: {
          expiresAtMs,
          stopOnReply: true,
        },
      };

      const created = await callGatewayTool<{ id?: string }>("cron.add", {}, job);
      return jsonResult({
        status: "scheduled",
        jobId: created?.id,
        intervalMs: DEFAULT_INTERVAL_MS,
        expiresAtMs,
      });
    },
  };
}
