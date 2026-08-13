import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import { TEMPORARY_CODEX_SESSION_PREFIX } from "../server/identity-namespaces.mjs";

const PUBLISH_TOOL = "mcp__semantic_answer__publish_semantic_answer";
const HISTORY_TOOL = "mcp__semantic_answer__read_semantic_history";

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function allowWith(updatedInput) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput,
    },
  };
}

export function deterministicCodexIdempotencyKey(sessionId, turnId) {
  return createHash("sha256").update(`codex:${sessionId}:${turnId}`).digest("hex");
}

function temporaryCodexIdentity(turnId) {
  const digest = createHash("sha256")
    .update(`semantic-answer:temporary-session:v1:${turnId}`)
    .digest("hex");
  const sourceSessionKey = `${TEMPORARY_CODEX_SESSION_PREFIX}${digest}`;
  return {
    sourceSessionKey,
    sourceTurnKey: turnId,
    idempotencyKey: createHash("sha256").update(`${sourceSessionKey}:${turnId}`).digest("hex"),
  };
}

/** Transform only Semantic Answer calls; null means a safe hook no-op. */
export function transformCodexPreToolUse(input) {
  if (!input || typeof input !== "object") {
    return null;
  }
  const toolName = input.tool_name;
  const sessionId = input.session_id;
  const turnId = input.turn_id;
  const originalInput =
    input.tool_input && typeof input.tool_input === "object" && !Array.isArray(input.tool_input)
      ? input.tool_input
      : {};

  if (toolName === PUBLISH_TOOL) {
    if (!nonEmptyString(turnId)) {
      return allowWith({ ...originalInput });
    }
    if (!nonEmptyString(sessionId)) {
      return allowWith({ ...originalInput, ...temporaryCodexIdentity(turnId) });
    }
    return allowWith({
      ...originalInput,
      sourceSessionKey: `codex:${sessionId}`,
      sourceTurnKey: turnId,
      idempotencyKey: deterministicCodexIdempotencyKey(sessionId, turnId),
    });
  }

  if (toolName === HISTORY_TOOL) {
    if (nonEmptyString(sessionId)) {
      return allowWith({ ...originalInput, sourceSessionKey: `codex:${sessionId}` });
    }
    if (!nonEmptyString(turnId)) {
      return allowWith({ ...originalInput });
    }
    return allowWith({ ...originalInput, sourceSessionKey: temporaryCodexIdentity(turnId).sourceSessionKey });
  }
  return null;
}

async function readStandardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function main() {
  let input;
  try {
    const serialized = await readStandardInput();
    if (!serialized.trim()) {
      return;
    }
    input = JSON.parse(serialized);
  } catch {
    return;
  }
  const output = transformCodexPreToolUse(input);
  if (output) {
    process.stdout.write(JSON.stringify(output));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
