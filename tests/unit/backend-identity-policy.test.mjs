import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";

import {
  deterministicCodexIdempotencyKey,
  transformCodexPreToolUse,
} from "../../integration/codex-session-hook.mjs";
import { TEMPORARY_CODEX_SESSION_PREFIX } from "../../server/identity-namespaces.mjs";
import {
  VIEWER_SUCCESS_FINAL,
  finalResponseForPublication,
} from "../../server/final-surface-policy.mjs";
import {
  SemanticAnswerServiceClient,
  executePublishSemanticAnswer,
} from "../../server/publisher.mjs";
import { validateCapabilityToken } from "../../server/capability-token.mjs";
import {
  MissingSessionIdentityError,
  SessionIdentityProvider,
} from "../../server/session-identity.mjs";
import { publication } from "./backend-test-helpers.mjs";

test("SessionIdentityProvider prefers injected identity, falls back only to explicit env, and rejects absence", () => {
  const provider = new SessionIdentityProvider({
    environment: {
      SEMANTIC_ANSWER_SESSION_KEY: "bound-session",
      SEMANTIC_ANSWER_TURN_KEY: "bound-turn",
    },
  });
  assert.deepEqual(provider.bind({ sourceSessionKey: "hook-session", sourceTurnKey: "hook-turn" }), {
    sourceSessionKey: "hook-session",
    sourceTurnKey: "hook-turn",
  });
  assert.deepEqual(provider.bind({ requestSummary: "x" }), {
    requestSummary: "x",
    sourceSessionKey: "bound-session",
    sourceTurnKey: "bound-turn",
  });
  assert.throws(
    () => new SessionIdentityProvider({ environment: {} }).bind({}),
    MissingSessionIdentityError,
  );
});

