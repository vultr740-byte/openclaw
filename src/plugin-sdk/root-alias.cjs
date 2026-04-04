"use strict";

const path = require("node:path");
const fs = require("node:fs");

let monolithicSdk = null;
let jitiLoader = null;
const fastModuleCache = new Map();
const fastExportCache = new Map();

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

function getJiti() {
  if (jitiLoader) {
    return jitiLoader;
  }

  const { createJiti } = require("jiti");
  jitiLoader = createJiti(__filename, {
    interopDefault: true,
    extensions: [".ts", ".tsx", ".mts", ".cts", ".mtsx", ".ctsx", ".js", ".mjs", ".cjs", ".json"],
  });
  return jitiLoader;
}

function getProjectRoot() {
  return path.resolve(__dirname, "..", "..");
}

function loadFastModule(moduleId, candidates) {
  if (fastModuleCache.has(moduleId)) {
    return fastModuleCache.get(moduleId);
  }

  const jiti = getJiti();
  const rootDir = getProjectRoot();
  for (const candidate of candidates) {
    const resolved = path.resolve(rootDir, candidate);
    if (!fs.existsSync(resolved)) {
      continue;
    }
    try {
      const loaded = jiti(resolved);
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

  const jiti = getJiti();

  const distCandidate = path.resolve(__dirname, "..", "..", "dist", "plugin-sdk", "index.js");
  if (fs.existsSync(distCandidate)) {
    try {
      monolithicSdk = jiti(distCandidate);
      return monolithicSdk;
    } catch {
      // Fall through to source alias if dist is unavailable or stale.
    }
  }

  monolithicSdk = jiti(path.join(__dirname, "index.ts"));
  return monolithicSdk;
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

  const monolithic = getMonolithicSdk();
  if (!monolithic) {
    return undefined;
  }

  const descriptor = Reflect.getOwnPropertyDescriptor(monolithic, prop);
  if (!descriptor) {
    return undefined;
  }

  // Proxy invariants require descriptors returned for dynamic properties to be configurable.
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
    const monolithic = getMonolithicSdk();
    return monolithic ? Reflect.has(monolithic, prop) : false;
  },
  ownKeys() {
    const keys = new Set(Reflect.ownKeys(target));
    const monolithic = getMonolithicSdk();
    if (monolithic) {
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
