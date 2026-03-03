import { describe, expect, it } from "vitest";
import {
  hasGlobalInstallIntent,
  resolveGlobalInstallEnvRedirect,
  rewriteGlobalInstallCommand,
} from "./install-command-rewrite.js";

describe("rewriteGlobalInstallCommand", () => {
  const installRoot = "/data/.openclaw/tools/runtime";
  const installBinDir = "/data/.openclaw/tools/runtime/bin";

  it("rewrites npm global install to local prefix", () => {
    const result = rewriteGlobalInstallCommand({
      command: "npm install -g cowsay",
      target: "state",
      installRoot,
      installBinDir,
    });
    expect(result.rewritten).toBe(true);
    expect(result.command).toContain("--prefix");
    expect(result.command).toContain(installRoot);
  });

  it("rewrites pnpm global install to local global dirs", () => {
    const result = rewriteGlobalInstallCommand({
      command: "pnpm add -g @openclaw/skill-cli",
      target: "state",
      installRoot,
      installBinDir,
    });
    expect(result.rewritten).toBe(true);
    expect(result.command).toContain("--global-dir");
    expect(result.command).toContain("--global-bin-dir");
  });

  it("rewrites yarn global add to local prefix", () => {
    const result = rewriteGlobalInstallCommand({
      command: "yarn global add typescript",
      target: "workspace",
      installRoot: "/workspace/.openclaw/tools/runtime",
      installBinDir: "/workspace/.openclaw/tools/runtime/bin",
    });
    expect(result.rewritten).toBe(true);
    expect(result.command).toContain("--prefix");
    expect(result.command).toContain("/workspace/.openclaw/tools/runtime");
  });

  it("rewrites bun global add via BUN_INSTALL env override", () => {
    const result = rewriteGlobalInstallCommand({
      command: "bun add -g eslint",
      target: "state",
      installRoot,
      installBinDir,
    });
    expect(result.rewritten).toBe(true);
    expect(result.env?.BUN_INSTALL).toBe(installRoot);
  });

  it("does not rewrite non-global install commands", () => {
    const result = rewriteGlobalInstallCommand({
      command: "npm install cowsay",
      target: "state",
      installRoot,
      installBinDir,
    });
    expect(result.rewritten).toBe(false);
    expect(result.command).toBe("npm install cowsay");
  });

  it("does not rewrite complex shell commands", () => {
    const result = rewriteGlobalInstallCommand({
      command: "npm install -g cowsay && cowsay hi",
      target: "state",
      installRoot,
      installBinDir,
    });
    expect(result.rewritten).toBe(false);
  });

  it("detects global install intent in chained commands", () => {
    expect(
      hasGlobalInstallIntent("npm i -g agent-browser && agent-browser open https://example.com"),
    ).toBe(true);
    expect(hasGlobalInstallIntent("if false; then npm i -g agent-browser; fi")).toBe(true);
    expect(hasGlobalInstallIntent("npm i agent-browser")).toBe(false);
  });

  it("resolves env-based redirect fallback for complex global install commands", () => {
    const env = resolveGlobalInstallEnvRedirect({
      command: "npm install -g agent-browser && agent-browser install --with-deps",
      target: "state",
      installRoot,
      installBinDir,
    });
    expect(env).toEqual({
      NPM_CONFIG_PREFIX: installRoot,
      npm_config_prefix: installRoot,
      PNPM_HOME: installBinDir,
      BUN_INSTALL: installRoot,
      YARN_GLOBAL_FOLDER: `${installRoot}/yarn-global`,
    });
  });

  it("skips env redirect fallback in global mode", () => {
    const env = resolveGlobalInstallEnvRedirect({
      command: "npm install -g agent-browser",
      target: "global",
      installRoot,
      installBinDir,
    });
    expect(env).toBeUndefined();
  });
});
