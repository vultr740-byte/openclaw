import path from "node:path";
import { fileURLToPath } from "node:url";

export function resolveRuntimeModuleCandidates(
  moduleUrl: string,
  candidateNames: string[],
): string[] {
  const runtimeDir = path.dirname(fileURLToPath(moduleUrl));
  const pluginRuntimeSuffix = path.join("plugins", "runtime");
  const candidateRoots = [runtimeDir];
  if (!runtimeDir.endsWith(pluginRuntimeSuffix)) {
    candidateRoots.push(path.join(runtimeDir, pluginRuntimeSuffix));
  }
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const candidateRoot of candidateRoots) {
    for (const candidateName of candidateNames) {
      const candidate = path.join(candidateRoot, candidateName);
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      candidates.push(candidate);
    }
  }

  return candidates;
}
