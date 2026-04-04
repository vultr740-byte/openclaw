import { createRequire } from "node:module";
import { resolveStateDir } from "../../config/paths.js";
import { createRuntimeChannel } from "./runtime-channel.js";
import { createRuntimeConfig } from "./runtime-config.js";
import { createRuntimeEvents } from "./runtime-events.js";
import { createRuntimeLogging } from "./runtime-logging.js";
import { createRuntimeMedia } from "./runtime-media.js";
import { createRuntimeSystem } from "./runtime-system.js";
import { createRuntimeTools } from "./runtime-tools.js";
import type { PluginRuntime } from "./types.js";

let cachedVersion: string | null = null;
let modelAuthModulePromise: Promise<typeof import("../../agents/model-auth.js")> | undefined;
let transcribeAudioModulePromise:
  | Promise<typeof import("../../media-understanding/transcribe-audio.js")>
  | undefined;
let ttsModulePromise: Promise<typeof import("../../tts/tts.js")> | undefined;

function loadModelAuthModule(): Promise<typeof import("../../agents/model-auth.js")> {
  return (modelAuthModulePromise ??= import("../../agents/model-auth.js"));
}

function loadTranscribeAudioModule(): Promise<
  typeof import("../../media-understanding/transcribe-audio.js")
> {
  return (transcribeAudioModulePromise ??= import("../../media-understanding/transcribe-audio.js"));
}

function loadTtsModule(): Promise<typeof import("../../tts/tts.js")> {
  return (ttsModulePromise ??= import("../../tts/tts.js"));
}

function resolveVersion(): string {
  if (cachedVersion) {
    return cachedVersion;
  }
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../../package.json") as { version?: string };
    cachedVersion = pkg.version ?? "unknown";
    return cachedVersion;
  } catch {
    cachedVersion = "unknown";
    return cachedVersion;
  }
}

function createUnavailableSubagentRuntime(): PluginRuntime["subagent"] {
  const unavailable = () => {
    throw new Error("Plugin runtime subagent methods are only available during a gateway request.");
  };
  return {
    run: unavailable,
    waitForRun: unavailable,
    getSessionMessages: unavailable,
    getSession: unavailable,
    deleteSession: unavailable,
  };
}

export type CreatePluginRuntimeOptions = {
  subagent?: PluginRuntime["subagent"];
};

export function createPluginRuntime(_options: CreatePluginRuntimeOptions = {}): PluginRuntime {
  let configRuntime: PluginRuntime["config"] | undefined;
  let systemRuntime: PluginRuntime["system"] | undefined;
  let mediaRuntime: PluginRuntime["media"] | undefined;
  let toolsRuntime: PluginRuntime["tools"] | undefined;
  let channelRuntime: PluginRuntime["channel"] | undefined;
  let eventsRuntime: PluginRuntime["events"] | undefined;
  let loggingRuntime: PluginRuntime["logging"] | undefined;
  let modelAuthRuntime: PluginRuntime["modelAuth"] | undefined;
  let subagentRuntime: PluginRuntime["subagent"] | undefined;

  const runtime = {} as PluginRuntime;
  Object.defineProperties(runtime, {
    version: {
      value: resolveVersion(),
      enumerable: true,
    },
    config: {
      get: () => (configRuntime ??= createRuntimeConfig()),
      enumerable: true,
    },
    subagent: {
      get: () => (subagentRuntime ??= _options.subagent ?? createUnavailableSubagentRuntime()),
      enumerable: true,
    },
    system: {
      get: () => (systemRuntime ??= createRuntimeSystem()),
      enumerable: true,
    },
    media: {
      get: () => (mediaRuntime ??= createRuntimeMedia()),
      enumerable: true,
    },
    tts: {
      value: {
        textToSpeechTelephony: async (...args) => {
          const mod = await loadTtsModule();
          return mod.textToSpeechTelephony(...args);
        },
      } satisfies PluginRuntime["tts"],
      enumerable: true,
    },
    stt: {
      value: {
        transcribeAudioFile: async (...args) => {
          const mod = await loadTranscribeAudioModule();
          return mod.transcribeAudioFile(...args);
        },
      } satisfies PluginRuntime["stt"],
      enumerable: true,
    },
    tools: {
      get: () => (toolsRuntime ??= createRuntimeTools()),
      enumerable: true,
    },
    channel: {
      // Plugin channels rely on several runtime helpers being synchronously callable
      // (for example route/session resolution during inbound processing).
      get: () => (channelRuntime ??= createRuntimeChannel()),
      enumerable: true,
    },
    events: {
      get: () => (eventsRuntime ??= createRuntimeEvents()),
      enumerable: true,
    },
    logging: {
      get: () => (loggingRuntime ??= createRuntimeLogging()),
      enumerable: true,
    },
    state: {
      value: { resolveStateDir } satisfies PluginRuntime["state"],
      enumerable: true,
    },
    modelAuth: {
      get: () =>
        (modelAuthRuntime ??= {
          // Wrap model-auth helpers so plugins cannot steer credential lookups:
          // - agentDir / store: stripped (prevents reading other agents' stores)
          // - profileId / preferredProfile: stripped (prevents cross-provider
          //   credential access via profile steering)
          // Plugins only specify provider/model; the core auth pipeline picks
          // the appropriate credential automatically.
          getApiKeyForModel: async (params) => {
            const mod = await loadModelAuthModule();
            return mod.getApiKeyForModel({
              model: params.model,
              cfg: params.cfg,
            });
          },
          resolveApiKeyForProvider: async (params) => {
            const mod = await loadModelAuthModule();
            return mod.resolveApiKeyForProvider({
              provider: params.provider,
              cfg: params.cfg,
            });
          },
        } satisfies PluginRuntime["modelAuth"]),
      enumerable: true,
    },
  });

  return runtime;
}

export type { PluginRuntime } from "./types.js";
