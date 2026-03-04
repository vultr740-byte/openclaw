import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import {
  buildWorkspaceSkillCommandSpecs,
  filterWorkspaceSkillEntries,
  loadWorkspaceSkillEntries,
  type SkillEntry,
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
const BM25_K1 = 1.2;
const BM25_B = 0.75;

const SEARCH_FIELD_BOOSTS = {
  name: 5.2,
  description: 2.6,
  homepage: 1.9,
  path: 1.3,
  command: 2.2,
} as const;

const SEARCH_FIELDS = Object.keys(SEARCH_FIELD_BOOSTS) as SearchFieldKey[];

type SearchFieldKey = keyof typeof SEARCH_FIELD_BOOSTS;

type ScoredSkillMatch = {
  name: string;
  description: string;
  path: string;
  score: number;
  command?: string;
};

type DomainHints = {
  hosts: string[];
  firstLabels: string[];
};

type SkillSearchDoc = {
  name: string;
  description: string;
  path: string;
  command?: string;
  homepage?: string;
  searchable: Record<SearchFieldKey, string>;
  tokenFrequency: Record<SearchFieldKey, Map<string, number>>;
  tokenLengths: Record<SearchFieldKey, number>;
};

type FieldStats = {
  avgLength: number;
  docFrequency: Map<string, number>;
};

type SearchIndex = {
  docs: SkillSearchDoc[];
  fieldStats: Record<SearchFieldKey, FieldStats>;
};

function clampMatchLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MATCH_LIMIT;
  }
  return Math.max(1, Math.min(MAX_MATCH_LIMIT, Math.floor(value)));
}

function tokenize(value: string, minLength = 2): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= minLength);
}

function tokenizeForField(field: SearchFieldKey, value: string): string[] {
  const minLength = field === "name" || field === "command" ? 1 : 2;
  return tokenize(value, minLength);
}

function toFrequency(tokens: string[]): Map<string, number> {
  const frequency = new Map<string, number>();
  for (const token of tokens) {
    frequency.set(token, (frequency.get(token) ?? 0) + 1);
  }
  return frequency;
}

