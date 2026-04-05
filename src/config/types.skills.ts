import type { SecretInput } from "./types.secrets.js";

export type SkillConfig = {
  enabled?: boolean;
  apiKey?: SecretInput;
  env?: Record<string, string>;
  config?: Record<string, unknown>;
};

export type SkillsLoadConfig = {
  /**
   * Additional skill folders to scan (lowest precedence).
   * Each directory should contain skill subfolders with `SKILL.md`.
   */
  extraDirs?: string[];
  /** Watch skill folders for changes and refresh the skills snapshot. */
  watch?: boolean;
  /** Debounce for the skills watcher (ms). */
  watchDebounceMs?: number;
};

export type SkillsInstallConfig = {
  /** Install location mode for skill-managed installers (default: auto). */
  mode?: "auto" | "global";
  preferBrew?: boolean;
  nodeManager?: "npm" | "pnpm" | "yarn" | "bun";
};

export type SkillsLimitsConfig = {
  /** Max number of immediate child directories to consider under a skills root before treating it as suspicious. */
  maxCandidatesPerRoot?: number;
  /** Max number of skills to load per skills source (bundled/managed/workspace/extra). */
  maxSkillsLoadedPerSource?: number;
  /** Max number of skills to include in the model-facing skills prompt. */
  maxSkillsInPrompt?: number;
  /** Max characters for the model-facing skills prompt block (approx). */
  maxSkillsPromptChars?: number;
  /** Max size (bytes) allowed for a SKILL.md file to be considered. */
  maxSkillFileBytes?: number;
};

export type SkillsHubConfig = {
  /** Enable the native remote SkillHub integration. */
  enabled?: boolean;
  /** Search endpoint returning SkillHub search results. */
  searchUrl?: string;
  /** Deprecated alias kept for backwards compatibility with earlier native SkillHub config. */
  indexUrl?: string;
  /** Detail endpoint template returning skill metadata for a slug. */
  detailUrlTemplate?: string;
  /** Primary download URL template, for example `https://host/download?slug={slug}`. */
  primaryDownloadUrlTemplate?: string;
  /** Fallback download URL template, for example `https://cdn/skills/{slug}/{version}.zip`. */
  downloadUrlTemplate?: string;
  /** Timeout in milliseconds for SkillHub HTTP requests. */
  timeoutMs?: number;
};

export type SkillsConfig = {
  /** Optional bundled-skill allowlist (only affects bundled skills). */
  allowBundled?: string[];
  hub?: SkillsHubConfig;
  load?: SkillsLoadConfig;
  install?: SkillsInstallConfig;
  limits?: SkillsLimitsConfig;
  entries?: Record<string, SkillConfig>;
};
