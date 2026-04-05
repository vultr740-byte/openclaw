import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { assertCanonicalPathWithinBase } from "../../infra/install-safe-path.js";
import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
import type { SsrFPolicy } from "../../infra/net/ssrf.js";
import { stringEnum } from "../schema/typebox.js";
import { extractArchive } from "../skills-install-extract.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import { type AnyAgentTool, jsonResult, readNumberParam, readStringParam } from "./common.js";

const SKILLHUB_ACTIONS = ["search", "install"] as const;

const SkillhubToolSchema = Type.Object({
  action: stringEnum(SKILLHUB_ACTIONS),
  query: Type.Optional(
    Type.String({
      description: "Free-text capability query for remote skill search.",
    }),
  ),
  slug: Type.Optional(
    Type.String({
      description: "Remote skill slug to install.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 20,
      description: "Maximum number of search matches to return.",
    }),
  ),
});

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 20;

const DEFAULT_SKILLHUB_CONFIG = {
  enabled: true,
  searchUrl: "https://api.skillhub.tencent.com/api/v1/search",
  detailUrlTemplate: "https://api.skillhub.tencent.com/api/v1/skills/{slug}",
  primaryDownloadUrlTemplate: "https://api.skillhub.tencent.com/api/v1/download?slug={slug}",
  downloadUrlTemplate:
    "https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com/skills/{slug}/{version}.zip",
  timeoutMs: DEFAULT_TIMEOUT_MS,
} as const;

const DEFAULT_SKILLHUB_ALLOWED_HOSTS = [
  "api.skillhub.cn",
  "api.skillhub.tencent.com",
  "skillhub-1388575217.cos.ap-guangzhou.myqcloud.com",
  "skillhub-1388575217.cos.accelerate.myqcloud.com",
] as const;

type SkillHubCatalogEntry = {
  slug?: string;
  name?: string;
  description?: string;
  version?: string;
  homepage?: string;
  downloads?: number;
  stars?: number;
  categories?: string[];
};

type SkillHubDetailResponse = {
  latestVersion?: {
    version?: string;
  };
  skill?: {
    slug?: string;
    displayName?: string;
    summary?: string;
    summary_zh?: string;
    category?: string;
    homepage?: string;
    source?: string;
    updatedAt?: number;
    stats?: {
      downloads?: number;
      stars?: number;
    };
  };
};

type SkillHubSearchEntry = {
  displayName?: string;
  slug?: string;
  summary?: string;
  version?: string;
  updatedAt?: number;
};

type SkillHubSearchResponse = {
  results?: SkillHubSearchEntry[];
};

type ResolvedSkillHubConfig = {
  enabled: boolean;
  searchUrl: string;
  detailUrlTemplate: string;
  primaryDownloadUrlTemplate: string;
  downloadUrlTemplate: string;
  timeoutMs: number;
};

type NormalizedSkillHubSearchResult = {
  slug: string;
  name: string;
  summary: string;
  version?: string;
  updatedAt?: number;
  homepage?: string;
  categories?: string[];
  downloads?: number;
  stars?: number;
};

type SkillHubInstallMetadata = {
  slug: string;
  name: string;
  version?: string;
  homepage?: string;
  downloadUrl: string;
  skillDir: string;
};

function validateSkillSlug(slugRaw: string): string {
  const slug = slugRaw.trim();
  if (!slug) {
    throw new Error("slug required");
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(slug)) {
    throw new Error(`Invalid skill slug "${slug}"`);
  }
  return slug;
}

function clampSearchLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SEARCH_LIMIT;
  }
  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.trunc(value)));
}

function resolveSkillHubConfig(config?: OpenClawConfig): ResolvedSkillHubConfig {
  const hub = config?.skills?.hub;
  const timeoutMs =
    typeof hub?.timeoutMs === "number" && Number.isFinite(hub.timeoutMs) && hub.timeoutMs > 0
      ? Math.trunc(hub.timeoutMs)
      : DEFAULT_SKILLHUB_CONFIG.timeoutMs;

  return {
    enabled: hub?.enabled ?? DEFAULT_SKILLHUB_CONFIG.enabled,
    searchUrl: hub?.searchUrl?.trim() || DEFAULT_SKILLHUB_CONFIG.searchUrl,
    detailUrlTemplate:
      hub?.detailUrlTemplate?.trim() ||
      hub?.indexUrl?.trim() ||
      DEFAULT_SKILLHUB_CONFIG.detailUrlTemplate,
    primaryDownloadUrlTemplate:
      hub?.primaryDownloadUrlTemplate?.trim() || DEFAULT_SKILLHUB_CONFIG.primaryDownloadUrlTemplate,
    downloadUrlTemplate:
      hub?.downloadUrlTemplate?.trim() || DEFAULT_SKILLHUB_CONFIG.downloadUrlTemplate,
    timeoutMs,
  };
}

