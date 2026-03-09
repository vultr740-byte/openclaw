import { defineConfig } from "vite";

function normalizeBasePath(raw?: string): string {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return "/webchat/";
  }
  let normalized = trimmed;
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  if (!normalized.endsWith("/")) {
    normalized = `${normalized}/`;
  }
  return normalized;
}

export default defineConfig({
  base: normalizeBasePath(process.env.WEBCHAT_BASE_PATH),
  server: {
    port: 5174,
  },
});
