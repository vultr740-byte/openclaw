import { describe, expect, it } from "vitest";
import "./test-helpers/fast-core-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("createOpenClawTools skills_search registration", () => {
  it("registers skills_search by default", () => {
    const tool = createOpenClawTools().find((candidate) => candidate.name === "skills_search");
    expect(tool).toBeDefined();
    expect(tool?.description).toContain("Search available local skills");
  });

  it("registers skillhub by default", () => {
    const tool = createOpenClawTools().find((candidate) => candidate.name === "skillhub");
    expect(tool).toBeDefined();
    expect(tool?.description).toContain("Search and install remote skills");
  });
});
