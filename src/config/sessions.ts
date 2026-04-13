export * from "./sessions/group.js";
export * from "./sessions/artifacts.js";
export * from "./sessions/metadata.js";
export * from "./sessions/main-session.js";
export * from "./sessions/main-session.runtime.js";
export * from "./sessions/paths.js";
export * from "./sessions/reset.js";
export * from "./sessions/session-key.js";
export * from "./sessions/store.js";
export * from "./sessions/types.js";
export * from "./sessions/transcript.js";
export * from "./sessions/transcript-mirror.js";
export * from "./sessions/session-file.js";
export * from "./sessions/delivery-info.js";
export * from "./sessions/disk-budget.js";
export * from "./sessions/targets.js";

import type { SessionEntry } from "./sessions/types.js";

export function resolveSessionPluginDebugLines(
  entry?: Pick<SessionEntry, "pluginDebugEntries"> | null,
): string[] {
  const lines: string[] = [];
  for (const debugEntry of entry?.pluginDebugEntries ?? []) {
    if (!debugEntry || !Array.isArray(debugEntry.lines)) {
      continue;
    }
    for (const line of debugEntry.lines) {
      if (typeof line !== "string" || !line.trim()) {
        continue;
      }
      lines.push(line);
    }
  }
  return lines;
}