function assertSkillHubEnabled(config: ResolvedSkillHubConfig): void {
  if (!config.enabled) {
    throw new Error(
      "Native SkillHub integration is disabled by config (skills.hub.enabled=false).",
    );
  }
}

function applyTemplate(template: string, vars: Record<string, string | undefined>): string {
  return template.replaceAll(/\{([a-zA-Z0-9_]+)\}/g, (_match, key: string) => {
    const value = vars[key];
    return value ? encodeURIComponent(value) : "";
  });
}

function extractHostname(raw: string): string | null {
  const value = raw.trim();
  if (!value) {
    return null;
  }
  try {
    return new URL(value.replaceAll(/\{[^}]+\}/g, "placeholder")).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

function buildSkillHubSsrFPolicy(config: ResolvedSkillHubConfig): SsrFPolicy | undefined {
  const hostnames = [
    ...DEFAULT_SKILLHUB_ALLOWED_HOSTS,
    extractHostname(config.searchUrl),
    extractHostname(config.detailUrlTemplate),
    extractHostname(config.primaryDownloadUrlTemplate),
    extractHostname(config.downloadUrlTemplate),
  ].filter((value): value is string => Boolean(value));

  if (hostnames.length === 0) {
    return undefined;
  }
  const uniqueHosts = Array.from(new Set(hostnames));
  return {
    allowedHostnames: uniqueHosts,
    hostnameAllowlist: uniqueHosts,
  };
}

async function fetchJson<T>(url: string, timeoutMs: number, policy?: SsrFPolicy): Promise<T> {
  const { response, release } = await fetchWithSsrFGuard({
    url,
    timeoutMs,
    policy,
  });
  try {
    if (!response.ok) {
      throw new Error(`Request failed (${response.status} ${response.statusText})`);
    }
    return (await response.json()) as T;
  } finally {
    await release();
  }
}

async function downloadToFile(params: {
  url: string;
  filePath: string;
  timeoutMs: number;
  policy?: SsrFPolicy;
}): Promise<void> {
  const { response, release } = await fetchWithSsrFGuard({
    url: params.url,
    timeoutMs: params.timeoutMs,
    policy: params.policy,
  });
  try {
    if (!response.ok || !response.body) {
      throw new Error(`Download failed (${response.status} ${response.statusText})`);
    }
    const arrayBuffer = await response.arrayBuffer();
    await fs.writeFile(params.filePath, Buffer.from(arrayBuffer));
  } finally {
    await release();
  }
}

function normalizeSearchResult(params: {
  result: SkillHubSearchEntry;
  detailBySlug: Map<string, SkillHubCatalogEntry>;
}): NormalizedSkillHubSearchResult | null {
  const slug = params.result.slug?.trim();
  if (!slug) {
    return null;
  }
  const detail = params.detailBySlug.get(slug);
  const name = params.result.displayName?.trim() || detail?.name?.trim() || slug;
  const summary = params.result.summary?.trim() || detail?.description?.trim() || name;
  return {
    slug,
    name,
    summary,
    ...(params.result.version?.trim() ? { version: params.result.version.trim() } : {}),
    ...(typeof params.result.updatedAt === "number" && Number.isFinite(params.result.updatedAt)
      ? { updatedAt: params.result.updatedAt }
      : {}),
    ...(detail?.homepage?.trim() ? { homepage: detail.homepage.trim() } : {}),
    ...(Array.isArray(detail?.categories) && detail.categories.length > 0
      ? { categories: detail.categories.filter((value) => typeof value === "string") }
      : {}),
    ...(typeof detail?.downloads === "number" ? { downloads: detail.downloads } : {}),
    ...(typeof detail?.stars === "number" ? { stars: detail.stars } : {}),
  };
}

function normalizeDetailEntry(detail: SkillHubDetailResponse): SkillHubCatalogEntry | null {
  const slug = detail.skill?.slug?.trim();
  if (!slug) {
    return null;
  }
  const category = detail.skill?.category?.trim();
  return {
    slug,
    name: detail.skill?.displayName?.trim() || slug,
    description: detail.skill?.summary_zh?.trim() || detail.skill?.summary?.trim() || slug,
    version: detail.latestVersion?.version?.trim(),
    homepage: detail.skill?.homepage?.trim(),
    categories: category ? [category] : undefined,
    downloads: detail.skill?.stats?.downloads,
    stars: detail.skill?.stats?.stars,
  };
}

function resolveArchiveName(downloadUrl: string, slug: string, version?: string): string {
  try {
    const parsed = new URL(downloadUrl);
    const name = path.basename(parsed.pathname);
    if (name.trim()) {
      return name;
    }
  } catch {
    // fall through
  }
  return `${slug}${version ? `-${version}` : ""}.zip`;
}

function inferStripComponents(entries: string[]): number {
  const filtered = entries
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => !entry.endsWith("/"));
  if (filtered.length === 0) {
    return 0;
  }
  const topLevel = new Set<string>();
  for (const entry of filtered) {
    const [first] = entry.split("/");
    if (!first) {
      return 0;
    }
    topLevel.add(first);
  }
  if (topLevel.size !== 1) {
    return 0;
  }
  const prefix = `${[...topLevel][0]}/`;
  const everyEntryNested = filtered.every((entry) => entry.startsWith(prefix));
  return everyEntryNested ? 1 : 0;
}

