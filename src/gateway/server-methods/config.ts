import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { listChannelPlugins } from "../../channels/plugins/index.js";
import {
  CONFIG_PATH,
  loadConfig,
  parseConfigJson5,
  readConfigFileSnapshot,
  readConfigFileSnapshotForWrite,
  resolveConfigSnapshotHash,
  validateConfigObjectWithPlugins,
  writeConfigFile,
} from "../../config/config.js";
import { applyLegacyMigrations } from "../../config/legacy.js";
import { applyMergePatch } from "../../config/merge-patch.js";
import {
  redactConfigObject,
  redactConfigSnapshot,
  restoreRedactedValues,
} from "../../config/redact-snapshot.js";
import {
  buildConfigSchema,
  lookupConfigSchema,
  type ConfigSchemaResponse,
} from "../../config/schema.js";
import { extractDeliveryInfo } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  formatDoctorNonInteractiveHint,
  type RestartSentinelPayload,
  writeRestartSentinel,
} from "../../infra/restart-sentinel.js";
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import { isPlainObject } from "../../utils.js";
import { diffConfigPaths } from "../config-reload.js";
import {
  formatControlPlaneActor,
  resolveControlPlaneActor,
  summarizeChangedPaths,
} from "../control-plane-audit.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateConfigApplyParams,
  validateConfigGetParams,
  validateConfigPatchParams,
  validateConfigSchemaLookupParams,
  validateConfigSchemaLookupResult,
  validateConfigSchemaParams,
  validateConfigSetParams,
} from "../protocol/index.js";
import { resolveBaseHashParam } from "./base-hash.js";
import { parseRestartRequestParams } from "./restart-request.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

type ConfigPatchRemoveByIdOp = {
  op: "removeById";
  path: string;
  id: string;
};

type ConfigPatchOp = ConfigPatchRemoveByIdOp;

type ConfigPatchOpSummaryEntry = {
  op: ConfigPatchOp["op"];
  path: string;
  id: string;
  removed: boolean;
};

type ConfigPatchOpsSummary = {
  total: number;
  removed: number;
  missing: number;
  details: ConfigPatchOpSummaryEntry[];
};

function requireConfigBaseHash(
  params: unknown,
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
  respond: RespondFn,
): boolean {
  if (!snapshot.exists) {
    return true;
  }
  const snapshotHash = resolveConfigSnapshotHash(snapshot);
  if (!snapshotHash) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "config base hash unavailable; re-run config.get and retry",
      ),
    );
    return false;
  }
  const baseHash = resolveBaseHashParam(params);
  if (!baseHash) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "config base hash required; re-run config.get and retry",
      ),
    );
    return false;
  }
  if (baseHash !== snapshotHash) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "config changed since last load; re-run config.get and retry",
      ),
    );
    return false;
  }
  return true;
}

