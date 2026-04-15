"use strict";

const path = require("node:path");
const fs = require("node:fs");

let monolithicSdk = null;
let diagnosticEventsModule = null;
const jitiLoaders = new Map();
const pluginSdkSubpathsCache = new Map();
const fastModuleCache = new Map();
const fastExportCache = new Map();
const isDistRootAlias = __filename.includes(
  `${path.sep}dist${path.sep}plugin-sdk${path.sep}root-alias.cjs`,
);
const shouldPreferSourceGraph =
  !isDistRootAlias &&
  (process.env.NODE_ENV !== "production" ||
    Boolean(process.env.VITEST) ||
    process.env.OPENCLAW_PLUGIN_SDK_SOURCE_IN_TESTS === "1");

function emptyPluginConfigSchema() {
  function error(message) {
    return { success: false, error: { issues: [{ path: [], message }] } };
  }

  return {
    safeParse(value) {
      if (value === undefined) {
        return { success: true, data: undefined };
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return error("expected config object");
      }
      if (Object.keys(value).length > 0) {
        return error("config must be empty");
      }
      return { success: true, data: value };
    },
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  };
}

function resolveCommandAuthorizedFromAuthorizers(params) {
  const { useAccessGroups, authorizers } = params;
  const mode = params.modeWhenAccessGroupsOff ?? "allow";
  if (!useAccessGroups) {
    if (mode === "allow") {
      return true;
    }
    if (mode === "deny") {
      return false;
    }
    const anyConfigured = authorizers.some((entry) => entry.configured);
    if (!anyConfigured) {
      return true;
    }
    return authorizers.some((entry) => entry.configured && entry.allowed);
  }
  return authorizers.some((entry) => entry.configured && entry.allowed);
}

function resolveControlCommandGate(params) {
  const commandAuthorized = resolveCommandAuthorizedFromAuthorizers({
    useAccessGroups: params.useAccessGroups,
    authorizers: params.authorizers,
    modeWhenAccessGroupsOff: params.modeWhenAccessGroupsOff,
  });
  const shouldBlock = params.allowTextCommands && params.hasControlCommand && !commandAuthorized;
  return { commandAuthorized, shouldBlock };
}

function onDiagnosticEvent(listener) {
  const diagnosticEvents = loadDiagnosticEventsModule();
  if (!diagnosticEvents || typeof diagnosticEvents.onDiagnosticEvent !== "function") {
    throw new Error("openclaw/plugin-sdk root alias could not resolve onDiagnosticEvent");
  }
  return diagnosticEvents.onDiagnosticEvent(listener);
}

function getPackageRoot() {
  return path.resolve(__dirname, "..", "..");
}

function getProjectRoot() {
  return path.resolve(__dirname, "..", "..");
}

function findDistChunkByPrefix(prefix) {
  const distRoot = path.join(getPackageRoot(), "dist");
  try {
    const entries = fs.readdirSync(distRoot, { withFileTypes: true });
    const match = entries.find(
      (entry) =>
        entry.isFile() && entry.name.startsWith(`${prefix}-`) && entry.name.endsWith(".js"),
    );
    return match ? path.join(distRoot, match.name) : null;
  } catch {
    return null;
  }
}

