import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager, type SessionEntry as PiSessionEntry } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import { resolveSessionFilePath } from "../config/sessions/paths.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { hasInterSessionUserProvenance } from "../sessions/input-provenance.js";
import { stripInlineDirectiveTagsForDisplay } from "../utils/directive-tags.js";
import { resolveAgentDir, resolveAgentEffectiveModelPrimary } from "./agent-scope.js";
import { clearBootstrapSnapshot } from "./bootstrap-cache.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import { parseModelRef } from "./model-selection.js";
import { runEmbeddedPiAgent } from "./pi-embedded.js";
import { DEFAULT_USER_FILENAME } from "./workspace.js";
import {
  readWorkspaceOnboardingStateForDir,
  writeWorkspaceOnboardingStateForDir,
} from "./workspace.js";

const log = createSubsystemLogger("agents/profile-inference");

const MAX_USER_TEXT_SAMPLES = 80;

type ProfileInferenceSample = {
  text: string;
  timestampMs: number;
};

type MaybeInferMissingUserProfileFieldsParams = {
  cfg: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
  storePath?: string;
  nowMs?: number;
};

type InferenceFieldStatus = "present" | "inferred" | "unknown";

export type UserProfileInferenceResult = {
  attemptedLanguage: boolean;
  attemptedTimezone: boolean;
  languageStatus?: InferenceFieldStatus;
  timezoneStatus?: InferenceFieldStatus;
};

type ProfileInferenceMessage = {
  role?: unknown;
  content?: unknown;
  provenance?: unknown;
  timestamp?: unknown;
};

type ProfileInferenceContentPart = {
  type?: unknown;
  text?: unknown;
};

type AgentInferenceResponse = {
  language?: unknown;
  timezone?: unknown;
};

function normalizeText(text: string): string {
  return stripInlineDirectiveTagsForDisplay(text).text.replace(/\s+/g, " ").trim();
}