async function listZipEntries(zipPath: string): Promise<string[]> {
  const buffer = await fs.readFile(zipPath);
  const signature = 0x02014b50;
  const entries: string[] = [];
  let offset = 0;

  while (offset + 46 <= buffer.length) {
    const sig = buffer.readUInt32LE(offset);
    if (sig !== signature) {
      offset += 1;
      continue;
    }
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + fileNameLength;
    if (nameEnd > buffer.length) {
      break;
    }
    entries.push(buffer.toString("utf8", nameStart, nameEnd));
    offset = nameEnd + extraLength + commentLength;
  }

  return entries;
}

async function publishInstalledSkillDir(params: {
  extractedDir: string;
  skillDir: string;
}): Promise<void> {
  try {
    await fs.rename(params.extractedDir, params.skillDir);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EXDEV") {
      throw error;
    }
  }

  try {
    await fs.cp(params.extractedDir, params.skillDir, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  } catch (error) {
    await fs.rm(params.skillDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function installSkillArchive(params: {
  workspaceDir: string;
  slug: string;
  version?: string;
  downloadUrl: string;
  timeoutMs: number;
  policy?: SsrFPolicy;
}): Promise<string> {
  const workspaceDir = resolveWorkspaceRoot(params.workspaceDir);
  const skillsRoot = path.join(workspaceDir, "skills");
  const skillDir = path.join(skillsRoot, params.slug);
  try {
    await fs.access(skillDir);
    throw new Error(`Skill "${params.slug}" already exists in the workspace`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
  }
  await fs.mkdir(skillsRoot, { recursive: true });
  await assertCanonicalPathWithinBase({
    baseDir: workspaceDir,
    candidatePath: skillsRoot,
    boundaryLabel: "workspace",
  });

  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skillhub-"));
  const archivePath = path.join(
    stagingDir,
    resolveArchiveName(params.downloadUrl, params.slug, params.version),
  );

  try {
    await downloadToFile({
      url: params.downloadUrl,
      filePath: archivePath,
      timeoutMs: params.timeoutMs,
      policy: params.policy,
    });
    const zipEntries = await listZipEntries(archivePath);
    const stripComponents = inferStripComponents(zipEntries);
    const extractTarget = path.join(stagingDir, "extract");
    await fs.mkdir(extractTarget, { recursive: true });
    const result = await extractArchive({
      archivePath,
      archiveType: "zip",
      targetDir: extractTarget,
      stripComponents,
      timeoutMs: params.timeoutMs,
    });
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || "Skill archive extraction failed");
    }

    const extractedSkillFile = path.join(extractTarget, "SKILL.md");
    const extractedMetaFile = path.join(extractTarget, "_meta.json");
    try {
      await fs.access(extractedSkillFile);
      await fs.access(extractedMetaFile);
    } catch {
      throw new Error("Downloaded archive does not look like a skill package");
    }
    await fs.mkdir(path.dirname(skillDir), { recursive: true });
    await publishInstalledSkillDir({
      extractedDir: extractTarget,
      skillDir,
    });
    return skillDir;
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function loadSkillDetail(params: {
  config: ResolvedSkillHubConfig;
  slug: string;
}): Promise<SkillHubCatalogEntry | null> {
  const detailUrl = applyTemplate(params.config.detailUrlTemplate, {
    slug: params.slug,
  });
  const detail = await fetchJson<SkillHubDetailResponse>(
    detailUrl,
    params.config.timeoutMs,
    buildSkillHubSsrFPolicy(params.config),
  );
  return normalizeDetailEntry(detail);
}

async function runSearch(params: { config: ResolvedSkillHubConfig; query: string; limit: number }) {
  const policy = buildSkillHubSsrFPolicy(params.config);
  const searchUrl = new URL(params.config.searchUrl);
  searchUrl.searchParams.set("q", params.query);
  searchUrl.searchParams.set("limit", String(params.limit));

  const searchResponse = await fetchJson<SkillHubSearchResponse>(
    searchUrl.toString(),
    params.config.timeoutMs,
    policy,
  );
  const searchResults = searchResponse.results ?? [];
  const detailEntries = await Promise.all(
    searchResults.map(async (result) => {
      const slug = result.slug?.trim();
      if (!slug) {
        return null;
      }
      try {
        return await loadSkillDetail({
          config: params.config,
          slug,
        });
      } catch {
        return { slug } satisfies SkillHubCatalogEntry;
      }
    }),
  );
  const detailBySlug = new Map<string, SkillHubCatalogEntry>();
  for (const entry of detailEntries) {
    if (!entry) {
      continue;
    }
    const slug = entry?.slug?.trim();
    if (!slug || detailBySlug.has(slug)) {
      continue;
    }
    detailBySlug.set(slug, entry);
  }

  const matches = searchResults
    .map((result) => normalizeSearchResult({ result, detailBySlug }))
    .filter((result): result is NormalizedSkillHubSearchResult => Boolean(result));

  return jsonResult({
    provider: "skillhub",
    query: params.query,
    count: matches.length,
    matches,
  });
}

async function runInstall(params: {
  config: ResolvedSkillHubConfig;
  workspaceDir: string;
  slug: string;
}) {
  const policy = buildSkillHubSsrFPolicy(params.config);
  const entry = await loadSkillDetail({
    config: params.config,
    slug: params.slug,
  });
  const version = entry?.version?.trim();
  const primaryUrl = applyTemplate(params.config.primaryDownloadUrlTemplate, {
    slug: params.slug,
    version,
  });
  const fallbackUrl =
    version && params.config.downloadUrlTemplate
      ? applyTemplate(params.config.downloadUrlTemplate, {
          slug: params.slug,
          version,
        })
      : "";

  const attempts = [primaryUrl, fallbackUrl].filter(Boolean);
  let lastError: unknown;

  for (const downloadUrl of attempts) {
    try {
      const skillDir = await installSkillArchive({
        workspaceDir: params.workspaceDir,
        slug: params.slug,
        version,
        downloadUrl,
        timeoutMs: params.config.timeoutMs,
        policy,
      });
      const metadata: SkillHubInstallMetadata = {
        slug: params.slug,
        name: entry?.name?.trim() || params.slug,
        ...(version ? { version } : {}),
        ...(entry?.homepage?.trim() ? { homepage: entry.homepage.trim() } : {}),
        downloadUrl,
        skillDir,
      };
      return jsonResult({
        provider: "skillhub",
        installed: true,
        skill: metadata,
      });
    } catch (error) {
      lastError = error;
    }
  }

  const message = lastError instanceof Error ? lastError.message : "SkillHub install failed";
  throw new Error(message);
}

export function createSkillhubTool(options: {
  workspaceDir: string;
  config?: OpenClawConfig;
}): AnyAgentTool {
  return {
    label: "SkillHub",
    name: "skillhub",
    description:
      "Search and install remote skills from the configured SkillHub registry into the current workspace. Use action=search to discover skills and action=install to add one by slug.",
    parameters: SkillhubToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const config = resolveSkillHubConfig(options.config);
      assertSkillHubEnabled(config);

      switch (action) {
        case "search": {
          const query = readStringParam(params, "query", { required: true });
          const limit = clampSearchLimit(readNumberParam(params, "limit"));
          return await runSearch({
            config,
            query,
            limit,
          });
        }
        case "install": {
          const slug = validateSkillSlug(readStringParam(params, "slug", { required: true }));
          return await runInstall({
            config,
            workspaceDir: options.workspaceDir,
            slug,
          });
        }
        default:
          throw new Error(`Unsupported skillhub action "${action}"`);
      }
    },
  };
}