function listPluginSdkExportedSubpaths() {
  const packageRoot = getPackageRoot();
  if (pluginSdkSubpathsCache.has(packageRoot)) {
    return pluginSdkSubpathsCache.get(packageRoot);
  }

  let subpaths = [];
  try {
    const packageJsonPath = path.join(packageRoot, "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    subpaths = Object.keys(packageJson.exports ?? {})
      .filter((key) => key.startsWith("./plugin-sdk/"))
      .map((key) => key.slice("./plugin-sdk/".length));
  } catch {
    subpaths = [];
  }

  pluginSdkSubpathsCache.set(packageRoot, subpaths);
  return subpaths;
}

function buildPluginSdkAliasMap(useDist) {
  const packageRoot = getPackageRoot();
  const pluginSdkDir = path.join(packageRoot, useDist ? "dist" : "src", "plugin-sdk");
  const ext = useDist ? ".js" : ".ts";
  const normalizeTarget = (target) =>
    process.platform === "win32" ? target.replace(/\\/g, "/") : target;
  const aliasMap = {
    "openclaw/plugin-sdk": normalizeTarget(__filename),
  };

  for (const subpath of listPluginSdkExportedSubpaths()) {
    const candidate = path.join(pluginSdkDir, `${subpath}${ext}`);
    if (fs.existsSync(candidate)) {
      aliasMap[`openclaw/plugin-sdk/${subpath}`] = normalizeTarget(candidate);
    }
  }

  return aliasMap;
}

function getJiti(tryNative) {
  const effectiveTryNative = process.platform === "win32" ? false : tryNative;

  if (jitiLoaders.has(effectiveTryNative)) {
    return jitiLoaders.get(effectiveTryNative);
  }

  const { createJiti } = require("jiti");
  const jitiLoader = createJiti(__filename, {
    alias: buildPluginSdkAliasMap(effectiveTryNative),
    interopDefault: true,
    tryNative: effectiveTryNative,
    extensions: [".ts", ".tsx", ".mts", ".cts", ".mtsx", ".ctsx", ".js", ".mjs", ".cjs", ".json"],
  });
  jitiLoaders.set(effectiveTryNative, jitiLoader);
  return jitiLoader;
}

function loadFastModule(moduleId, candidates) {
  if (fastModuleCache.has(moduleId)) {
    return fastModuleCache.get(moduleId);
  }

  const rootDir = getProjectRoot();
  for (const candidate of candidates) {
    const resolved = path.resolve(rootDir, candidate);
    if (!fs.existsSync(resolved)) {
      continue;
    }
    try {
      const tryNative = resolved.includes(`${path.sep}dist${path.sep}`);
      const loaded = getJiti(tryNative)(resolved);
      fastModuleCache.set(moduleId, loaded);
      return loaded;
    } catch {
      // Fall through to the next candidate before trying the monolithic sdk.
    }
  }

  fastModuleCache.set(moduleId, null);
  return null;
}

function loadMonolithicSdk() {
  if (monolithicSdk) {
    return monolithicSdk;
  }

  const distCandidate = path.resolve(__dirname, "..", "..", "dist", "plugin-sdk", "compat.js");
  if (!shouldPreferSourceGraph && fs.existsSync(distCandidate)) {
    try {
      monolithicSdk = getJiti(true)(distCandidate);
      return monolithicSdk;
    } catch {
      // Fall through to source alias if dist is unavailable or stale.
    }
  }

  monolithicSdk = getJiti(false)(path.join(getPackageRoot(), "src", "plugin-sdk", "compat.ts"));
  return monolithicSdk;
}

function loadDiagnosticEventsModule() {
  if (diagnosticEventsModule) {
    return diagnosticEventsModule;
  }

  const directDistCandidate = path.resolve(
    __dirname,
    "..",
    "..",
    "dist",
    "infra",
    "diagnostic-events.js",
  );
  if (!shouldPreferSourceGraph) {
    const distCandidate =
      (fs.existsSync(directDistCandidate) && directDistCandidate) ||
      findDistChunkByPrefix("diagnostic-events");
    if (distCandidate) {
      try {
        diagnosticEventsModule = normalizeDiagnosticEventsModule(getJiti(true)(distCandidate));
        return diagnosticEventsModule;
      } catch {
        // Fall through to source path if dist is unavailable or stale.
      }
    }
  }

  diagnosticEventsModule = normalizeDiagnosticEventsModule(
    getJiti(false)(path.join(getPackageRoot(), "src", "infra", "diagnostic-events.ts")),
  );
  return diagnosticEventsModule;
}

function normalizeDiagnosticEventsModule(mod) {
  if (!mod || typeof mod !== "object") {
    return mod;
  }
  if (typeof mod.onDiagnosticEvent === "function") {
    return mod;
  }
  if (typeof mod.r === "function") {
    return {
      ...mod,
      onDiagnosticEvent: mod.r,
    };
  }
  return mod;
}

function tryLoadMonolithicSdk() {
  try {
    return loadMonolithicSdk();
  } catch {
    return null;
  }
}

function loadFastExportValue(spec) {
  if (fastExportCache.has(spec.cacheKey)) {
    return fastExportCache.get(spec.cacheKey);
  }

  const lightModule = loadFastModule(spec.moduleId, spec.candidates);
  if (lightModule && typeof lightModule === "object" && Reflect.has(lightModule, spec.exportName)) {
    const value = Reflect.get(lightModule, spec.exportName);
    fastExportCache.set(spec.cacheKey, value);
    return value;
  }

  const monolithic = getMonolithicSdk();
  const fallback = monolithic ? Reflect.get(monolithic, spec.exportName) : undefined;
  fastExportCache.set(spec.cacheKey, fallback);
  return fallback;
}

function createLazyFunctionExport(spec) {
  return function fastExportWrapper(...args) {
    const value = loadFastExportValue(spec);
    if (typeof value !== "function") {
      throw new TypeError(`${spec.exportName} is not a function`);
    }
    return Reflect.apply(value, this, args);
  };
}

function defineLazyValueExport(target, prop, spec) {
  Object.defineProperty(target, prop, {
    configurable: true,
    enumerable: true,
    get() {
      return loadFastExportValue(spec);
    },
  });
}

const fastExports = {
  emptyPluginConfigSchema,
  onDiagnosticEvent,
  resolveControlCommandGate,
  buildChannelConfigSchema: createLazyFunctionExport({
    cacheKey: "buildChannelConfigSchema",
    moduleId: "channel-config-schema",
    exportName: "buildChannelConfigSchema",
    candidates: ["src/channels/plugins/config-schema.ts"],
  }),
  createTypingCallbacks: createLazyFunctionExport({
    cacheKey: "createTypingCallbacks",
    moduleId: "typing",
    exportName: "createTypingCallbacks",
    candidates: ["src/channels/typing.ts"],
  }),
  normalizeAccountId: createLazyFunctionExport({
    cacheKey: "normalizeAccountId",
    moduleId: "account-id",
    exportName: "normalizeAccountId",
    candidates: ["dist/plugin-sdk/account-id.js", "src/plugin-sdk/account-id.ts"],
  }),
  normalizeOptionalAccountId: createLazyFunctionExport({
    cacheKey: "normalizeOptionalAccountId",
    moduleId: "account-id",
    exportName: "normalizeOptionalAccountId",
    candidates: ["dist/plugin-sdk/account-id.js", "src/plugin-sdk/account-id.ts"],
  }),
  resolveDirectDmAuthorizationOutcome: createLazyFunctionExport({
    cacheKey: "resolveDirectDmAuthorizationOutcome",
    moduleId: "command-auth",
    exportName: "resolveDirectDmAuthorizationOutcome",
    candidates: ["src/plugin-sdk/command-auth.ts"],
  }),
  resolvePreferredOpenClawTmpDir: createLazyFunctionExport({
    cacheKey: "resolvePreferredOpenClawTmpDir",
    moduleId: "tmp-openclaw-dir",
    exportName: "resolvePreferredOpenClawTmpDir",
    candidates: ["src/infra/tmp-openclaw-dir.ts"],
  }),
  resolveSenderCommandAuthorization: createLazyFunctionExport({
    cacheKey: "resolveSenderCommandAuthorization",
    moduleId: "command-auth",
    exportName: "resolveSenderCommandAuthorization",
    candidates: ["src/plugin-sdk/command-auth.ts"],
  }),
  resolveSenderCommandAuthorizationWithRuntime: createLazyFunctionExport({
    cacheKey: "resolveSenderCommandAuthorizationWithRuntime",
    moduleId: "command-auth",
    exportName: "resolveSenderCommandAuthorizationWithRuntime",
    candidates: ["src/plugin-sdk/command-auth.ts"],
  }),
  stripMarkdown: createLazyFunctionExport({
    cacheKey: "stripMarkdown",
    moduleId: "markdown-strip",
    exportName: "stripMarkdown",
    candidates: ["src/line/markdown-to-line.ts"],
  }),
  withFileLock: createLazyFunctionExport({
    cacheKey: "withFileLock",
    moduleId: "file-lock",
    exportName: "withFileLock",
    candidates: ["src/plugin-sdk/file-lock.ts"],
  }),
};

const target = { ...fastExports };
defineLazyValueExport(target, "DEFAULT_ACCOUNT_ID", {
  cacheKey: "DEFAULT_ACCOUNT_ID",
  moduleId: "account-id",
  exportName: "DEFAULT_ACCOUNT_ID",
  candidates: ["dist/plugin-sdk/account-id.js", "src/plugin-sdk/account-id.ts"],
});
let rootExports = null;

function shouldResolveMonolithic(prop) {
  if (typeof prop !== "string") {
    return false;
  }
  return prop !== "then";
}

function getMonolithicSdk() {
  const loaded = tryLoadMonolithicSdk();
  if (loaded && typeof loaded === "object") {
    return loaded;
  }
  return null;
}

function getExportValue(prop) {
  if (Reflect.has(target, prop)) {
    return Reflect.get(target, prop);
  }
  if (!shouldResolveMonolithic(prop)) {
    return undefined;
  }
  const monolithic = getMonolithicSdk();
  if (!monolithic) {
    return undefined;
  }
  return Reflect.get(monolithic, prop);
}

function getExportDescriptor(prop) {
  const ownDescriptor = Reflect.getOwnPropertyDescriptor(target, prop);
  if (ownDescriptor) {
    return ownDescriptor;
  }
  if (!shouldResolveMonolithic(prop)) {
    return undefined;
  }

  const monolithic = getMonolithicSdk();
  if (!monolithic) {
    return undefined;
  }

  const descriptor = Reflect.getOwnPropertyDescriptor(monolithic, prop);
  if (!descriptor) {
    return undefined;
  }

  return {
    ...descriptor,
    configurable: true,
  };
}

rootExports = new Proxy(target, {
  get(_target, prop, receiver) {
    if (Reflect.has(target, prop)) {
      return Reflect.get(target, prop, receiver);
    }
    return getExportValue(prop);
  },
  has(_target, prop) {
    if (Reflect.has(target, prop)) {
      return true;
    }
    if (!shouldResolveMonolithic(prop)) {
      return false;
    }
    const monolithic = getMonolithicSdk();
    return monolithic ? Reflect.has(monolithic, prop) : false;
  },
  ownKeys() {
    const keys = new Set(Reflect.ownKeys(target));
    const monolithic = getMonolithicSdk();
    if (monolithic && typeof monolithic === "object") {
      for (const key of Reflect.ownKeys(monolithic)) {
        if (!keys.has(key)) {
          keys.add(key);
        }
      }
    }
    return [...keys];
  },
  getOwnPropertyDescriptor(_target, prop) {
    return getExportDescriptor(prop);
  },
});

Object.defineProperty(target, "__esModule", {
  configurable: true,
  enumerable: false,
  writable: false,
  value: true,
});
Object.defineProperty(target, "default", {
  configurable: true,
  enumerable: false,
  get() {
    return rootExports;
  },
});

module.exports = rootExports;