test("Codex hook namespaces and overwrites publication identity deterministically", () => {
  const input = {
    tool_name: "mcp__semantic_answer_tree__publish_semantic_answer",
    session_id: "thread-123",
    turn_id: "turn-456",
    tool_input: {
      ...publication(),
      sourceSessionKey: "model-guessed-session",
      sourceTurnKey: "model-guessed-turn",
      idempotencyKey: "model-guessed-idempotency",
    },
  };
  const transformed = transformCodexPreToolUse(input);
  const updated = transformed.hookSpecificOutput.updatedInput;
  assert.equal(transformed.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(transformed.hookSpecificOutput.permissionDecision, "allow");
  assert.equal(updated.sourceSessionKey, "codex:thread-123");
  assert.equal(updated.sourceTurnKey, "turn-456");
  assert.equal(
    updated.idempotencyKey,
    createHash("sha256").update("codex:thread-123:turn-456").digest("hex"),
  );
  assert.equal(
    deterministicCodexIdempotencyKey("thread-123", "turn-456"),
    updated.idempotencyKey,
  );
  assert.equal(updated.document, input.tool_input.document);
});

test("Codex hook injects history identity and is an empty-output no-op for other tools", () => {
  const history = transformCodexPreToolUse({
    tool_name: "mcp__semantic_answer_tree__read_semantic_history",
    session_id: "thread-history",
    turn_id: "turn-history",
    tool_input: { limit: 3, sourceSessionKey: "wrong" },
  });
  assert.deepEqual(history.hookSpecificOutput.updatedInput, {
    limit: 3,
    sourceSessionKey: "codex:thread-history",
  });
  assert.equal(transformCodexPreToolUse({ tool_name: "mcp__other__tool" }), null);

  const executable = path.resolve("integration", "codex-session-hook.mjs");
  const child = spawnSync(process.execPath, [executable], {
    input: JSON.stringify({ tool_name: "mcp__other__tool", tool_input: { secret: true } }),
    encoding: "utf8",
  });
  assert.equal(child.status, 0);
  assert.equal(child.stdout, "");
});

test("Codex identity stays stable on retry and separates another conversation and fork", () => {
  const call = (sessionId, turnId) =>
    transformCodexPreToolUse({
      tool_name: "mcp__semantic_answer_tree__publish_semantic_answer",
      session_id: sessionId,
      turn_id: turnId,
      tool_input: publication(),
    }).hookSpecificOutput.updatedInput;
  const original = call("thread-original", "turn-1");
  const resumedRetry = call("thread-original", "turn-1");
  const otherConversation = call("thread-other", "turn-1");
  const fork = call("thread-fork", "turn-1");

  assert.deepEqual(resumedRetry, original);
  assert.notEqual(otherConversation.sourceSessionKey, original.sourceSessionKey);
  assert.notEqual(fork.sourceSessionKey, original.sourceSessionKey);
  assert.notEqual(otherConversation.idempotencyKey, original.idempotencyKey);
  assert.notEqual(fork.idempotencyKey, original.idempotencyKey);
});

test("Codex hook derives stable temporary identity for a side chat without a session id", () => {
  const input = {
    tool_name: "mcp__semantic_answer_tree__publish_semantic_answer",
    turn_id: "side-chat-turn-1",
    tool_use_id: "side-chat-tool-1",
    tool_input: {
      ...publication(),
      sourceSessionKey: "model-guessed-session",
      sourceTurnKey: "model-guessed-turn",
      idempotencyKey: "model-guessed-idempotency",
    },
  };

  const first = transformCodexPreToolUse(input).hookSpecificOutput.updatedInput;
  const retry = transformCodexPreToolUse(input).hookSpecificOutput.updatedInput;

  assert.deepEqual(retry, first);
  const sessionDigest = createHash("sha256")
    .update("semantic-answer-tree:temporary-session:v1:side-chat-turn-1")
    .digest("hex");
  assert.equal(first.sourceSessionKey, `${TEMPORARY_CODEX_SESSION_PREFIX}${sessionDigest}`);
  assert.equal(first.sourceTurnKey, "side-chat-turn-1");
  assert.equal(
    first.idempotencyKey,
    createHash("sha256")
      .update(`${first.sourceSessionKey}:side-chat-turn-1`)
      .digest("hex"),
  );
  assert.notEqual(first.sourceSessionKey, input.tool_input.sourceSessionKey);
  assert.doesNotMatch(first.sourceSessionKey, /side-chat-turn-1/);
  assert.notEqual(first.idempotencyKey, input.tool_input.idempotencyKey);

  const history = transformCodexPreToolUse({
    tool_name: "mcp__semantic_answer_tree__read_semantic_history",
    turn_id: "side-chat-turn-1",
    tool_use_id: "side-chat-history-tool",
    tool_input: { limit: 3, sourceSessionKey: "model-guessed-session" },
  }).hookSpecificOutput.updatedInput;
  assert.deepEqual(history, {
    limit: 3,
    sourceSessionKey: first.sourceSessionKey,
  });
});

test("Codex temporary identity spans tool uses, separates side chats, and preserves durable identity", () => {
  const temporary = (turnId, toolUseId) =>
    transformCodexPreToolUse({
      tool_name: "mcp__semantic_answer_tree__publish_semantic_answer",
      turn_id: turnId,
      tool_use_id: toolUseId,
      tool_input: publication(),
    }).hookSpecificOutput.updatedInput;

  const original = temporary("side-chat-turn-1", "side-chat-tool-1");
  const anotherToolUse = temporary("side-chat-turn-1", "side-chat-tool-2");
  const anotherSideChat = temporary("side-chat-turn-2", "side-chat-tool-1");

  assert.deepEqual(anotherToolUse, original);
  assert.notEqual(anotherSideChat.sourceSessionKey, original.sourceSessionKey);
  assert.notEqual(anotherSideChat.idempotencyKey, original.idempotencyKey);

  const durable = (toolUseId) =>
    transformCodexPreToolUse({
      tool_name: "mcp__semantic_answer_tree__publish_semantic_answer",
      session_id: "thread-durable",
      turn_id: "turn-durable",
      tool_use_id: toolUseId,
      tool_input: publication(),
    }).hookSpecificOutput.updatedInput;
  const durableFirst = durable("tool-use-1");
  const durableAnotherToolUse = durable("tool-use-2");

  assert.deepEqual(durableAnotherToolUse, durableFirst);
  assert.equal(durableFirst.sourceSessionKey, "codex:thread-durable");
  assert.equal(
    durableFirst.idempotencyKey,
    deterministicCodexIdempotencyKey("thread-durable", "turn-durable"),
  );
  assert.notEqual(durableFirst.sourceSessionKey, original.sourceSessionKey);
});

test("Codex hook treats whitespace identity as absent and never derives from tool-use identity", () => {
  const temporary = transformCodexPreToolUse({
    tool_name: "mcp__semantic_answer_tree__publish_semantic_answer",
    session_id: "   ",
    turn_id: "side-chat-turn",
    tool_use_id: "tool-use-must-not-be-identity",
    tool_input: publication(),
  }).hookSpecificOutput.updatedInput;
  assert.match(temporary.sourceSessionKey, /^codex-temporary:v1:[a-f0-9]{64}$/);

  const unchanged = publication({
    sourceSessionKey: "manual-session",
    sourceTurnKey: "manual-turn",
    idempotencyKey: "manual-idempotency",
  });
  const noTurn = transformCodexPreToolUse({
    tool_name: "mcp__semantic_answer_tree__publish_semantic_answer",
    session_id: "durable-session",
    turn_id: " \t ",
    tool_use_id: "tool-use-must-not-be-identity",
    tool_input: unchanged,
  }).hookSpecificOutput.updatedInput;
  assert.deepEqual(noTurn, unchanged);
});

test("MCP publication rejects missing hook idempotency before transport and never echoes the document", async () => {
  let called = false;
  const client = {
    async publish() {
      called = true;
      return { ok: true };
    },
  };
  const envelope = publication();
  delete envelope.idempotencyKey;
  const result = await executePublishSemanticAnswer(
    envelope,
    client,
    new SessionIdentityProvider({ environment: {} }),
  );
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "missing_idempotency_key");
  assert.equal(called, false);
  assert.doesNotMatch(JSON.stringify(result), /A valid answer/);
});

