import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const configMocks = vi.hoisted(() => ({
  readConfigFileSnapshotForWrite: vi.fn(),
  writeConfigFile: vi.fn().mockResolvedValue(undefined),
}));

const installMocks = vi.hoisted(() => ({
  installPluginFromNpmSpec: vi.fn(),
}));

const pluginLoaderState = vi.hoisted(() => ({
  installed: false,
  loadOpenClawPlugins: vi.fn(),
  clearPluginDiscoveryCache: vi.fn(),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    readConfigFileSnapshotForWrite: configMocks.readConfigFileSnapshotForWrite,
    writeConfigFile: configMocks.writeConfigFile,
  };
});

vi.mock("../plugins/install.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/install.js")>();
  return {
    ...actual,
    installPluginFromNpmSpec: installMocks.installPluginFromNpmSpec,
  };
});

vi.mock("../plugins/discovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/discovery.js")>();
  return {
    ...actual,
    clearPluginDiscoveryCache: pluginLoaderState.clearPluginDiscoveryCache,
  };
});

vi.mock("../plugins/loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/loader.js")>();
  const { setActivePluginRegistry } = await import("../plugins/runtime.js");

  const telegramPlugin = {
    id: "telegram",
    meta: {
      id: "telegram",
      label: "Telegram",
      selectionLabel: "Telegram",
      docsPath: "/channels/telegram",
      blurb: "test stub.",
    },
    capabilities: { chatTypes: ["direct"] as const },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({}),
    },
  };

  const qqbotPlugin = {
    id: "qqbot",
    meta: {
      id: "qqbot",
      label: "QQ Bot",
      selectionLabel: "QQ Bot",
      docsPath: "/channels/qqbot",
      blurb: "test stub.",
    },
    capabilities: { chatTypes: ["direct"] as const },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({}),
    },
  };

  pluginLoaderState.loadOpenClawPlugins.mockImplementation((options?: { config?: unknown }) => {
    const config = options?.config as
      | {
          plugins?: {
            entries?: Record<string, { enabled?: boolean }>;
          };
        }
      | undefined;
    const qqbotEnabled = config?.plugins?.entries?.["openclaw-qqbot"]?.enabled === true;
    const registry = {
      plugins: [],
      tools: [],
      hooks: [],
      typedHooks: [],
      channels: [
        { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
        ...(pluginLoaderState.installed && qqbotEnabled
          ? [{ pluginId: "openclaw-qqbot", plugin: qqbotPlugin, source: "test" }]
          : []),
      ],
      providers: [],
      gatewayHandlers: {},
      httpRoutes: [],
      cliRegistrars: [],
      services: [],
      commands: [],
      diagnostics: [],
    };
    setActivePluginRegistry(registry as never);
    return registry as never;
  });

  return {
    ...actual,
    loadOpenClawPlugins: pluginLoaderState.loadOpenClawPlugins,
  };
});

const runtime = createTestRuntime();
const originalDiscordBotToken = process.env.DISCORD_BOT_TOKEN;
const originalQqAppId = process.env.QQ_APP_ID;
const originalQqAppSecret = process.env.QQ_APP_SECRET;

let channelsBootstrapCommand: typeof import("./channels.js").channelsBootstrapCommand;

function makeWriteSnapshot(config: Record<string, unknown> = {}) {
  return {
    snapshot: {
      path: "/tmp/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {},
      valid: true,
      config,
      hash: "hash",
      issues: [],
      warnings: [],
      legacyIssues: [],
    },
    writeOptions: {
      expectedConfigPath: "/tmp/openclaw.json",
    },
  };
}