function extractTextFromMessageContent(content: unknown): string | null {
  if (typeof content === "string") {
    const normalized = normalizeText(content);
    return normalized || null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const rawPart of content) {
    const part = rawPart as ProfileInferenceContentPart | null | undefined;
    if (!part || typeof part !== "object") {
      continue;
    }
    if (part.type !== "text" && part.type !== "input_text" && part.type !== "output_text") {
      continue;
    }
    if (typeof part.text !== "string") {
      continue;
    }
    const normalized = normalizeText(part.text);
    if (normalized) {
      parts.push(normalized);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join(" ");
}

function normalizeTimestampMs(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw < 1_000_000_000_000 ? Math.round(raw * 1000) : Math.round(raw);
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const num = Number(trimmed);
      if (!Number.isFinite(num)) {
        return null;
      }
      return trimmed.includes(".") || trimmed.length < 13
        ? Math.round(num * 1000)
        : Math.round(num);
    }
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function isDirectSession(sessionKey: string, entry: SessionEntry | undefined): boolean {
  if (entry?.chatType === "group" || entry?.chatType === "channel") {
    return false;
  }
  if (entry?.chatType === "direct") {
    return true;
  }
  if (entry?.groupId?.trim()) {
    return false;
  }
  if (sessionKey === "global") {
    return false;
  }
  if (sessionKey.includes(":group:") || sessionKey.includes(":channel:")) {
    return false;
  }
  const parsed = parseAgentSessionKey(sessionKey);
  const rest = parsed?.rest ?? sessionKey;
  if (rest === "main") {
    return true;
  }
  if (rest.includes(":direct:")) {
    return true;
  }
  return !rest.includes(":group:") && !rest.includes(":channel:");
}

function collectUserSamplesFromEntries(entries: PiSessionEntry[]): ProfileInferenceSample[] {
  const samples: ProfileInferenceSample[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") {
      continue;
    }
    const message = entry.message as ProfileInferenceMessage;
    if (message.role !== "user") {
      continue;
    }
    if (hasInterSessionUserProvenance(message)) {
      continue;
    }
    const text = extractTextFromMessageContent(message.content);
    if (!text) {
      continue;
    }
    const timestampMs = normalizeTimestampMs(message.timestamp ?? entry.timestamp);
    if (timestampMs == null || !Number.isFinite(timestampMs)) {
      continue;
    }
    samples.push({ text, timestampMs });
  }
  return samples;
}

function formatSampleTimestamp(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function buildTranscriptEvidence(samples: ProfileInferenceSample[]): string {
  if (samples.length === 0) {
    return "No recent direct-user transcript evidence was available.";
  }
  return samples
    .slice(-MAX_USER_TEXT_SAMPLES)
    .map(
      (sample, index) =>
        `${index + 1}. [${formatSampleTimestamp(sample.timestampMs)} UTC] ${sample.text}`,
    )
    .join("\n");
}

function buildInferencePrompt(params: {
  evidence: string;
  nowIso: string;
  languageNeedsInference: boolean;
  timezoneNeedsInference: boolean;
}): string {
  const missingFields = [
    params.languageNeedsInference ? "language" : null,
    params.timezoneNeedsInference ? "timezone" : null,
  ].filter((value): value is string => Boolean(value));
  return [
    "You are running a one-time profile completion pass for USER.md.",
    "",
    `Current time: ${params.nowIso}`,
    "",
    "Your job:",
    "1. Read USER.md from the workspace.",
    "2. Decide whether the user's preferred language is already expressed anywhere in USER.md.",
    "3. Decide whether the user's timezone is already expressed anywhere in USER.md.",
    "4. If either value is missing, infer it from the transcript evidence below when the evidence is strong enough.",
    "5. If you infer a missing value, update USER.md directly with the smallest reasonable edit.",
    "6. Do not add machine-only blocks, metadata sections, or agent-managed markers.",
    "7. If USER.md already conveys the value semantically, do not rewrite it just to normalize wording.",
    "8. If evidence is weak or ambiguous, leave USER.md unchanged for that field.",
    "",
    "Important constraints:",
    "- Only care about language and timezone for this task.",
    "- Prefer minimal edits that preserve the human-facing style of USER.md.",
    "- Timezone should use an IANA timezone when you add one, such as Asia/Shanghai or America/New_York.",
    "- Language can be a short natural value such as zh, en, Chinese, or English; preserve the surrounding document style.",
    `- Only infer these fields in this pass: ${missingFields.join(", ") || "none"}.`,
    "- Re-read USER.md before editing, and leave already-present values untouched.",
    "",
    "Transcript evidence from recent direct messages:",
    params.evidence,
    "",
    "After you finish any edits, reply with ONLY a JSON object using this exact shape:",
    '{"language":"present|inferred|unknown","timezone":"present|inferred|unknown"}',
  ].join("\n");
}

function buildInspectionPrompt(params: { nowIso: string }): string {
  return [
    "You are running a one-time profile inspection pass for USER.md.",
    "",
    `Current time: ${params.nowIso}`,
    "",
    "Your job:",
    "1. Read USER.md from the workspace.",
    "2. Decide whether the user's preferred language is already expressed anywhere in USER.md.",
    "3. Decide whether the user's timezone is already expressed anywhere in USER.md.",
    "4. Do not infer from transcript history in this pass.",
    "5. Do not edit USER.md in this pass.",
    "",
    "Important constraints:",
    "- Judge presence semantically, not by fixed field names.",
    "- If USER.md already conveys the value in any reasonable human-readable way, return present.",
    "- If the value is not expressed in USER.md, return unknown.",
    "",
    "Reply with ONLY a JSON object using this exact shape:",
    '{"language":"present|unknown","timezone":"present|unknown"}',
  ].join("\n");
}

function normalizeFieldStatus(raw: unknown): InferenceFieldStatus | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "present" || trimmed === "inferred" || trimmed === "unknown") {
    return trimmed;
  }
  return undefined;
}

function parseAgentInferenceResponse(text: string): {
  languageStatus?: InferenceFieldStatus;
  timezoneStatus?: InferenceFieldStatus;
} {
  const trimmed = text.trim();
  const codeFenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = (codeFenceMatch?.[1] ?? trimmed).trim();
  try {
    const parsed = JSON.parse(candidate) as AgentInferenceResponse;
    return {
      languageStatus: normalizeFieldStatus(parsed.language),
      timezoneStatus: normalizeFieldStatus(parsed.timezone),
    };
  } catch {
    return {};
  }
}

