import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAgentWorkspaceDir } from "./agents/agent-scope.js";
import { createConfigIO } from "./config/config.js";

const createdTempDirs: string[] = [];

afterEach(() => {
  for (const dir of createdTempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runEntrypointBootstrap(params: {
  env?: Record<string, string | undefined>;
  templateAllowedOrigins?: string[];
  templateTelegram?: {
    enabled?: boolean;
    dmPolicy?: string;
    botToken?: string;
    allowFrom?: unknown;
  };
}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openclaw-entrypoint-test-"));
  createdTempDirs.push(dir);

  const configPath = path.join(dir, "config.json");
  const templateConfig = {
    tools: {
      elevated: {
        allowFrom: {
          telegram: "__TELEGRAM_ALLOW_FROM__",
        },
      },
    },
    gateway: {
      controlUi: {
        allowedOrigins: params.templateAllowedOrigins ?? [],
      },
    },
    channels: {
      telegram: {
        enabled: true,
        dmPolicy: "allowlist",
        botToken: "${TELEGRAM_BOT_TOKEN}",
        allowFrom: "__TELEGRAM_ALLOW_FROM__",
        ...params.templateTelegram,
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(templateConfig, null, 2));

  const entrypointSource = readFileSync(
    path.join(process.cwd(), "scripts/docker-entrypoint.sh"),
    "utf8",
  );
  const bootstrapMatch = entrypointSource.match(/<<'NODE'\n([\s\S]*?)\nNODE/);
  expect(
    bootstrapMatch,
    "failed to find bootstrap NODE heredoc in scripts/docker-entrypoint.sh",
  ).toBeTruthy();
  const bootstrapScript = bootstrapMatch ? bootstrapMatch[1] : "";

  const result = spawnSync("node", ["-", configPath], {
    cwd: process.cwd(),
    env: { ...process.env, ...params.env },
    encoding: "utf8",
    input: bootstrapScript,
  });

  expect(result.status, result.stderr || result.stdout).toBe(0);
  return JSON.parse(readFileSync(configPath, "utf8")) as {
    gateway?: { controlUi?: { allowedOrigins?: unknown } };
    channels?: {
      telegram?: {
        enabled?: boolean;
        dmPolicy?: string;
        botToken?: string;
        allowFrom?: unknown;
      };
    };
  };
}

describe("docker-entrypoint controlUi allowedOrigins bootstrap", () => {
  it("normalizes explicit OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS values", () => {
    const nextConfig = runEntrypointBootstrap({
      env: {
        OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS:
          "example.com, https://control.example.com/webchat, http://127.0.0.1:18789, invalid:://value, ${RAILWAY_STATIC_URL}",
      },
      templateAllowedOrigins: ["http://localhost:18789"],
    });

    expect(nextConfig.gateway?.controlUi?.allowedOrigins).toEqual([
      "https://example.com",
      "https://control.example.com",
      "http://127.0.0.1:18789",
    ]);
  });

  it("preserves wildcard allowedOrigins entries", () => {
    const nextConfig = runEntrypointBootstrap({
      env: {
        OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS: "*, https://control.example.com/webchat, *",
      },
      templateAllowedOrigins: [],
    });

    expect(nextConfig.gateway?.controlUi?.allowedOrigins).toEqual([
      "*",
      "https://control.example.com",
    ]);
  });

  it("merges derived RAILWAY_STATIC_URL origin with existing valid origins", () => {
    const nextConfig = runEntrypointBootstrap({
      env: {
        RAILWAY_STATIC_URL: "my-app.up.railway.app",
      },
      templateAllowedOrigins: [
        "http://127.0.0.1:18789",
        "https://control.example.com/webchat",
        "bad origin",
      ],
    });

    expect(nextConfig.gateway?.controlUi?.allowedOrigins).toEqual([
      "http://127.0.0.1:18789",
      "https://control.example.com",
      "https://my-app.up.railway.app",
    ]);
  });
});

describe("docker-entrypoint telegram bootstrap", () => {
  it("disables telegram when no token is configured", () => {
    const nextConfig = runEntrypointBootstrap({});

    expect(nextConfig.channels?.telegram).toEqual({
      enabled: false,
      dmPolicy: "pairing",
      allowFrom: [],
    });
  });

  it("falls back to pairing when token exists but allowFrom is empty", () => {
    const nextConfig = runEntrypointBootstrap({
      env: {
        TELEGRAM_BOT_TOKEN: "telegram-token",
      },
    });

    expect(nextConfig.channels?.telegram?.enabled).toBe(true);
    expect(nextConfig.channels?.telegram?.dmPolicy).toBe("pairing");
    expect(nextConfig.channels?.telegram?.allowFrom).toEqual([]);
    expect(nextConfig.channels?.telegram?.botToken).toBe("${TELEGRAM_BOT_TOKEN}");
  });

  it("keeps allowlist when telegram token and allowFrom are configured", () => {
    const nextConfig = runEntrypointBootstrap({
      env: {
        TELEGRAM_BOT_TOKEN: "telegram-token",
        TELEGRAM_ALLOW_FROM: "123456789",
      },
    });

    expect(nextConfig.channels?.telegram?.enabled).toBe(true);
    expect(nextConfig.channels?.telegram?.dmPolicy).toBe("allowlist");
    expect(nextConfig.channels?.telegram?.allowFrom).toEqual(["123456789"]);
  });
});

function runEntrypointBootstrapFunctions(params: { env?: Record<string, string | undefined> }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openclaw-entrypoint-shell-test-"));
  createdTempDirs.push(dir);

  const binDir = path.join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const invocationPath = path.join(dir, "openclaw-invocations.jsonl");
  const openclawScript = path.join(binDir, "openclaw");
  writeFileSync(
    openclawScript,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      "const payload = {",
      "  argv: process.argv.slice(2),",
      "  env: {",
      "    DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN ?? null,",
      "    QQ_APP_ID: process.env.QQ_APP_ID ?? null,",
      "    QQ_APP_SECRET: process.env.QQ_APP_SECRET ?? null,",
      "    QQBOT_APP_ID: process.env.QQBOT_APP_ID ?? null,",
      "    QQBOT_CLIENT_SECRET: process.env.QQBOT_CLIENT_SECRET ?? null,",
      "  },",
      "};",
      'fs.appendFileSync(process.env.OPENCLAW_TEST_BOOTSTRAP_LOG, JSON.stringify(payload) + "\\n");',
      "",
    ].join("\n"),
  );
  chmodSync(openclawScript, 0o755);

  const entrypointSource = readFileSync(
    path.join(process.cwd(), "scripts/docker-entrypoint.sh"),
    "utf8",
  );
  const preludeMatch = entrypointSource.match(/^([\s\S]*?)\nif \[ "\$\(id -u\)" = "0" \]; then\n/);
  expect(preludeMatch, "failed to find shell prelude in scripts/docker-entrypoint.sh").toBeTruthy();
  const prelude = preludeMatch ? preludeMatch[1] : "";

  const result = spawnSync("bash", ["-s"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      OPENCLAW_TEST_BOOTSTRAP_LOG: invocationPath,
      ...params.env,
    },
    encoding: "utf8",
    input: `${prelude}\nbootstrap_channels\n`,
  });

  const invocations = existsSync(invocationPath)
    ? readFileSync(invocationPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { argv: string[]; env: Record<string, string | null> })
    : [];

  return { result, invocations };
}

function runEntrypointPrelude(params: { env?: Record<string, string | undefined>; input: string }) {
  const entrypointSource = readFileSync(
    path.join(process.cwd(), "scripts/docker-entrypoint.sh"),
    "utf8",
  );
  const preludeMatch = entrypointSource.match(/^([\s\S]*?)\nif \[ "\$\(id -u\)" = "0" \]; then\n/);
  expect(preludeMatch, "failed to find shell prelude in scripts/docker-entrypoint.sh").toBeTruthy();
  const prelude = preludeMatch ? preludeMatch[1] : "";

  return spawnSync("bash", ["-s"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...params.env,
    },
    encoding: "utf8",
    input: `${prelude}\n${params.input}\n`,
  });
}

describe("docker-entrypoint channel bootstrap", () => {
  it("calls the internal bootstrap command with public Discord env vars", () => {
    const { result, invocations } = runEntrypointBootstrapFunctions({
      env: {
        OPENCLAW_BOOTSTRAP_CHANNEL: "discord",
        DISCORD_BOT_TOKEN: "discord-token-value",
      },
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(invocations).toEqual([
      {
        argv: ["channels", "bootstrap", "--channels", "discord"],
        env: {
          DISCORD_BOT_TOKEN: "discord-token-value",
          QQ_APP_ID: null,
          QQ_APP_SECRET: null,
          QQBOT_APP_ID: null,
          QQBOT_CLIENT_SECRET: null,
        },
      },
    ]);
  });

  it("calls the internal bootstrap command with public QQ env vars", () => {
    const { result, invocations } = runEntrypointBootstrapFunctions({
      env: {
        OPENCLAW_BOOTSTRAP_CHANNEL: "qq",
        QQ_APP_ID: "qq-app-id-value",
        QQ_APP_SECRET: "qq-app-secret-value",
      },
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(invocations).toEqual([
      {
        argv: ["channels", "bootstrap", "--channels", "qq"],
        env: {
          DISCORD_BOT_TOKEN: null,
          QQ_APP_ID: "qq-app-id-value",
          QQ_APP_SECRET: "qq-app-secret-value",
          QQBOT_APP_ID: null,
          QQBOT_CLIENT_SECRET: null,
        },
      },
    ]);
  });

  it("calls the internal bootstrap command for weixin bootstrap", () => {
    const { result, invocations } = runEntrypointBootstrapFunctions({
      env: {
        OPENCLAW_BOOTSTRAP_CHANNEL: "weixin",
      },
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(invocations).toEqual([
      {
        argv: ["channels", "bootstrap", "--channels", "weixin"],
        env: {
          DISCORD_BOT_TOKEN: null,
          QQ_APP_ID: null,
          QQ_APP_SECRET: null,
          QQBOT_APP_ID: null,
          QQBOT_CLIENT_SECRET: null,
        },
      },
    ]);
  });
});

describe("docker-entrypoint home sync", () => {
  it("preserves non-root HOME for local compose-style runtimes", () => {
    const result = runEntrypointPrelude({
      env: {
        HOME: "/home/node",
      },
      input: 'printf "%s\\n" "$HOME|$OPENCLAW_HOME|$OPENCLAW_WORKSPACE_DIR"',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout.trim()).toBe("/home/node|/home/node|/home/node/.openclaw/workspace");
  });

  it("aligns HOME with explicit OPENCLAW_HOME for third-party tools", () => {
    const result = runEntrypointPrelude({
      env: {
        HOME: "/root",
        OPENCLAW_HOME: "/data",
      },
      input: 'printf "%s\\n" "$HOME|$OPENCLAW_HOME|$OPENCLAW_WORKSPACE_DIR"',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout.trim()).toBe("/data|/data|/data/.openclaw/workspace");
  });

  it("derives OPENCLAW_HOME from canonical OPENCLAW_STATE_DIR when missing", () => {
    const result = runEntrypointPrelude({
      env: {
        HOME: "/root",
        OPENCLAW_STATE_DIR: "/data/.openclaw",
      },
      input: 'printf "%s\\n" "${OPENCLAW_HOME:-}|$HOME|$OPENCLAW_WORKSPACE_DIR"',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout.trim()).toBe("/data|/data|/data/.openclaw/workspace");
  });

  it("falls back to /data when the container default home would otherwise be /root", () => {
    const result = runEntrypointPrelude({
      env: {
        HOME: "/root",
      },
      input: 'printf "%s\\n" "$HOME|$OPENCLAW_HOME|$OPENCLAW_WORKSPACE_DIR"',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout.trim()).toBe("/data|/data|/data/.openclaw/workspace");
  });

  it("bootstraps env-only railway config from OPENCLAW_HOME alone", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openclaw-entrypoint-home-test-"));
    createdTempDirs.push(dir);

    const runtimeHome = path.join(dir, "data");
    const workspaceDir = path.join(runtimeHome, ".openclaw", "workspace");
    const configPath = path.join(runtimeHome, ".openclaw", "openclaw.json");
    const templatePath = path.join(process.cwd(), "config/openclaw.railway.template.json");
    const gatewayToken = "gateway-token";
    const openAiApiKey = "openai-api-key";
    const openAiBaseUrl = "https://example.com/v1";
    const openAiMode = "openai-responses";
    const openAiModel = "gpt-5.2";
    const telegramBotToken = "telegram-token";
    const telegramAllowFrom = "123456789";

    const result = runEntrypointPrelude({
      env: {
        HOME: "/root",
        OPENCLAW_HOME: runtimeHome,
        OPENCLAW_CONFIG_TEMPLATE: templatePath,
        OPENCLAW_GATEWAY_TOKEN: gatewayToken,
        OPENAI_API_KEY: openAiApiKey,
        OPENAI_BASE_URL: openAiBaseUrl,
        OPENAI_API_MODE: openAiMode,
        OPENAI_MODEL: openAiModel,
        TELEGRAM_BOT_TOKEN: telegramBotToken,
        TELEGRAM_ALLOW_FROM: telegramAllowFrom,
      },
      input: 'ensure_workspace\nbootstrap_config\nprintf "%s\\n" "$OPENCLAW_WORKSPACE_DIR"',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout.trim()).toBe(workspaceDir);
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(path.join(workspaceDir, "MEMORY.md"))).toBe(true);

    const rawConfig = JSON.parse(readFileSync(configPath, "utf8")) as {
      agents?: { defaults?: { workspace?: string } };
    };
    expect(rawConfig.agents?.defaults?.workspace).toBe("${OPENCLAW_WORKSPACE_DIR}");

    const configEnv = {
      ...process.env,
      HOME: runtimeHome,
      OPENCLAW_HOME: runtimeHome,
      OPENCLAW_WORKSPACE_DIR: workspaceDir,
      OPENCLAW_GATEWAY_TOKEN: gatewayToken,
      OPENAI_API_KEY: openAiApiKey,
      OPENAI_BASE_URL: openAiBaseUrl,
      OPENAI_API_MODE: openAiMode,
      OPENAI_MODEL: openAiModel,
      TELEGRAM_BOT_TOKEN: telegramBotToken,
      TELEGRAM_ALLOW_FROM: telegramAllowFrom,
    };
    const cfg = createConfigIO({
      configPath,
      env: configEnv,
      homedir: () => runtimeHome,
    }).loadConfig();

    expect(cfg.agents?.defaults?.workspace).toBe(workspaceDir);
    expect(resolveAgentWorkspaceDir(cfg, "main")).toBe(workspaceDir);
  });
});
