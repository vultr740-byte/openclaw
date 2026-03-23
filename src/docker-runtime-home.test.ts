import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const dockerfilePath = join(repoRoot, "Dockerfile");
const composePath = join(repoRoot, "docker-compose.yml");

describe("Dockerfile runtime home defaults", () => {
  it("keeps the image neutral so each deployment can choose its runtime home", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");

    expect(dockerfile).not.toContain("ENV OPENCLAW_HOME=/data");
    expect(dockerfile).not.toContain("ENV HOME=/data");
  });

  it("pins local compose services to /home/node paths", async () => {
    const compose = await readFile(composePath, "utf8");

    expect(compose.match(/^\s+HOME: \/home\/node$/gm)).toHaveLength(2);
    expect(compose.match(/^\s+OPENCLAW_HOME: \/home\/node$/gm)).toHaveLength(2);
    expect(compose.match(/^\s+OPENCLAW_STATE_DIR: \/home\/node\/\.openclaw$/gm)).toHaveLength(2);
    expect(
      compose.match(/^\s+OPENCLAW_WORKSPACE_DIR: \/home\/node\/\.openclaw\/workspace$/gm),
    ).toHaveLength(2);
  });
});
