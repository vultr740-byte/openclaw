import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import {
  buildWorkspaceSkillCommandSpecs,
  filterWorkspaceSkillEntries,
  loadWorkspaceSkillEntries,
} from "../skills.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const SkillsSearchSchema = Type.Object({
  query: Type.String({
    description: "Capability, domain, or URL to match against available skills.",
  }),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum number of matches to return.",
      minimum: 1,
    }),
  ),
});

const DEFAULT_MATCH_LIMIT = 8;
const MAX_MATCH_LIMIT = 20;

type ScoredSkillMatch = {
  name: string;
  description: string;
  path: string;
  score: number;
  command?: string;
};

function clampMatchLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MATCH_LIMIT;
  }
  return Math.max(1, Math.min(MAX_MATCH_LIMIT, Math.floor(value)));
}

function splitSearchTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function extractDomainHints(query: string): string[] {
  const hints = new Set<string>();
  const lower = query.toLowerCase();
  for (const token of lower.split(/\s+/g)) {
    const trimmed = token.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = new URL(trimmed);
      if (parsed.hostname) {
        const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
        hints.add(hostname);
        const firstLabel = hostname.split(".")[0]?.trim();
        if (firstLabel) {
          hints.add(firstLabel);
        }
      }
    } catch {
      if (trimmed.includes(".") && /^[a-z0-9.-]+$/.test(trimmed)) {
        hints.add(trimmed.replace(/^www\./, ""));
      }
    }
  }
  return [...hints];
}

function scoreMatch(params: {
  query: string;
  tokens: string[];
  domains: string[];
  name: string;
  description: string;
  homepage?: string;
}): number {
  const query = params.query.toLowerCase();
  const name = params.name.toLowerCase();
  const description = params.description.toLowerCase();
  const homepage = params.homepage?.toLowerCase() ?? "";
  let score = 0;

  if (name === query) {
    score += 120;
  }
  if (name.includes(query)) {
    score += 70;
  }
  if (description.includes(query)) {
    score += 35;
  }
  if (homepage.includes(query)) {
    score += 25;
  }

  for (const token of params.tokens) {
    if (name.includes(token)) {
      score += 12;
    }
    if (description.includes(token)) {
      score += 5;
    }
    if (homepage.includes(token)) {
      score += 4;
    }
  }

  for (const domain of params.domains) {
    if (name.includes(domain)) {
      score += 20;
    }
    if (description.includes(domain)) {
      score += 12;
    }
    if (homepage.includes(domain)) {
      score += 16;
    }
  }

  return score;
}

export function createSkillsSearchTool(options: {
  workspaceDir: string;
  config?: OpenClawConfig;
}): AnyAgentTool {
  return {
    label: "Skills Search",
    name: "skills_search",
    description:
      "Search available local skills by capability/domain/URL and return best matches (with command names). Use after recoverable tool failures before asking the user for manual paste.",
    parameters: SkillsSearchSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      const requestedLimit = readNumberParam(params, "limit", { integer: true });
      const limit = clampMatchLimit(requestedLimit);
      const entries = filterWorkspaceSkillEntries(
        loadWorkspaceSkillEntries(options.workspaceDir, { config: options.config }),
        options.config,
      ).filter((entry) => entry.invocation?.disableModelInvocation !== true);
      const commandSpecs = buildWorkspaceSkillCommandSpecs(options.workspaceDir, {
        config: options.config,
        entries,
      });
      const commandBySkillName = new Map(
        commandSpecs.map((spec) => [spec.skillName.toLowerCase(), spec.name]),
      );
      const tokens = splitSearchTokens(query);
      const domains = extractDomainHints(query);
      const matches: ScoredSkillMatch[] = [];

      for (const entry of entries) {
        const name = entry.skill.name.trim();
        if (!name) {
          continue;
        }
        const description = entry.skill.description?.trim() || name;
        const score = scoreMatch({
          query,
          tokens,
          domains,
          name,
          description,
          homepage: entry.metadata?.homepage,
        });
        if (score <= 0) {
          continue;
        }
        const command = commandBySkillName.get(name.toLowerCase());
        matches.push({
          name,
          description,
          path: entry.skill.filePath,
          score,
          ...(command ? { command: `/${command}` } : {}),
        });
      }

      matches.sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return left.name.localeCompare(right.name);
      });

      return jsonResult({
        query,
        limit,
        totalSkills: entries.length,
        matchCount: matches.length,
        matches: matches.slice(0, limit),
      });
    },
  };
}
