import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolveStateDir } from "../../config/paths.js";
import {
  generateImage as generateRuntimeImage,
  listRuntimeImageGenerationProviders,
} from "../../image-generation/runtime.js";
import {
  generateMusic as generateRuntimeMusic,
  listRuntimeMusicGenerationProviders,
} from "../../music-generation/runtime.js";
import { RequestScopedSubagentRuntimeError } from "../../plugin-sdk/error-runtime.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import {
  createLazyRuntimeMethod,
  createLazyRuntimeMethodBinder,
  createLazyRuntimeModule,
} from "../../shared/lazy-runtime.js";
import { VERSION } from "../../version.js";
import {
  generateVideo as generateRuntimeVideo,
  listRuntimeVideoGenerationProviders,
} from "../../video-generation/runtime.js";
import { listWebSearchProviders, runWebSearch } from "../../web-search/runtime.js";
import { buildPluginLoaderJitiOptions, resolvePluginLoaderJitiConfig } from "../sdk-alias.js";
import { createRuntimeAgent } from "./runtime-agent.js";
import { defineCachedValue } from "./runtime-cache.js";
import { createRuntimeConfig } from "./runtime-config.js";
import { createRuntimeEvents } from "./runtime-events.js";
import { createRuntimeLogging } from "./runtime-logging.js";
import { createRuntimeMedia } from "./runtime-media.js";
import { resolveRuntimeModuleCandidates } from "./runtime-module-paths.js";
import { createRuntimeSystem } from "./runtime-system.js";
import { createRuntimeTaskFlow } from "./runtime-taskflow.js";
import { createRuntimeTasks } from "./runtime-tasks.js";
import type { CreatePluginRuntimeOptions, PluginRuntime } from "./types.js";

export type { CreatePluginRuntimeOptions } from "./types.js";

let runtimeChannelLoader: ReturnType<typeof import("jiti").createJiti> | null | undefined;
let runtimeChannelFactory:
  | typeof import("./runtime-channel.js").createRuntimeChannel
  | null
  | undefined;

const loadTtsRuntime = createLazyRuntimeModule(() => import("../../tts/tts.js"));
const loadMediaUnderstandingRuntime = createLazyRuntimeModule(
  () => import("../../media-understanding/runtime.js"),
);
const loadModelAuthRuntime = createLazyRuntimeModule(
  () => import("./runtime-model-auth.runtime.js"),
);

function createRuntimeTts(): PluginRuntime["tts"] {
  const bindTtsRuntime = createLazyRuntimeMethodBinder(loadTtsRuntime);
  return {
    textToSpeech: bindTtsRuntime((runtime) => runtime.textToSpeech),
    textToSpeechTelephony: bindTtsRuntime((runtime) => runtime.textToSpeechTelephony),
    listVoices: bindTtsRuntime((runtime) => runtime.listSpeechVoices),
  };
}

function createRuntimeMediaUnderstandingFacade(): PluginRuntime["mediaUnderstanding"] {
  const bindMediaUnderstandingRuntime = createLazyRuntimeMethodBinder(
    loadMediaUnderstandingRuntime,
  );
  return {
    runFile: bindMediaUnderstandingRuntime((runtime) => runtime.runMediaUnderstandingFile),
    describeImageFile: bindMediaUnderstandingRuntime((runtime) => runtime.describeImageFile),
    describeImageFileWithModel: bindMediaUnderstandingRuntime(
      (runtime) => runtime.describeImageFileWithModel,
    ),
    describeVideoFile: bindMediaUnderstandingRuntime((runtime) => runtime.describeVideoFile),
    transcribeAudioFile: bindMediaUnderstandingRuntime((runtime) => runtime.transcribeAudioFile),
  };
}

function createRuntimeImageGeneration(): PluginRuntime["imageGeneration"] {
  return {
    generate: (params) => generateRuntimeImage(params),
    listProviders: (params) => listRuntimeImageGenerationProviders(params),
  };
}

function createRuntimeVideoGeneration(): PluginRuntime["videoGeneration"] {
  return {
    generate: (params) => generateRuntimeVideo(params),
    listProviders: (params) => listRuntimeVideoGenerationProviders(params),
  };
}

function createRuntimeMusicGeneration(): PluginRuntime["musicGeneration"] {
  return {
    generate: (params) => generateRuntimeMusic(params),
    listProviders: (params) => listRuntimeMusicGenerationProviders(params),
  };
}

function createRuntimeModelAuth(): PluginRuntime["modelAuth"] {
  const getApiKeyForModel = createLazyRuntimeMethod(
    loadModelAuthRuntime,
    (runtime) => runtime.getApiKeyForModel,
  );
  const getRuntimeAuthForModel = createLazyRuntimeMethod(
    loadModelAuthRuntime,
    (runtime) => runtime.getRuntimeAuthForModel,
  );
  const resolveApiKeyForProvider = createLazyRuntimeMethod(
    loadModelAuthRuntime,
    (runtime) => runtime.resolveApiKeyForProvider,
  );
  return {
    getApiKeyForModel: (params) =>
      getApiKeyForModel({
        model: params.model,
        cfg: params.cfg,
      }),
    getRuntimeAuthForModel: (params) =>
      getRuntimeAuthForModel({
        model: params.model,
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
      }),
    resolveApiKeyForProvider: (params) =>
      resolveApiKeyForProvider({
        provider: params.provider,
        cfg: params.cfg,
      }),
  };
}