function parseRawConfigOrRespond(
  params: unknown,
  requestName: string,
  respond: RespondFn,
): string | null {
  const rawValue = (params as { raw?: unknown }).raw;
  if (typeof rawValue !== "string") {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid ${requestName} params: raw (string) required`,
      ),
    );
    return null;
  }
  return rawValue;
}

function sanitizeLookupPathForLog(path: string): string {
  const sanitized = Array.from(path, (char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? "?" : char;
  }).join("");
  return sanitized.length > 120 ? `${sanitized.slice(0, 117)}...` : sanitized;
}

function parseValidateConfigFromRawOrRespond(
  params: unknown,
  requestName: string,
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
  respond: RespondFn,
): { config: OpenClawConfig; schema: ConfigSchemaResponse } | null {
  const rawValue = parseRawConfigOrRespond(params, requestName, respond);
  if (!rawValue) {
    return null;
  }
  const parsedRes = parseConfigJson5(rawValue);
  if (!parsedRes.ok) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, parsedRes.error));
    return null;
  }
  const schema = loadSchemaWithPlugins();
  const restored = restoreRedactedValues(parsedRes.parsed, snapshot.config, schema.uiHints);
  if (!restored.ok) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, restored.humanReadableMessage ?? "invalid config"),
    );
    return null;
  }
  const validated = validateConfigObjectWithPlugins(restored.result);
  if (!validated.ok) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "invalid config", {
        details: { issues: validated.issues },
      }),
    );
    return null;
  }
  return { config: validated.config, schema };
}

function parseConfigPatchRawObjectOrRespond(
  params: unknown,
  respond: RespondFn,
): Record<string, unknown> | null {
  const rawValue = (params as { raw?: unknown }).raw;
  if (rawValue === undefined) {
    return {};
  }
  if (typeof rawValue !== "string") {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "invalid config.patch params: raw (string) required when provided",
      ),
    );
    return null;
  }
  const parsedRes = parseConfigJson5(rawValue);
  if (!parsedRes.ok) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, parsedRes.error));
    return null;
  }
  if (!isPlainObject(parsedRes.parsed)) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "config.patch raw must be an object"),
    );
    return null;
  }
  return parsedRes.parsed;
}

function parseConfigPatchOpsOrRespond(params: unknown, respond: RespondFn): ConfigPatchOp[] | null {
  const opsValue = (params as { ops?: unknown }).ops;
  if (opsValue === undefined) {
    return [];
  }
  if (!Array.isArray(opsValue)) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "config.patch ops must be an array"),
    );
    return null;
  }
  const parsedOps: ConfigPatchOp[] = [];
  for (const [index, candidate] of opsValue.entries()) {
    if (!isPlainObject(candidate)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `config.patch ops[${index}] must be an object with op/path/id`,
        ),
      );
      return null;
    }
    const op = typeof candidate.op === "string" ? candidate.op.trim() : "";
    const path = typeof candidate.path === "string" ? candidate.path.trim() : "";
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    if (op !== "removeById" || !path || !id) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `config.patch ops[${index}] requires { op: "removeById", path, id }`,
        ),
      );
      return null;
    }
    parsedOps.push({ op: "removeById", path, id });
  }
  return parsedOps;
}

function splitConfigPath(pathValue: string): string[] {
  return pathValue
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function applyConfigPatchOps(
  config: OpenClawConfig,
  ops: ConfigPatchOp[],
):
  | { ok: true; config: OpenClawConfig; summary: ConfigPatchOpsSummary }
  | { ok: false; error: string } {
  const result = structuredClone(config);
  const details: ConfigPatchOpSummaryEntry[] = [];
  let removed = 0;

  for (const [index, op] of ops.entries()) {
    const segments = splitConfigPath(op.path);
    if (segments.length === 0) {
      return {
        ok: false,
        error: `config.patch ops[${index}] path must be non-empty`,
      };
    }

    const parentSegments = segments.slice(0, -1);
    const leafKey = segments.at(-1);
    if (!leafKey) {
      return {
        ok: false,
        error: `config.patch ops[${index}] path must be non-empty`,
      };
    }

    let cursor: unknown = result;
    for (const segment of parentSegments) {
      if (!isPlainObject(cursor)) {
        return {
          ok: false,
          error: `config.patch ops[${index}] path "${op.path}" is invalid at "${segment}"`,
        };
      }
      if (!Object.hasOwn(cursor, segment)) {
        return {
          ok: false,
          error: `config.patch ops[${index}] path "${op.path}" not found`,
        };
      }
      cursor = cursor[segment];
    }

    if (!isPlainObject(cursor) || !Object.hasOwn(cursor, leafKey)) {
      return {
        ok: false,
        error: `config.patch ops[${index}] path "${op.path}" not found`,
      };
    }

    const target = cursor[leafKey];
    if (!Array.isArray(target)) {
      return {
        ok: false,
        error: `config.patch ops[${index}] path "${op.path}" must point to an array`,
      };
    }

    const filtered = target.filter((entry) => {
      if (!isPlainObject(entry)) {
        return true;
      }
      return entry.id !== op.id;
    });
    const opRemoved = filtered.length < target.length;
    if (opRemoved) {
      removed += 1;
      cursor[leafKey] = filtered;
    }
    details.push({
      op: "removeById",
      path: op.path,
      id: op.id,
      removed: opRemoved,
    });
  }

  return {
    ok: true,
    config: result,
    summary: {
      total: details.length,
      removed,
      missing: details.length - removed,
      details,
    },
  };
}

function resolveConfigRestartRequest(params: unknown): {
  sessionKey: string | undefined;
  note: string | undefined;
  restartDelayMs: number | undefined;
  deliveryContext: ReturnType<typeof extractDeliveryInfo>["deliveryContext"];
  threadId: ReturnType<typeof extractDeliveryInfo>["threadId"];
} {
  const { sessionKey, note, restartDelayMs } = parseRestartRequestParams(params);

  // Extract deliveryContext + threadId for routing after restart
  // Supports both :thread: (most channels) and :topic: (Telegram)
  const { deliveryContext, threadId } = extractDeliveryInfo(sessionKey);

  return {
    sessionKey,
    note,
    restartDelayMs,
    deliveryContext,
    threadId,
  };
}

function buildConfigRestartSentinelPayload(params: {
  kind: RestartSentinelPayload["kind"];
  mode: string;
  sessionKey: string | undefined;
  deliveryContext: ReturnType<typeof extractDeliveryInfo>["deliveryContext"];
  threadId: ReturnType<typeof extractDeliveryInfo>["threadId"];
  note: string | undefined;
}): RestartSentinelPayload {
  return {
    kind: params.kind,
    status: "ok",
    ts: Date.now(),
    sessionKey: params.sessionKey,
    deliveryContext: params.deliveryContext,
    threadId: params.threadId,
    message: params.note ?? null,
    doctorHint: formatDoctorNonInteractiveHint(),
    stats: {
      mode: params.mode,
      root: CONFIG_PATH,
    },
  };
}

async function tryWriteRestartSentinelPayload(
  payload: RestartSentinelPayload,
): Promise<string | null> {
  try {
    return await writeRestartSentinel(payload);
  } catch {
    return null;
  }
}

function loadSchemaWithPlugins(): ConfigSchemaResponse {
  const cfg = loadConfig();
  const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
  const pluginRegistry = loadOpenClawPlugins({
    config: cfg,
    cache: true,
    workspaceDir,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  });
  // Note: We can't easily cache this, as there are no callback that can invalidate
  // our cache. However, both loadConfig() and loadOpenClawPlugins() already cache
  // their results, and buildConfigSchema() is just a cheap transformation.
  return buildConfigSchema({
    plugins: pluginRegistry.plugins.map((plugin) => ({
      id: plugin.id,
      name: plugin.name,
      description: plugin.description,
      configUiHints: plugin.configUiHints,
      configSchema: plugin.configJsonSchema,
    })),
    channels: listChannelPlugins().map((entry) => ({
      id: entry.id,
      label: entry.meta.label,
      description: entry.meta.blurb,
      configSchema: entry.configSchema?.schema,
      configUiHints: entry.configSchema?.uiHints,
    })),
  });
}

export const configHandlers: GatewayRequestHandlers = {
  "config.get": async ({ params, respond }) => {
    if (!assertValidParams(params, validateConfigGetParams, "config.get", respond)) {
      return;
    }
    const snapshot = await readConfigFileSnapshot();
    const schema = loadSchemaWithPlugins();
    respond(true, redactConfigSnapshot(snapshot, schema.uiHints), undefined);
  },
  "config.schema": ({ params, respond }) => {
    if (!assertValidParams(params, validateConfigSchemaParams, "config.schema", respond)) {
      return;
    }
    respond(true, loadSchemaWithPlugins(), undefined);
  },
  "config.schema.lookup": ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validateConfigSchemaLookupParams, "config.schema.lookup", respond)
    ) {
      return;
    }
    const path = (params as { path: string }).path;
    const schema = loadSchemaWithPlugins();
    const result = lookupConfigSchema(schema, path);
    if (!result) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "config schema path not found"),
      );
      return;
    }
    if (!validateConfigSchemaLookupResult(result)) {
      const errors = validateConfigSchemaLookupResult.errors ?? [];
      context.logGateway.warn(
        `config.schema.lookup produced invalid payload for ${sanitizeLookupPathForLog(path)}: ${formatValidationErrors(errors)}`,
      );
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "config.schema.lookup returned invalid payload", {
          details: { errors },
        }),
      );
      return;
    }
    respond(true, result, undefined);
  },
  "config.set": async ({ params, respond }) => {
    if (!assertValidParams(params, validateConfigSetParams, "config.set", respond)) {
      return;
    }
    const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
    if (!requireConfigBaseHash(params, snapshot, respond)) {
      return;
    }
    const parsed = parseValidateConfigFromRawOrRespond(params, "config.set", snapshot, respond);
    if (!parsed) {
      return;
    }
    await writeConfigFile(parsed.config, writeOptions);
    respond(
      true,
      {
        ok: true,
        path: CONFIG_PATH,
        config: redactConfigObject(parsed.config, parsed.schema.uiHints),
      },
      undefined,
    );
  },
  "config.patch": async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateConfigPatchParams, "config.patch", respond)) {
      return;
    }
    const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
    if (!requireConfigBaseHash(params, snapshot, respond)) {
      return;
    }
    if (!snapshot.valid) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid config; fix before patching"),
      );
      return;
    }
    const patchObject = parseConfigPatchRawObjectOrRespond(params, respond);
    if (!patchObject) {
      return;
    }
    const patchOps = parseConfigPatchOpsOrRespond(params, respond);
    if (!patchOps) {
      return;
    }
    if ((params as { raw?: unknown }).raw === undefined && patchOps.length === 0) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "config.patch requires either raw (object string) or ops",
        ),
      );
      return;
    }
    const merged = applyMergePatch(snapshot.config, patchObject, {
      mergeObjectArraysById: true,
    });
    let mergedConfig = merged as OpenClawConfig;
    let patchOpsSummary: ConfigPatchOpsSummary | undefined;
    if (patchOps.length > 0) {
      const opsResult = applyConfigPatchOps(mergedConfig, patchOps);
      if (!opsResult.ok) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, opsResult.error));
        return;
      }
      mergedConfig = opsResult.config;
      patchOpsSummary = opsResult.summary;
    }
    const schemaPatch = loadSchemaWithPlugins();
    const restoredMerge = restoreRedactedValues(mergedConfig, snapshot.config, schemaPatch.uiHints);
    if (!restoredMerge.ok) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          restoredMerge.humanReadableMessage ?? "invalid config",
        ),
      );
      return;
    }
    const migrated = applyLegacyMigrations(restoredMerge.result);
    const resolved = migrated.next ?? restoredMerge.result;
    const validated = validateConfigObjectWithPlugins(resolved);
    if (!validated.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid config", {
          details: { issues: validated.issues },
        }),
      );
      return;
    }
    const changedPaths = diffConfigPaths(snapshot.config, validated.config);
    const actor = resolveControlPlaneActor(client);
    context?.logGateway?.info(
      `config.patch write ${formatControlPlaneActor(actor)} changedPaths=${summarizeChangedPaths(changedPaths)} restartReason=config.patch`,
    );
    await writeConfigFile(validated.config, writeOptions);

    const { sessionKey, note, restartDelayMs, deliveryContext, threadId } =
      resolveConfigRestartRequest(params);
    const payload = buildConfigRestartSentinelPayload({
      kind: "config-patch",
      mode: "config.patch",
      sessionKey,
      deliveryContext,
      threadId,
      note,
    });
    const sentinelPath = await tryWriteRestartSentinelPayload(payload);
    const restart = scheduleGatewaySigusr1Restart({
      delayMs: restartDelayMs,
      reason: "config.patch",
      audit: {
        actor: actor.actor,
        deviceId: actor.deviceId,
        clientIp: actor.clientIp,
        changedPaths,
      },
    });
    if (restart.coalesced) {
      context?.logGateway?.warn(
        `config.patch restart coalesced ${formatControlPlaneActor(actor)} delayMs=${restart.delayMs}`,
      );
    }
    respond(
      true,
      {
        ok: true,
        path: CONFIG_PATH,
        config: redactConfigObject(validated.config, schemaPatch.uiHints),
        restart,
        sentinel: {
          path: sentinelPath,
          payload,
        },
        patch: patchOpsSummary ? { ops: patchOpsSummary } : undefined,
      },
      undefined,
    );
  },
  "config.apply": async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateConfigApplyParams, "config.apply", respond)) {
      return;
    }
    const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
    if (!requireConfigBaseHash(params, snapshot, respond)) {
      return;
    }
    const parsed = parseValidateConfigFromRawOrRespond(params, "config.apply", snapshot, respond);
    if (!parsed) {
      return;
    }
    const changedPaths = diffConfigPaths(snapshot.config, parsed.config);
    const actor = resolveControlPlaneActor(client);
    context?.logGateway?.info(
      `config.apply write ${formatControlPlaneActor(actor)} changedPaths=${summarizeChangedPaths(changedPaths)} restartReason=config.apply`,
    );
    await writeConfigFile(parsed.config, writeOptions);

    const { sessionKey, note, restartDelayMs, deliveryContext, threadId } =
      resolveConfigRestartRequest(params);
    const payload = buildConfigRestartSentinelPayload({
      kind: "config-apply",
      mode: "config.apply",
      sessionKey,
      deliveryContext,
      threadId,
      note,
    });
    const sentinelPath = await tryWriteRestartSentinelPayload(payload);
    const restart = scheduleGatewaySigusr1Restart({
      delayMs: restartDelayMs,
      reason: "config.apply",
      audit: {
        actor: actor.actor,
        deviceId: actor.deviceId,
        clientIp: actor.clientIp,
        changedPaths,
      },
    });
    if (restart.coalesced) {
      context?.logGateway?.warn(
        `config.apply restart coalesced ${formatControlPlaneActor(actor)} delayMs=${restart.delayMs}`,
      );
    }
    respond(
      true,
      {
        ok: true,
        path: CONFIG_PATH,
        config: redactConfigObject(parsed.config, parsed.schema.uiHints),
        restart,
        sentinel: {
          path: sentinelPath,
          payload,
        },
      },
      undefined,
    );
  },
};
