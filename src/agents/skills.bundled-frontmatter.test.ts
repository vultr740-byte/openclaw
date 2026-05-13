import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "./skills/frontmatter.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("bundled skill frontmatter", () => {
  it("keeps shipped bundled skills parseable from their files", async () => {
    const skillPaths = [
      "skills/privy-agent-onboarding/SKILL.md",
      "skills/guizang-ppt-skill/SKILL.md",
      "skills/taskflow/SKILL.md",
      "skills/taskflow-inbox-triage/SKILL.md",
    ] as const;

    for (const relativePath of skillPaths) {
      const raw = await fs.readFile(path.join(repoRoot, relativePath), "utf8");
      const frontmatter = parseFrontmatter(raw);

      expect(frontmatter.name, relativePath).toBeTruthy();
      expect(frontmatter.description, relativePath).toBeTruthy();
    }
  });
});
