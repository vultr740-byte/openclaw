import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canWriteDirectory,
  isContainerizedRuntime,
  normalizeInstallMode,
  resolveInstallBinDir,
  resolveInstallRootDir,
  resolveInstallTarget,
} from "./install-runtime.js";

describe("install-runtime", () => {
  it("normalizes install mode", () => {
    expect(normalizeInstallMode(undefined)).toBe("auto");
    expect(normalizeInstallMode("")).toBe("auto");
    expect(normalizeInstallMode("AUTO")).toBe("auto");
    expect(normalizeInstallMode("global")).toBe("global");
  });

  it("detects containerized runtime from env hints", () => {
    expect(isContainerizedRuntime({ RAILWAY_PROJECT_ID: "abc" } as NodeJS.ProcessEnv)).toBe(true);
    expect(
      isContainerizedRuntime({ KUBERNETES_SERVICE_HOST: "10.0.0.1" } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it("resolves global target for auto mode outside containers", () => {
    const result = resolveInstallTarget({
      mode: "auto",
      workspaceDir: "/tmp/workspace",
      stateDir: "/tmp/state",
      containerized: false,
    });
    expect(result.target).toBe("global");
  });

  it("resolves state target for auto mode in containers when state is writable", () => {
    const result = resolveInstallTarget({
      mode: "auto",
      workspaceDir: "/tmp/workspace",
      stateDir: "/tmp/state",
      containerized: true,
      canWriteStateDir: true,
    });
    expect(result.target).toBe("state");
  });

  it("falls back to workspace target when state is not writable", () => {
    const result = resolveInstallTarget({
      mode: "auto",
      workspaceDir: "/tmp/workspace",
      stateDir: "/tmp/state",
      containerized: true,
      canWriteStateDir: false,
    });
    expect(result.target).toBe("workspace");
  });

  it("resolves install root/bin directories for local targets", () => {
    expect(
      resolveInstallRootDir({
        target: "state",
        stateDir: "/tmp/state",
        workspaceDir: "/tmp/workspace",
      }),
    ).toBe(path.join("/tmp/state", "tools", "runtime"));
    expect(
      resolveInstallBinDir({
        target: "workspace",
        stateDir: "/tmp/state",
        workspaceDir: "/tmp/workspace",
      }),
    ).toBe(path.join("/tmp/workspace", ".openclaw", "tools", "runtime", "bin"));
  });

  it("can create and probe writable directories", () => {
    const writable = canWriteDirectory(path.join(os.tmpdir(), "openclaw-install-runtime-test"));
    expect(typeof writable).toBe("boolean");
  });
});
