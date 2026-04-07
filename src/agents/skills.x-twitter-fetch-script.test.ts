import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

function startTextServer(body: string) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(body);
  });

  return new Promise<{ server: http.Server; baseUrl: string }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("server did not bind to a TCP port"));
        return;
      }
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
      });
    });
  });
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function runPython(args: string[]) {
  return await new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn("python3", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (status) => {
        resolve({ status, stdout, stderr });
      });
    },
  );
}

describe("skills/x-twitter-fetch script", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      if (server) {
        await closeServer(server);
      }
    }
  });

  it("extracts post and conversation sections from a Jina-style status snapshot", async () => {
    const responseBody = `Title: Example on X

URL Source: http://x.com/test/status/123

Markdown Content:
## Post

Main post body.

## Conversation

- Reply one
- Reply two

## Trending now

Noise section
`;
    const { server, baseUrl } = await startTextServer(responseBody);
    servers.push(server);

    const scriptPath = path.join(
      process.cwd(),
      "skills",
      "x-twitter-fetch",
      "scripts",
      "fetch_tweet.py",
    );
    const result = await runPython([
      scriptPath,
      "--url",
      "https://x.com/test/status/123",
      "--extract",
      "conversation",
      "--jina-status-base",
      baseUrl,
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("## Post");
    expect(result.stdout).toContain("Main post body.");
    expect(result.stdout).toContain("## Conversation");
    expect(result.stdout).toContain("- Reply one");
    expect(result.stdout).not.toContain("Trending now");
  });

  it("fails when the snapshot only contains login-wall content", async () => {
    const responseBody = `Title: X

Markdown Content:
Don’t miss what’s happening

People on X are the first to know.
`;
    const { server, baseUrl } = await startTextServer(responseBody);
    servers.push(server);

    const scriptPath = path.join(
      process.cwd(),
      "skills",
      "x-twitter-fetch",
      "scripts",
      "fetch_tweet.py",
    );
    const result = await runPython([
      scriptPath,
      "--url",
      "https://x.com/test/status/123",
      "--extract",
      "conversation",
      "--jina-status-base",
      baseUrl,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Readable conversation snapshot is unavailable");
  });
});
