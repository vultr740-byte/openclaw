export async function loadTelegramPollingRuntime() {
  return await import("./polling-session.js");
}
