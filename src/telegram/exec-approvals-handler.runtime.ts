export async function loadTelegramExecApprovalsRuntime() {
  return await import("./exec-approvals-handler.js");
}
