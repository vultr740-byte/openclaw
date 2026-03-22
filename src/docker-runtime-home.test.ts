import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const dockerfilePath = join(repoRoot, "Dockerfile");

describe("Dockerfile runtime home defaults", () => {
  it("pins HOME and OPENCLAW_HOME to /data for third-party installer compatibility", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");

    expect(dockerfile).toContain("ENV OPENCLAW_HOME=/data");
    expect(dockerfile).toContain("ENV HOME=/data");
  });
});