async function collectTranscriptSamples(params: {
  agentId: string;
  storePath: string;
}): Promise<ProfileInferenceSample[]> {
  let store: Record<string, SessionEntry>;
  try {
    store = loadSessionStore(params.storePath, { skipCache: true });
  } catch (error) {
    log.warn("profile inference: failed to load session store", {
      agentId: params.agentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }

  const allSamples: ProfileInferenceSample[] = [];
  for (const [sessionKey, entry] of Object.entries(store)) {
    if (!isDirectSession(sessionKey, entry)) {
      continue;
    }
    if (!entry?.sessionId) {
      continue;
    }
    try {
      const sessionFile =
        typeof entry.sessionFile === "string" && entry.sessionFile.trim()
          ? entry.sessionFile.trim()
          : resolveSessionFilePath(entry.sessionId, entry, {
              sessionsDir: path.dirname(params.storePath),
              agentId: params.agentId,
            });
      const opened = SessionManager.open(sessionFile);
      const samples = collectUserSamplesFromEntries(opened.getEntries());
      allSamples.push(...samples);
    } catch {
      // Best-effort only; skip missing or corrupt transcripts.
    }
  }

  allSamples.sort((left, right) => left.timestampMs - right.timestampMs);
  return allSamples.slice(-MAX_USER_TEXT_SAMPLES);
}

async function runProfileInferenceAgent(params: {
  cfg: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
  prompt: string;
}): Promise<{
  languageStatus?: InferenceFieldStatus;
  timezoneStatus?: InferenceFieldStatus;
}> {
  const agentDir = resolveAgentDir(params.cfg, params.agentId);
  const modelRef = resolveAgentEffectiveModelPrimary(params.cfg, params.agentId);
  const parsed = modelRef ? parseModelRef(modelRef, DEFAULT_PROVIDER) : null;
  const provider = parsed?.provider ?? DEFAULT_PROVIDER;
  const model = parsed?.model ?? DEFAULT_MODEL;

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-profile-inference-"));
  const sessionFile = path.join(tempDir, "session.jsonl");
  const sessionId = `profile-inference-${Date.now().toString(36)}`;

  try {
    const result = await runEmbeddedPiAgent({
      sessionId,
      sessionKey: `temp:profile-inference:${params.agentId}`,
      agentId: params.agentId,
      sessionFile,
      workspaceDir: params.workspaceDir,
      agentDir,
      config: params.cfg,
      prompt: params.prompt,
      provider,
      model,
      timeoutMs: 45_000,
      runId: `profile-inference-${Date.now().toString(36)}`,
      trigger: "heartbeat",
      bootstrapContextMode: "full",
      bootstrapContextRunKind: "heartbeat",
      suppressToolErrorWarnings: true,
    });

    const text = result.payloads?.find((payload) => typeof payload.text === "string")?.text;
    if (!text) {
      return {};
    }
    return parseAgentInferenceResponse(text);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function maybeInferMissingUserProfileFields(
  params: MaybeInferMissingUserProfileFieldsParams,
): Promise<UserProfileInferenceResult> {
  const userPath = path.join(params.workspaceDir, DEFAULT_USER_FILENAME);
  try {
    await fs.access(userPath);
  } catch {
    return { attemptedLanguage: false, attemptedTimezone: false };
  }

  const state = await readWorkspaceOnboardingStateForDir(params.workspaceDir);
  const shouldAttemptLanguage = !state.languageInferenceAttemptedAt;
  const shouldAttemptTimezone = !state.timezoneInferenceAttemptedAt;
  if (!shouldAttemptLanguage && !shouldAttemptTimezone) {
    return { attemptedLanguage: false, attemptedTimezone: false };
  }

  const storePath =
    params.storePath ?? resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
  const nowIso = new Date(params.nowMs ?? Date.now()).toISOString();

  let languageStatus: InferenceFieldStatus | undefined;
  let timezoneStatus: InferenceFieldStatus | undefined;
  try {
    const inspection = await runProfileInferenceAgent({
      cfg: params.cfg,
      agentId: params.agentId,
      workspaceDir: params.workspaceDir,
      prompt: buildInspectionPrompt({ nowIso }),
    });
    const needsLanguageInference = shouldAttemptLanguage && inspection.languageStatus === "unknown";
    const needsTimezoneInference = shouldAttemptTimezone && inspection.timezoneStatus === "unknown";

    languageStatus = inspection.languageStatus === "present" ? "present" : undefined;
    timezoneStatus = inspection.timezoneStatus === "present" ? "present" : undefined;

    if (needsLanguageInference || needsTimezoneInference) {
      const samples = await collectTranscriptSamples({
        agentId: params.agentId,
        storePath,
      });
      const inference = await runProfileInferenceAgent({
        cfg: params.cfg,
        agentId: params.agentId,
        workspaceDir: params.workspaceDir,
        prompt: buildInferencePrompt({
          evidence: buildTranscriptEvidence(samples),
          nowIso,
          languageNeedsInference: needsLanguageInference,
          timezoneNeedsInference: needsTimezoneInference,
        }),
      });
      if (needsLanguageInference) {
        languageStatus = inference.languageStatus;
      }
      if (needsTimezoneInference) {
        timezoneStatus = inference.timezoneStatus;
      }
    }
  } catch (error) {
    log.warn("profile inference: embedded agent run failed", {
      agentId: params.agentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const nextState = {
    ...state,
    version: state.version,
    languageInferenceAttemptedAt:
      state.languageInferenceAttemptedAt ??
      (shouldAttemptLanguage && languageStatus ? nowIso : undefined),
    timezoneInferenceAttemptedAt:
      state.timezoneInferenceAttemptedAt ??
      (shouldAttemptTimezone && timezoneStatus ? nowIso : undefined),
  };
  await writeWorkspaceOnboardingStateForDir(params.workspaceDir, nextState);
  clearBootstrapSnapshot(`temp:profile-inference:${params.agentId}`);

  return {
    attemptedLanguage: shouldAttemptLanguage && Boolean(languageStatus),
    attemptedTimezone: shouldAttemptTimezone && Boolean(timezoneStatus),
    languageStatus,
    timezoneStatus,
  };
}
