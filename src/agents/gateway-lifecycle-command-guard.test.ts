import { describe, expect, it } from "vitest";
import { detectGatewayLifecycleCommand } from "./gateway-lifecycle-command-guard.js";

describe("detectGatewayLifecycleCommand", () => {
  it("matches explicit lifecycle subcommands", () => {
    expect(detectGatewayLifecycleCommand("openclaw gateway restart")).toEqual({
      action: "restart",
    });
    expect(detectGatewayLifecycleCommand("openclaw gateway start")).toEqual({
      action: "start",
    });
    expect(detectGatewayLifecycleCommand("openclaw gateway stop")).toEqual({
      action: "stop",
    });
    expect(detectGatewayLifecycleCommand("openclaw gateway run --force")).toEqual({
      action: "run",
    });
  });

  it("matches implicit gateway run forms", () => {
    expect(detectGatewayLifecycleCommand("openclaw gateway --force")).toEqual({
      action: "run",
    });
    expect(detectGatewayLifecycleCommand("openclaw gateway --bind lan --port 8080")).toEqual({
      action: "run",
    });
  });

  it("matches lifecycle subcommands even when openclaw global options are present", () => {
    expect(detectGatewayLifecycleCommand("openclaw --profile prod gateway restart")).toEqual({
      action: "restart",
    });
    expect(detectGatewayLifecycleCommand("openclaw --profile prod gateway status")).toBeNull();
  });

  it("supports common wrappers", () => {
    expect(detectGatewayLifecycleCommand("sudo openclaw gateway restart")).toEqual({
      action: "restart",
    });
    expect(detectGatewayLifecycleCommand("env FOO=1 openclaw gateway run --force")).toEqual({
      action: "run",
    });
  });

  it("matches chained and piped commands", () => {
    expect(detectGatewayLifecycleCommand("pwd && openclaw gateway restart")).toEqual({
      action: "restart",
    });
    expect(detectGatewayLifecycleCommand("echo ok ; openclaw gateway run --force")).toEqual({
      action: "run",
    });
    expect(detectGatewayLifecycleCommand("echo hi | openclaw gateway stop")).toEqual({
      action: "stop",
    });
  });

  it("matches lifecycle commands wrapped in inline shell invocations", () => {
    expect(detectGatewayLifecycleCommand('bash -lc "openclaw gateway restart"')).toEqual({
      action: "restart",
    });
    expect(
      detectGatewayLifecycleCommand('env FOO=1 bash -lc "echo ok && openclaw gateway start"'),
    ).toEqual({
      action: "start",
    });
  });

  it("allows help and non-lifecycle gateway subcommands", () => {
    expect(detectGatewayLifecycleCommand("openclaw gateway --help")).toBeNull();
    expect(detectGatewayLifecycleCommand("pwd && openclaw gateway --help")).toBeNull();
    expect(detectGatewayLifecycleCommand("openclaw gateway status")).toBeNull();
    expect(detectGatewayLifecycleCommand("openclaw gateway probe")).toBeNull();
  });

  it("ignores unrelated commands", () => {
    expect(detectGatewayLifecycleCommand("echo openclaw gateway restart")).toBeNull();
    expect(detectGatewayLifecycleCommand('bash -lc "echo openclaw gateway restart"')).toBeNull();
    expect(detectGatewayLifecycleCommand("openclaw status")).toBeNull();
    expect(detectGatewayLifecycleCommand("npm -g i openclaw")).toBeNull();
  });
});
