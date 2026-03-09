import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const createdTempDirs: string[] = [];

afterEach(() => {
  for (const dir of createdTempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runEntrypointBootstrap(params: {
  env?: Record<string, string | undefined>;
  templateAllowedOrigins?: string[];
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
  const nextConfig = JSON.parse(readFileSync(configPath, "utf8")) as {
    gateway?: { controlUi?: { allowedOrigins?: unknown } };
  };
  return nextConfig.gateway?.controlUi?.allowedOrigins;
}

describe("docker-entrypoint controlUi allowedOrigins bootstrap", () => {
  it("normalizes explicit OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS values", () => {
    const allowedOrigins = runEntrypointBootstrap({
      env: {
        OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS:
          "example.com, https://control.example.com/webchat, http://127.0.0.1:18789, invalid:://value, ${RAILWAY_STATIC_URL}",
      },
      templateAllowedOrigins: ["http://localhost:18789"],
    });

    expect(allowedOrigins).toEqual([
      "https://example.com",
      "https://control.example.com",
      "http://127.0.0.1:18789",
    ]);
  });

  it("preserves wildcard allowedOrigins entries", () => {
    const allowedOrigins = runEntrypointBootstrap({
      env: {
        OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS: "*, https://control.example.com/webchat, *",
      },
      templateAllowedOrigins: [],
    });

    expect(allowedOrigins).toEqual(["*", "https://control.example.com"]);
  });

  it("merges derived RAILWAY_STATIC_URL origin with existing valid origins", () => {
    const allowedOrigins = runEntrypointBootstrap({
      env: {
        RAILWAY_STATIC_URL: "my-app.up.railway.app",
      },
      templateAllowedOrigins: [
        "http://127.0.0.1:18789",
        "https://control.example.com/webchat",
        "bad origin",
      ],
    });

    expect(allowedOrigins).toEqual([
      "http://127.0.0.1:18789",
      "https://control.example.com",
      "https://my-app.up.railway.app",
    ]);
  });
});
