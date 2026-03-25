import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { isTruthyEnvValue } from "../infra/env.js";

const RAW_STREAM_MODES = ["full", "final"] as const;

type RawStreamMode = (typeof RAW_STREAM_MODES)[number];

let rawStreamReadyPath: string | null = null;
let invalidRawStreamModeValue: string | null = null;

function resolveRawStreamPath(): string {
  return (
    process.env.OPENCLAW_RAW_STREAM_PATH?.trim() ||
    path.join(resolveStateDir(), "logs", "raw-stream.jsonl")
  );
}

function resolveRawStreamMode(): RawStreamMode {
  const raw = process.env.OPENCLAW_RAW_STREAM_MODE;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) {
    invalidRawStreamModeValue = null;
    return "full";
  }
  const normalized = trimmed.toLowerCase();
  if (normalized === "full" || normalized === "final") {
    invalidRawStreamModeValue = null;
    return normalized;
  }
  if (invalidRawStreamModeValue !== trimmed) {
    invalidRawStreamModeValue = trimmed;
    process.stderr.write(
      `[openclaw] Ignoring invalid OPENCLAW_RAW_STREAM_MODE="${trimmed}" (allowed: ${RAW_STREAM_MODES.join("|")}).\n`,
    );
  }
  return "full";
}

function shouldAppendRawStream(payload: Record<string, unknown>): boolean {
  if (!isTruthyEnvValue(process.env.OPENCLAW_RAW_STREAM)) {
    return false;
  }
  if (resolveRawStreamMode() === "full") {
    return true;
  }
  return payload.event === "assistant_message_end";
}

export function appendRawStream(payload: Record<string, unknown>) {
  if (!shouldAppendRawStream(payload)) {
    return;
  }
  const rawStreamPath = resolveRawStreamPath();
  if (rawStreamReadyPath !== rawStreamPath) {
    rawStreamReadyPath = rawStreamPath;
    try {
      fs.mkdirSync(path.dirname(rawStreamPath), { recursive: true });
    } catch {
      // ignore raw stream mkdir failures
    }
  }
  try {
    void fs.promises.appendFile(rawStreamPath, `${JSON.stringify(payload)}\n`);
  } catch {
    // ignore raw stream write failures
  }
}
