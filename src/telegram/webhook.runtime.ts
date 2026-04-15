export async function loadTelegramWebhookRuntime() {
  return await import("./webhook.js");
}
