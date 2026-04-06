import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { optionalStringEnum } from "../schema/typebox.js";
import {
  buildWorkspaceSkillCommandSpecs,
  filterWorkspaceSkillEntries,
  loadWorkspaceSkillEntries,
  type SkillEntry,
} from "../skills.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringArrayParam, readStringParam } from "./common.js";
import { searchSkillhubMatches, type SkillhubSearchMatch } from "./skillhub-tool.js";

const SKILLS_SEARCH_SCOPES = ["auto", "local", "remote"] as const;

const SkillsSearchSchema = Type.Object({
  query: Type.String({
    description: "Capability, domain, or URL to match against available skills.",
  }),
  exclude: Type.Optional(
    Type.Array(
      Type.String({
        description:
          "Installed skill names, slash commands, or remote slugs to skip when retrying after a failed attempt.",
      }),
    ),
  ),
  scope: optionalStringEnum(SKILLS_SEARCH_SCOPES, {
    description:
      "Search scope. auto searches installed skills first and also checks remote SkillHub results.",
    default: "auto",
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
  source: "local";
  name: string;
  description: string;
  path: string;
  score: number;
  command?: string;
};

type RemoteSkillMatch = {
  source: "remote";
  name: string;
  description: string;
  slug: string;
  version?: string;
  homepage?: string;
  categories?: string[];
  downloads?: number;
  stars?: number;
  updatedAt?: number;
};

type UnifiedSkillMatch = ScoredSkillMatch | RemoteSkillMatch;

type SkillsSearchNextAction =
  | {
      type: "read_local_skill";
      skillName: string;
      path: string;
      command?: string;
    }
  | {
      type: "install_remote_skill";
      skillName: string;
      slug: string;
      version?: string;
    }
  | {
      type: "refine_search";
      hint: string;
    };

type SkillsSearchScope = (typeof SKILLS_SEARCH_SCOPES)[number];

type RemoteSkillSearchFn = (params: {
  query: string;
  limit: number;
  config?: OpenClawConfig;
}) => Promise<SkillhubSearchMatch[]>;

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

function normalizeExcludedTerms(values: string[] | undefined): Set<string> {
  const normalized = new Set<string>();
  for (const value of values ?? []) {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) {
      continue;
    }
    normalized.add(trimmed);
  }
  return normalized;
}

function isExcludedLocalMatch(match: ScoredSkillMatch, excluded: Set<string>): boolean {
  if (excluded.size === 0) {
    return false;
  }
  return (
    excluded.has(match.name.trim().toLowerCase()) ||
    Boolean(match.command && excluded.has(match.command.trim().toLowerCase()))
  );
}

function isExcludedRemoteMatch(match: RemoteSkillMatch, excluded: Set<string>): boolean {
  if (excluded.size === 0) {
    return false;
  }
  return (
    excluded.has(match.slug.trim().toLowerCase()) || excluded.has(match.name.trim().toLowerCase())
  );
}

function buildLocalMatches(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  query: string;
  limit: number;
}): {
  totalSkills: number;
  matchCount: number;
  matches: ScoredSkillMatch[];
} {
  const entries = filterWorkspaceSkillEntries(
    loadWorkspaceSkillEntries(params.workspaceDir, { config: params.config }),
    params.config,
  ).filter((entry) => entry.invocation?.disableModelInvocation !== true);
  const commandSpecs = buildWorkspaceSkillCommandSpecs(params.workspaceDir, {
    config: params.config,
    entries,
  });
  const commandBySkillName = new Map(
    commandSpecs.map((spec) => [spec.skillName.toLowerCase(), spec.name]),
  );
  const domainHints = extractDomainHints(params.query);
  const terms = buildQueryTerms(params.query, domainHints);
  const docs = entries
    .map((entry) =>
      buildSearchDocument(entry, commandBySkillName.get(entry.skill.name.toLowerCase())),
    )
    .filter((entry): entry is SkillSearchDoc => entry !== null);
  const index = buildSearchIndex(docs);
  const matches: ScoredSkillMatch[] = [];

  for (const doc of index.docs) {
    const score = scoreDocument({
      query: params.query,
      terms,
      domainHints,
      index,
      doc,
    });
    if (score <= 0) {
      continue;
    }
    matches.push({
      source: "local",
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

  return {
    totalSkills: entries.length,
    matchCount: matches.length,
    matches: matches.slice(0, params.limit),
  };
}

function buildRemoteMatches(results: SkillhubSearchMatch[], limit: number): RemoteSkillMatch[] {
  return results.slice(0, limit).map((match) => ({
    source: "remote",
    name: match.name,
    description: match.summary,
    slug: match.slug,
    ...(match.version ? { version: match.version } : {}),
    ...(match.homepage ? { homepage: match.homepage } : {}),
    ...(match.categories ? { categories: match.categories } : {}),
    ...(typeof match.downloads === "number" ? { downloads: match.downloads } : {}),
    ...(typeof match.stars === "number" ? { stars: match.stars } : {}),
    ...(typeof match.updatedAt === "number" ? { updatedAt: match.updatedAt } : {}),
  }));
}

function normalizeSearchScope(value: string | undefined): SkillsSearchScope {
  if (!value) {
    return "auto";
  }
  return SKILLS_SEARCH_SCOPES.includes(value as SkillsSearchScope)
    ? (value as SkillsSearchScope)
    : "auto";
}

function normalizeMatchIdentity(match: UnifiedSkillMatch): string {
  if (match.source === "remote") {
    return `remote:${match.slug.toLowerCase()}`;
  }
  return `local:${match.name.toLowerCase()}`;
}

function hasExactLocalMatch(query: string, localMatches: ScoredSkillMatch[]): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return localMatches.some((match) => {
    const normalizedName = match.name.trim().toLowerCase();
    const normalizedCommand = match.command?.trim().toLowerCase();
    return normalizedName === normalized || normalizedCommand === normalized;
  });
}

function resolveRecommendedSource(params: {
  query: string;
  localMatches: ScoredSkillMatch[];
  remoteMatches: RemoteSkillMatch[];
}): "local" | "remote" | "none" {
  if (params.remoteMatches.length > 0 && !hasExactLocalMatch(params.query, params.localMatches)) {
    return "remote";
  }
  if (params.localMatches.length > 0) {
    return "local";
  }
  if (params.remoteMatches.length > 0) {
    return "remote";
  }
  return "none";
}

function combineMatches(params: {
  recommendedSource: "local" | "remote" | "none";
  localMatches: ScoredSkillMatch[];
  remoteMatches: RemoteSkillMatch[];
  limit: number;
}): UnifiedSkillMatch[] {
  const ordered =
    params.recommendedSource === "remote"
      ? [...params.remoteMatches, ...params.localMatches]
      : [...params.localMatches, ...params.remoteMatches];
  const seen = new Set<string>();
  const combined: UnifiedSkillMatch[] = [];
  for (const match of ordered) {
    const identity = normalizeMatchIdentity(match);
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    combined.push(match);
    if (combined.length >= params.limit) {
      break;
    }
  }
  return combined;
}

function resolveRemoteSearchState(params: {
  scope: SkillsSearchScope;
  queriedRemote: boolean;
  remoteMatches: RemoteSkillMatch[];
  remoteError?: string;
}): { searchedRemote: boolean; remoteSkippedReason?: string } {
  if (params.queriedRemote) {
    return { searchedRemote: true };
  }
  if (params.scope === "local") {
    return { searchedRemote: false, remoteSkippedReason: "scope_local" };
  }
  if (params.remoteError) {
    return { searchedRemote: false, remoteSkippedReason: "remote_error" };
  }
  return { searchedRemote: false, remoteSkippedReason: "not_requested" };
}

function buildNextAction(params: {
  query: string;
  recommendedSource: "local" | "remote" | "none";
  localMatches: ScoredSkillMatch[];
  remoteMatches: RemoteSkillMatch[];
}): SkillsSearchNextAction {
  if (params.recommendedSource === "local" && params.localMatches[0]) {
    const first = params.localMatches[0];
    return {
      type: "read_local_skill",
      skillName: first.name,
      path: first.path,
      ...(first.command ? { command: first.command } : {}),
    };
  }
  if (params.recommendedSource === "remote" && params.remoteMatches[0]) {
    const first = params.remoteMatches[0];
    return {
      type: "install_remote_skill",
      skillName: first.name,
      slug: first.slug,
      ...(first.version ? { version: first.version } : {}),
    };
  }
  return {
    type: "refine_search",
    hint: "Try one narrower query using the exact task goal, domain, command name, or URL host before concluding no matching skill exists.",
  };
}

export function createSkillsSearchTool(options: {
  workspaceDir: string;
  config?: OpenClawConfig;
  remoteSearch?: RemoteSkillSearchFn;
}): AnyAgentTool {
  const remoteSearch =
    options.remoteSearch ??
    (async ({ query, limit, config }: { query: string; limit: number; config?: OpenClawConfig }) =>
      await searchSkillhubMatches({ query, limit, config }));
  return {
    label: "Skills Search",
    name: "skills_search",
    description:
      "Search installed skills first and, in auto mode, also check remote SkillHub results for new skills to install. Use for skill discovery by capability, domain, URL, or command name.",
    parameters: SkillsSearchSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      const excluded = normalizeExcludedTerms(readStringArrayParam(params, "exclude"));
      const scope = normalizeSearchScope(readStringParam(params, "scope"));
      const requestedLimit = readNumberParam(params, "limit", { integer: true });
      const limit = clampMatchLimit(requestedLimit);
      const localResult =
        scope === "remote"
          ? { totalSkills: 0, matchCount: 0, matches: [] as ScoredSkillMatch[] }
          : buildLocalMatches({
              workspaceDir: options.workspaceDir,
              config: options.config,
              query,
              limit,
            });
      let remoteMatches: RemoteSkillMatch[] = [];
      let remoteError: string | undefined;
      const shouldQueryRemote = scope !== "local";
      let queriedRemote = false;
      if (shouldQueryRemote) {
        queriedRemote = true;
        try {
          remoteMatches = buildRemoteMatches(
            await remoteSearch({ query, limit, config: options.config }),
            limit,
          );
        } catch (error) {
          remoteError = error instanceof Error ? error.message : String(error);
        }
      }
      const filteredLocalMatches = localResult.matches.filter(
        (match) => !isExcludedLocalMatch(match, excluded),
      );
      const filteredRemoteMatches = remoteMatches.filter(
        (match) => !isExcludedRemoteMatch(match, excluded),
      );
      const recommendedSource = resolveRecommendedSource({
        query,
        localMatches: filteredLocalMatches,
        remoteMatches: filteredRemoteMatches,
      });
      const matches = combineMatches({
        recommendedSource,
        localMatches: filteredLocalMatches,
        remoteMatches: filteredRemoteMatches,
        limit,
      });
      const remoteState = resolveRemoteSearchState({
        scope,
        queriedRemote,
        remoteMatches,
        remoteError,
      });
      const nextAction = buildNextAction({
        query,
        recommendedSource,
        localMatches: filteredLocalMatches,
        remoteMatches: filteredRemoteMatches,
      });

      return jsonResult({
        query,
        exclude: excluded.size > 0 ? [...excluded] : undefined,
        scope,
        limit,
        ...(scope !== "remote" ? { totalSkills: localResult.totalSkills } : {}),
        matchCount: matches.length,
        localMatchCount: filteredLocalMatches.length,
        remoteMatchCount: filteredRemoteMatches.length,
        remoteProvider: scope !== "local" ? "skillhub" : undefined,
        remoteError,
        ...remoteState,
        recommendedSource,
        nextAction,
        localMatches: filteredLocalMatches,
        remoteMatches: filteredRemoteMatches,
        matches,
      });
    },
  };
}
