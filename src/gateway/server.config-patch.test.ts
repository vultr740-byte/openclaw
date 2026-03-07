import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let startedServer: Awaited<ReturnType<typeof startServerWithClient>> | null = null;
let sharedTempRoot: string;

function requireWs(): Awaited<ReturnType<typeof startServerWithClient>>["ws"] {
  if (!startedServer) {
    throw new Error("gateway test server not started");
  }
  return startedServer.ws;
}

beforeAll(async () => {
  sharedTempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-config-"));
  startedServer = await startServerWithClient(undefined, { controlUiEnabled: true });
  await connectOk(requireWs());
});

afterAll(async () => {
  if (!startedServer) {
    return;
  }
  startedServer.ws.close();
  await startedServer.server.close();
  startedServer = null;
  await fs.rm(sharedTempRoot, { recursive: true, force: true });
});

async function resetTempDir(name: string): Promise<string> {
  const dir = path.join(sharedTempRoot, name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function readConfigHash(): Promise<string> {
  const snapshot = await rpcReq<{ hash?: string }>(requireWs(), "config.get", {});
  expect(snapshot.ok).toBe(true);
  const hash = snapshot.payload?.hash;
  expect(typeof hash).toBe("string");
  return hash as string;
}

describe("gateway config methods", () => {
  it("supports config.patch ops removeById without raw", async () => {
    const baseHash = await readConfigHash();
    const seeded = await rpcReq<{ ok?: boolean }>(requireWs(), "config.apply", {
      baseHash,
      raw: JSON.stringify(
        {
          agents: {
            list: [{ id: "home", default: true }, { id: "ops-xhot-grok" }],
          },
        },
        null,
        2,
      ),
    });
    expect(seeded.ok).toBe(true);

    const patchHash = await readConfigHash();
    const res = await rpcReq<{
      config?: { agents?: { list?: Array<{ id: string }> } };
      patch?: { ops?: { total?: number; removed?: number; missing?: number } };
    }>(requireWs(), "config.patch", {
      baseHash: patchHash,
      ops: [{ op: "removeById", path: "agents.list", id: "ops-xhot-grok" }],
    });
    expect(res.ok).toBe(true);
    expect(res.payload?.config?.agents?.list?.map((entry) => entry.id)).toEqual(["home"]);
    expect(res.payload?.patch?.ops).toMatchObject({
      total: 1,
      removed: 1,
      missing: 0,
    });
  });

  it("rejects config.patch ops with invalid path", async () => {
    const patchHash = await readConfigHash();
    const res = await rpcReq<{ ok?: boolean }>(requireWs(), "config.patch", {
      baseHash: patchHash,
      ops: [{ op: "removeById", path: "agents.missing", id: "home" }],
    });
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toContain('path "agents.missing" not found');
  });
});

describe("gateway server sessions", () => {
  it("filters sessions by agentId", async () => {
    const dir = await resetTempDir("agents");
    testState.sessionConfig = {
      store: path.join(dir, "{agentId}", "sessions.json"),
    };
    testState.agentsConfig = {
      list: [{ id: "home", default: true }, { id: "work" }],
    };
    const homeDir = path.join(dir, "home");
    const workDir = path.join(dir, "work");
    await fs.mkdir(homeDir, { recursive: true });
    await fs.mkdir(workDir, { recursive: true });
    await writeSessionStore({
      storePath: path.join(homeDir, "sessions.json"),
      agentId: "home",
      entries: {
        main: {
          sessionId: "sess-home-main",
          updatedAt: Date.now(),
        },
        "discord:group:dev": {
          sessionId: "sess-home-group",
          updatedAt: Date.now() - 1000,
        },
      },
    });
    await writeSessionStore({
      storePath: path.join(workDir, "sessions.json"),
      agentId: "work",
      entries: {
        main: {
          sessionId: "sess-work-main",
          updatedAt: Date.now(),
        },
      },
    });

    const homeSessions = await rpcReq<{
      sessions: Array<{ key: string }>;
    }>(requireWs(), "sessions.list", {
      includeGlobal: false,
      includeUnknown: false,
      agentId: "home",
    });
    expect(homeSessions.ok).toBe(true);
    expect(homeSessions.payload?.sessions.map((s) => s.key).toSorted()).toEqual([
      "agent:home:discord:group:dev",
      "agent:home:main",
    ]);

    const workSessions = await rpcReq<{
      sessions: Array<{ key: string }>;
    }>(requireWs(), "sessions.list", {
      includeGlobal: false,
      includeUnknown: false,
      agentId: "work",
    });
    expect(workSessions.ok).toBe(true);
    expect(workSessions.payload?.sessions.map((s) => s.key)).toEqual(["agent:work:main"]);
  });

  it("resolves and patches main alias to default agent main key", async () => {
    const dir = await resetTempDir("main-alias");
    const storePath = path.join(dir, "sessions.json");
    testState.sessionStorePath = storePath;
    testState.agentsConfig = { list: [{ id: "ops", default: true }] };
    testState.sessionConfig = { mainKey: "work" };

    await writeSessionStore({
      storePath,
      agentId: "ops",
      mainKey: "work",
      entries: {
        main: {
          sessionId: "sess-ops-main",
          updatedAt: Date.now(),
        },
      },
    });

    const resolved = await rpcReq<{ ok: true; key: string }>(requireWs(), "sessions.resolve", {
      key: "main",
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.payload?.key).toBe("agent:ops:work");

    const patched = await rpcReq<{ ok: true; key: string }>(requireWs(), "sessions.patch", {
      key: "main",
      thinkingLevel: "medium",
    });
    expect(patched.ok).toBe(true);
    expect(patched.payload?.key).toBe("agent:ops:work");

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      { thinkingLevel?: string }
    >;
    expect(stored["agent:ops:work"]?.thinkingLevel).toBe("medium");
    expect(stored.main).toBeUndefined();
  });
});