test("final-surface policy returns exactly one surface", () => {
  assert.equal(finalResponseForPublication(true, "ordinary answer"), VIEWER_SUCCESS_FINAL);
  assert.equal(VIEWER_SUCCESS_FINAL, "Rendered in Semantic Answer Tree.");
  assert.equal(finalResponseForPublication(false, "ordinary answer"), "ordinary answer");
  assert.throws(() => finalResponseForPublication(false, " "), /fallback/i);
});

test("thin MCP client refuses a non-loopback service URL", () => {
  assert.throws(
    () =>
      new SemanticAnswerServiceClient({
        baseUrl: "https://example.com",
        token: "x".repeat(64),
        environment: {},
      }),
    /loopback/i,
  );
});

test("capability tokens reject internal or surrounding whitespace", () => {
  assert.equal(validateCapabilityToken("x".repeat(32)), "x".repeat(32));
  assert.throws(() => validateCapabilityToken(`${"x".repeat(16)} ${"y".repeat(16)}`), /no whitespace/i);
  assert.throws(() => validateCapabilityToken(` ${"x".repeat(32)}`), /no whitespace/i);
  assert.throws(
    () =>
      new SemanticAnswerServiceClient({
        token: `${"x".repeat(16)} ${"y".repeat(16)}`,
        environment: {},
      }),
    /no whitespace/i,
  );
});

test("thin MCP client forbids redirects and rejects a changed response origin", async () => {
  let requestOptions;
  const client = new SemanticAnswerServiceClient({
    token: "z".repeat(64),
    environment: {},
    fetchImpl: async (url, options) => {
      requestOptions = options;
      return { url, ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  assert.deepEqual(await client.request("/health"), { ok: true });
  assert.equal(requestOptions.redirect, "error");

  const changedOrigin = new SemanticAnswerServiceClient({
    token: "z".repeat(64),
    environment: {},
    fetchImpl: async () => ({
      url: "http://localhost:4319/api/publish",
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    }),
  });
  await assert.rejects(
    () => changedOrigin.request("/health"),
    (error) => error.code === "service_origin_mismatch",
  );
});