describe("channelsBootstrapCommand", () => {
  beforeAll(async () => {
    ({ channelsBootstrapCommand } = await import("./channels.js"));
  });

  beforeEach(() => {
    if (originalDiscordBotToken === undefined) {
      delete process.env.DISCORD_BOT_TOKEN;
    } else {
      process.env.DISCORD_BOT_TOKEN = originalDiscordBotToken;
    }
    if (originalQqAppId === undefined) {
      delete process.env.QQ_APP_ID;
    } else {
      process.env.QQ_APP_ID = originalQqAppId;
    }
    if (originalQqAppSecret === undefined) {
      delete process.env.QQ_APP_SECRET;
    } else {
      process.env.QQ_APP_SECRET = originalQqAppSecret;
    }

    configMocks.readConfigFileSnapshotForWrite.mockReset();
    configMocks.writeConfigFile.mockReset();
    configMocks.writeConfigFile.mockResolvedValue(undefined);
    installMocks.installPluginFromNpmSpec.mockReset();
    pluginLoaderState.clearPluginDiscoveryCache.mockReset();
    pluginLoaderState.loadOpenClawPlugins.mockClear();
    pluginLoaderState.installed = false;
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
    setActivePluginRegistry(createTestRegistry());
  });

  it("fails fast when required QQ env vars are missing", async () => {
    delete process.env.QQ_APP_ID;
    delete process.env.QQ_APP_SECRET;

    await channelsBootstrapCommand({ channels: "qq" }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      "Bootstrap channel qq requires env: QQ_APP_ID, QQ_APP_SECRET",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(configMocks.readConfigFileSnapshotForWrite).not.toHaveBeenCalled();
    expect(installMocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("fails fast when required Discord env vars are missing", async () => {
    delete process.env.DISCORD_BOT_TOKEN;

    await channelsBootstrapCommand({ channels: "discord" }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      "Bootstrap channel discord requires env: DISCORD_BOT_TOKEN",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(configMocks.readConfigFileSnapshotForWrite).not.toHaveBeenCalled();
    expect(installMocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("treats telegram bootstrap as a compatibility no-op", async () => {
    configMocks.readConfigFileSnapshotForWrite.mockResolvedValue(
      makeWriteSnapshot({
        channels: {
          telegram: {
            enabled: false,
            dmPolicy: "pairing",
            allowFrom: [],
          },
        },
        plugins: {
          entries: {
            telegram: {
              enabled: false,
            },
          },
        },
      }),
    );

    await channelsBootstrapCommand({ channels: "telegram" }, runtime);

    expect(installMocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(pluginLoaderState.loadOpenClawPlugins).not.toHaveBeenCalled();
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith("Bootstrapped channel telegram (telegram).");
    expect(runtime.log).toHaveBeenCalledWith("Bootstrap config already up to date.");
  });

  it("writes env-backed Discord config refs without plugin install", async () => {
    process.env.DISCORD_BOT_TOKEN = "discord-token-value";
    configMocks.readConfigFileSnapshotForWrite.mockResolvedValue(makeWriteSnapshot());

    await channelsBootstrapCommand({ channels: "discord" }, runtime);

    expect(installMocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(pluginLoaderState.loadOpenClawPlugins).not.toHaveBeenCalled();
    expect(configMocks.writeConfigFile).toHaveBeenCalledTimes(1);

    const writtenConfig = configMocks.writeConfigFile.mock.calls[0]?.[0] as {
      channels?: {
        discord?: {
          enabled?: boolean;
          dmPolicy?: string;
          allowFrom?: string[];
          groupPolicy?: string;
          token?: string;
        };
      };
    };

    expect(writtenConfig.channels?.discord).toEqual({
      dmPolicy: "open",
      allowFrom: ["*"],
      enabled: true,
      groupPolicy: "disabled",
      token: "${DISCORD_BOT_TOKEN}",
    });
    expect(JSON.stringify(writtenConfig)).not.toContain("discord-token-value");
  });

  it("preserves explicit Discord access config while bootstrapping env refs", async () => {
    process.env.DISCORD_BOT_TOKEN = "discord-token-value";
    configMocks.readConfigFileSnapshotForWrite.mockResolvedValue(
      makeWriteSnapshot({
        channels: {
          discord: {
            dm: {
              policy: "pairing",
              allowFrom: ["123456789012345678"],
            },
            groupPolicy: "allowlist",
            guilds: {
              "987654321098765432": {
                channels: {
                  general: {
                    allow: true,
                  },
                },
              },
            },
          },
        },
      }),
    );

    await channelsBootstrapCommand({ channels: "discord" }, runtime);

    expect(installMocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(pluginLoaderState.loadOpenClawPlugins).not.toHaveBeenCalled();
    expect(configMocks.writeConfigFile).toHaveBeenCalledTimes(1);

    const writtenConfig = configMocks.writeConfigFile.mock.calls[0]?.[0] as {
      channels?: {
        discord?: {
          enabled?: boolean;
          token?: string;
          dm?: {
            policy?: string;
            allowFrom?: string[];
          };
          groupPolicy?: string;
          guilds?: Record<
            string,
            {
              channels?: Record<string, { allow?: boolean }>;
            }
          >;
        };
      };
    };

    expect(writtenConfig.channels?.discord).toEqual({
      enabled: true,
      token: "${DISCORD_BOT_TOKEN}",
      dm: {
        policy: "pairing",
        allowFrom: ["123456789012345678"],
      },
      groupPolicy: "allowlist",
      guilds: {
        "987654321098765432": {
          channels: {
            general: {
              allow: true,
            },
          },
        },
      },
    });
    expect(JSON.stringify(writtenConfig)).not.toContain("discord-token-value");
  });

  it("installs qqbot and writes env-backed config refs", async () => {
    process.env.QQ_APP_ID = "qq-app-id-value";
    process.env.QQ_APP_SECRET = "qq-app-secret-value";
    configMocks.readConfigFileSnapshotForWrite.mockResolvedValue(makeWriteSnapshot());
    installMocks.installPluginFromNpmSpec.mockImplementation(async () => {
      pluginLoaderState.installed = true;
      return {
        ok: true,
        pluginId: "openclaw-qqbot",
        targetDir: "/tmp/extensions/openclaw-qqbot",
        version: "1.5.7",
        extensions: ["dist/index.js"],
      };
    });

    await channelsBootstrapCommand({ channels: "qq" }, runtime);

    expect(installMocks.installPluginFromNpmSpec).toHaveBeenCalledWith({
      spec: "@tencent-connect/openclaw-qqbot@1.5.7",
      expectedPluginId: "openclaw-qqbot",
      logger: expect.any(Object),
    });
    expect(configMocks.writeConfigFile).toHaveBeenCalledTimes(1);

    const writtenConfig = configMocks.writeConfigFile.mock.calls[0]?.[0] as {
      channels?: {
        qqbot?: {
          enabled?: boolean;
          allowFrom?: string[];
          appId?: string;
          clientSecret?: string;
        };
      };
      plugins?: {
        entries?: Record<string, { enabled?: boolean }>;
        installs?: Record<
          string,
          {
            source?: string;
            spec?: string;
            installPath?: string;
            version?: string;
          }
        >;
      };
    };

    expect(writtenConfig.channels?.qqbot).toEqual({
      enabled: true,
      allowFrom: ["*"],
      appId: "${QQ_APP_ID}",
      clientSecret: "${QQ_APP_SECRET}",
    });
    expect(writtenConfig.plugins?.entries?.["openclaw-qqbot"]?.enabled).toBe(true);
    expect(writtenConfig.plugins?.installs?.["openclaw-qqbot"]).toMatchObject({
      source: "npm",
      spec: "@tencent-connect/openclaw-qqbot@1.5.7",
      installPath: "/tmp/extensions/openclaw-qqbot",
      version: "1.5.7",
    });
    expect(JSON.stringify(writtenConfig)).not.toContain("qq-app-id-value");
    expect(JSON.stringify(writtenConfig)).not.toContain("qq-app-secret-value");
  });

  it("skips reinstall and rewrite when qq bootstrap is already applied", async () => {
    process.env.QQ_APP_ID = "qq-app-id-value";
    process.env.QQ_APP_SECRET = "qq-app-secret-value";
    pluginLoaderState.installed = true;
    configMocks.readConfigFileSnapshotForWrite.mockResolvedValue(
      makeWriteSnapshot({
        channels: {
          qqbot: {
            enabled: true,
            allowFrom: ["*"],
            appId: "${QQ_APP_ID}",
            clientSecret: "${QQ_APP_SECRET}",
          },
        },
        plugins: {
          allow: ["openclaw-qqbot"],
          entries: {
            "openclaw-qqbot": {
              enabled: true,
            },
          },
          installs: {
            "openclaw-qqbot": {
              source: "npm",
              spec: "@tencent-connect/openclaw-qqbot@1.5.7",
              installPath: "/tmp/extensions/openclaw-qqbot",
              version: "1.5.7",
            },
          },
        },
      }),
    );

    await channelsBootstrapCommand({ channels: "qq" }, runtime);

    expect(installMocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith("Bootstrap config already up to date.");
  });
});