function getRuntimeChannelLoader(): ReturnType<typeof import("jiti").createJiti> {
  if (runtimeChannelLoader) {
    return runtimeChannelLoader;
  }
  const require = createRequire(import.meta.url);
  const { createJiti } = require("jiti") as typeof import("jiti");
  const { tryNative, aliasMap } = resolvePluginLoaderJitiConfig({
    modulePath: fileURLToPath(import.meta.url),
    argv1: process.argv[1],
    moduleUrl: import.meta.url,
  });
  runtimeChannelLoader = createJiti(import.meta.url, {
    ...buildPluginLoaderJitiOptions(aliasMap),
    tryNative,
  });
  return runtimeChannelLoader;
}

function loadRuntimeChannelFactory(): typeof import("./runtime-channel.js").createRuntimeChannel {
  if (runtimeChannelFactory) {
    return runtimeChannelFactory;
  }

  const loader = getRuntimeChannelLoader();
  for (const candidate of resolveRuntimeModuleCandidates(import.meta.url, [
    "runtime-channel.js",
    "runtime-channel.ts",
  ])) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    const mod = loader(candidate) as typeof import("./runtime-channel.js");
    if (typeof mod?.createRuntimeChannel === "function") {
      runtimeChannelFactory = mod.createRuntimeChannel;
      return runtimeChannelFactory;
    }
  }

  throw new Error("Plugin runtime channel factory could not be loaded.");
}

function createUnavailableSubagentRuntime(): PluginRuntime["subagent"] {
  const unavailable = () => {
    throw new RequestScopedSubagentRuntimeError();
  };
  return {
    run: unavailable,
    waitForRun: unavailable,
    getSessionMessages: unavailable,
    getSession: unavailable,
    deleteSession: unavailable,
  };
}

const GATEWAY_SUBAGENT_SYMBOL: unique symbol = Symbol.for(
  "openclaw.plugin.gatewaySubagentRuntime",
) as unknown as typeof GATEWAY_SUBAGENT_SYMBOL;

type GatewaySubagentState = {
  subagent: PluginRuntime["subagent"] | undefined;
};

const gatewaySubagentState = resolveGlobalSingleton<GatewaySubagentState>(
  GATEWAY_SUBAGENT_SYMBOL,
  () => ({
    subagent: undefined,
  }),
);

export function setGatewaySubagentRuntime(subagent: PluginRuntime["subagent"]): void {
  gatewaySubagentState.subagent = subagent;
}

export function clearGatewaySubagentRuntime(): void {
  gatewaySubagentState.subagent = undefined;
}

function createLateBindingSubagent(
  explicit?: PluginRuntime["subagent"],
  allowGatewaySubagentBinding = false,
): PluginRuntime["subagent"] {
  if (explicit) {
    return explicit;
  }

  const unavailable = createUnavailableSubagentRuntime();
  if (!allowGatewaySubagentBinding) {
    return unavailable;
  }

  return new Proxy(unavailable, {
    get(_target, prop, _receiver) {
      const resolved = gatewaySubagentState.subagent ?? unavailable;
      return Reflect.get(resolved, prop, resolved);
    },
  });
}

export function createPluginRuntime(_options: CreatePluginRuntimeOptions = {}): PluginRuntime {
  const mediaUnderstanding = createRuntimeMediaUnderstandingFacade();
  const taskFlow = createRuntimeTaskFlow();
  const tasks = createRuntimeTasks({
    legacyTaskFlow: taskFlow,
  });
  const runtime = {
    version: VERSION,
    config: createRuntimeConfig(),
    agent: createRuntimeAgent(),
    subagent: createLateBindingSubagent(
      _options.subagent,
      _options.allowGatewaySubagentBinding === true,
    ),
    system: createRuntimeSystem(),
    media: createRuntimeMedia(),
    webSearch: {
      listProviders: listWebSearchProviders,
      search: runWebSearch,
    },
    events: createRuntimeEvents(),
    logging: createRuntimeLogging(),
    state: { resolveStateDir },
    tasks,
    taskFlow,
  } satisfies Omit<
    PluginRuntime,
    | "channel"
    | "tts"
    | "mediaUnderstanding"
    | "stt"
    | "modelAuth"
    | "imageGeneration"
    | "videoGeneration"
    | "musicGeneration"
  > &
    Partial<
      Pick<
        PluginRuntime,
        | "channel"
        | "tts"
        | "mediaUnderstanding"
        | "stt"
        | "modelAuth"
        | "imageGeneration"
        | "videoGeneration"
        | "musicGeneration"
      >
    >;

  defineCachedValue(runtime, "channel", () => loadRuntimeChannelFactory()());
  defineCachedValue(runtime, "tts", createRuntimeTts);
  defineCachedValue(runtime, "mediaUnderstanding", () => mediaUnderstanding);
  defineCachedValue(runtime, "stt", () => ({
    transcribeAudioFile: mediaUnderstanding.transcribeAudioFile,
  }));
  defineCachedValue(runtime, "modelAuth", createRuntimeModelAuth);
  defineCachedValue(runtime, "imageGeneration", createRuntimeImageGeneration);
  defineCachedValue(runtime, "videoGeneration", createRuntimeVideoGeneration);
  defineCachedValue(runtime, "musicGeneration", createRuntimeMusicGeneration);

  return runtime as PluginRuntime;
}

export type { PluginRuntime } from "./types.js";
