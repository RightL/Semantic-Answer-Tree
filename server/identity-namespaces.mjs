export const TEMPORARY_CODEX_SESSION_PREFIX = "codex-temporary:v1:";

export function isTemporarySourceSessionKey(value) {
  return typeof value === "string" && value.startsWith(TEMPORARY_CODEX_SESSION_PREFIX);
}