function extractDomainHints(query: string): DomainHints {
  const hosts = new Set<string>();
  const firstLabels = new Set<string>();
  const lower = query.toLowerCase();

  const addHostname = (hostnameRaw: string) => {
    const hostname = hostnameRaw
      .trim()
      .toLowerCase()
      .replace(/^www\./, "");
    if (!hostname) {
      return;
    }
    hosts.add(hostname);
    const firstLabel = hostname.split(".")[0]?.trim();
    if (firstLabel) {
      firstLabels.add(firstLabel);
    }
  };

  for (const token of lower.split(/\s+/g)) {
    const trimmed = token.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = new URL(trimmed);
      if (parsed.hostname) {
        addHostname(parsed.hostname);
      }
    } catch {
      if (trimmed.includes(".") && /^[a-z0-9.-]+$/.test(trimmed)) {
        addHostname(trimmed);
      }
    }
  }

  return {
    hosts: [...hosts],
    firstLabels: [...firstLabels],
  };
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function includesToken(text: string, token: string): boolean {
  if (!token) {
    return false;
  }
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegex(token)}([^a-z0-9]|$)`);
  return pattern.test(text);
}

function inverseDocumentFrequency(totalDocs: number, docFrequency: number): number {
  if (totalDocs <= 0 || docFrequency <= 0) {
    return 0;
  }
  return Math.log(1 + (totalDocs - docFrequency + 0.5) / (docFrequency + 0.5));
}

function bm25Weight(termFrequency: number, docLength: number, avgDocLength: number): number {
  if (termFrequency <= 0) {
    return 0;
  }
  const safeAvgDocLength = avgDocLength > 0 ? avgDocLength : 1;
  const numerator = termFrequency * (BM25_K1 + 1);
  const denominator =
    termFrequency + BM25_K1 * (1 - BM25_B + BM25_B * (docLength / safeAvgDocLength));
  return denominator > 0 ? numerator / denominator : 0;
}

function buildSearchDocument(entry: SkillEntry, command?: string): SkillSearchDoc | null {
  const name = entry.skill.name.trim();
  if (!name) {
    return null;
  }
  const description = entry.skill.description?.trim() || name;
  const homepage = entry.metadata?.homepage?.trim();
  const searchable: Record<SearchFieldKey, string> = {
    name: name.toLowerCase(),
    description: description.toLowerCase(),
    homepage: (homepage ?? "").toLowerCase(),
    path: entry.skill.filePath.toLowerCase(),
    command: (command ?? "").toLowerCase(),
  };
  const tokenFrequency = Object.fromEntries(
    SEARCH_FIELDS.map((field) => {
      const tokens = tokenizeForField(field, searchable[field]);
      return [field, toFrequency(tokens)];
    }),
  ) as Record<SearchFieldKey, Map<string, number>>;
  const tokenLengths = Object.fromEntries(
    SEARCH_FIELDS.map((field) => {
      const len = [...tokenFrequency[field].values()].reduce((sum, value) => sum + value, 0);
      return [field, len];
    }),
  ) as Record<SearchFieldKey, number>;

  return {
    name,
    description,
    path: entry.skill.filePath,
    ...(command ? { command: `/${command}` } : {}),
    ...(homepage ? { homepage } : {}),
    searchable,
    tokenFrequency,
    tokenLengths,
  };
}

function buildSearchIndex(docs: SkillSearchDoc[]): SearchIndex {
  const fieldStats = Object.fromEntries(
    SEARCH_FIELDS.map((field) => [
      field,
      { avgLength: 1, docFrequency: new Map<string, number>() },
    ]),
  ) as Record<SearchFieldKey, FieldStats>;

  if (docs.length === 0) {
    return { docs, fieldStats };
  }

  for (const field of SEARCH_FIELDS) {
    let totalLength = 0;
    const docFrequency = new Map<string, number>();
    for (const doc of docs) {
      totalLength += doc.tokenLengths[field];
      for (const term of doc.tokenFrequency[field].keys()) {
        docFrequency.set(term, (docFrequency.get(term) ?? 0) + 1);
      }
    }
    fieldStats[field] = {
      avgLength: totalLength > 0 ? totalLength / docs.length : 1,
      docFrequency,
    };
  }

  return { docs, fieldStats };
}

function scoreDocument(params: {
  query: string;
  terms: string[];
  domainHints: DomainHints;
  index: SearchIndex;
  doc: SkillSearchDoc;
}): number {
  const query = params.query.toLowerCase().trim();
  let score = 0;
  const totalDocs = params.index.docs.length;

  for (const term of params.terms) {
    for (const field of SEARCH_FIELDS) {
      const tf = params.doc.tokenFrequency[field].get(term) ?? 0;
      if (tf <= 0) {
        continue;
      }
      const stats = params.index.fieldStats[field];
      const df = stats.docFrequency.get(term) ?? 0;
      const idf = inverseDocumentFrequency(totalDocs, df);
      if (idf <= 0) {
        continue;
      }
      score +=
        SEARCH_FIELD_BOOSTS[field] *
        idf *
        bm25Weight(tf, params.doc.tokenLengths[field], stats.avgLength);
    }
  }

  if (query) {
    if (params.doc.searchable.name === query) {
      score += 18;
    }
    if (params.doc.searchable.name.includes(query)) {
      score += 10;
    }
    if (params.doc.searchable.command.includes(query)) {
      score += 8;
    }
    if (params.doc.searchable.description.includes(query)) {
      score += 5;
    }
    if (params.doc.searchable.homepage.includes(query)) {
      score += 6;
    }
  }

  for (const host of params.domainHints.hosts) {
    if (params.doc.searchable.homepage.includes(host)) {
      score += 7;
    }
    if (params.doc.searchable.description.includes(host)) {
      score += 3;
    }
    if (params.doc.searchable.path.includes(host)) {
      score += 1.5;
    }
  }

  for (const label of params.domainHints.firstLabels) {
    if (includesToken(params.doc.searchable.command, label)) {
      score += 2.5;
    }
    if (includesToken(params.doc.searchable.name, label)) {
      score += 2;
    }
    if (includesToken(params.doc.searchable.description, label)) {
      score += 1;
    }
  }

  return score;
}

function buildQueryTerms(query: string, domainHints: DomainHints): string[] {
  const baseTokens = tokenize(query);
  const hostTokens = domainHints.hosts.flatMap((host) => tokenize(host));
  const labelTokens = domainHints.firstLabels.flatMap((label) => tokenize(label, 1));
  const unique = new Set<string>([...baseTokens, ...hostTokens, ...labelTokens]);
  return [...unique];
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
      const domainHints = extractDomainHints(query);
      const terms = buildQueryTerms(query, domainHints);
      const docs = entries
        .map((entry) =>
          buildSearchDocument(entry, commandBySkillName.get(entry.skill.name.toLowerCase())),
        )
        .filter((entry): entry is SkillSearchDoc => entry !== null);
      const index = buildSearchIndex(docs);
      const matches: ScoredSkillMatch[] = [];

      for (const doc of index.docs) {
        const score = scoreDocument({
          query,
          terms,
          domainHints,
          index,
          doc,
        });
        if (score <= 0) {
          continue;
        }
        matches.push({
          name: doc.name,
          description: doc.description,
          path: doc.path,
          score,
          ...(doc.command ? { command: doc.command } : {}),
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
