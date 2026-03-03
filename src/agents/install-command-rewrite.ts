import type { InstallTarget } from "../infra/install-runtime.js";

export type InstallCommandRewrite = {
  command: string;
  rewritten: boolean;
  reason?: string;
  env?: Record<string, string>;
};

function quoteIfNeeded(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function parseSimpleCommand(command: string): string[] | null {
  const trimmed = command.trim();
  if (!trimmed) {
    return null;
  }
  // Keep rewrite scope intentionally narrow to avoid mutating complex shell scripts.
  if (/[\n\r|;&<>`]/.test(trimmed)) {
    return null;
  }
  if (/["'\\]/.test(trimmed)) {
    return null;
  }
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  return tokens.length > 0 ? tokens : null;
}

function hasAnyFlag(tokens: string[], names: string[]): boolean {
  return tokens.some((token) =>
    names.some((name) => token === name || token.startsWith(`${name}=`)),
  );
}

function rewriteNpm(tokens: string[], installRoot: string): InstallCommandRewrite | null {
  const action = tokens[1]?.toLowerCase();
  if (tokens[0] !== "npm" || (action !== "install" && action !== "i")) {
    return null;
  }
  if (!hasAnyFlag(tokens, ["-g", "--global"])) {
    return null;
  }
  if (hasAnyFlag(tokens, ["--prefix"])) {
    return null;
  }
  return {
    command: [...tokens, "--prefix", quoteIfNeeded(installRoot)].join(" "),
    rewritten: true,
    reason: "npm global install redirected to local prefix",
  };
}

function rewritePnpm(
  tokens: string[],
  installRoot: string,
  installBinDir: string,
): InstallCommandRewrite | null {
  const action = tokens[1]?.toLowerCase();
  if (tokens[0] !== "pnpm" || (action !== "add" && action !== "install" && action !== "i")) {
    return null;
  }
  if (!hasAnyFlag(tokens, ["-g", "--global"])) {
    return null;
  }
  if (hasAnyFlag(tokens, ["--global-dir"]) || hasAnyFlag(tokens, ["--global-bin-dir"])) {
    return null;
  }
  return {
    command: [
      ...tokens,
      "--global-dir",
      quoteIfNeeded(installRoot),
      "--global-bin-dir",
      quoteIfNeeded(installBinDir),
    ].join(" "),
    rewritten: true,
    reason: "pnpm global install redirected to local global dirs",
  };
}

function rewriteYarn(tokens: string[], installRoot: string): InstallCommandRewrite | null {
  if (
    tokens[0] !== "yarn" ||
    tokens[1]?.toLowerCase() !== "global" ||
    tokens[2]?.toLowerCase() !== "add"
  ) {
    return null;
  }
  if (hasAnyFlag(tokens, ["--prefix"])) {
    return null;
  }
  return {
    command: [...tokens, "--prefix", quoteIfNeeded(installRoot)].join(" "),
    rewritten: true,
    reason: "yarn global install redirected to local prefix",
  };
}

function rewriteBun(tokens: string[], installRoot: string): InstallCommandRewrite | null {
  if (tokens[0] !== "bun" || tokens[1]?.toLowerCase() !== "add") {
    return null;
  }
  if (!hasAnyFlag(tokens, ["-g", "--global"])) {
    return null;
  }
  return {
    command: tokens.join(" "),
    rewritten: true,
    reason: "bun global install redirected via BUN_INSTALL",
    env: {
      BUN_INSTALL: installRoot,
    },
  };
}

export function rewriteGlobalInstallCommand(params: {
  command: string;
  target: InstallTarget;
  installRoot?: string;
  installBinDir?: string;
}): InstallCommandRewrite {
  if (params.target === "global" || !params.installRoot) {
    return { command: params.command, rewritten: false };
  }

  const tokens = parseSimpleCommand(params.command);
  if (!tokens) {
    return { command: params.command, rewritten: false };
  }

  const installRoot = params.installRoot;
  const installBinDir = params.installBinDir ?? `${installRoot}/bin`;
  const rewritten =
    rewriteNpm(tokens, installRoot) ??
    rewritePnpm(tokens, installRoot, installBinDir) ??
    rewriteYarn(tokens, installRoot) ??
    rewriteBun(tokens, installRoot);

  if (!rewritten) {
    return { command: params.command, rewritten: false };
  }
  return rewritten;
}
