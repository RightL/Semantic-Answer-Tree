import assert from "node:assert/strict";
import test from "node:test";

import {
  VIEWER_SUCCESS_FINAL,
  finalResponseForPublication,
} from "../../server/final-surface-policy.mjs";
import {
  SemanticAnswerServiceClient,
  executePublishSemanticAnswer,
  executeReadSemanticHistory,
} from "../../server/publisher.mjs";
import { validateCapabilityToken } from "../../server/capability-token.mjs";
import { semanticDocument } from "./backend-test-helpers.mjs";

test("MCP publication requires the agent's fixed sessionId and owns idempotency", async () => {
  let received;
  const client = {
    async publish(envelope) {
      received = envelope;
      return { ok: true, sessionId: envelope.sessionId, turnId: "turn-1", sequence: 1 };
    },
  };
  const input = {
    sessionId: "sa-session-123",
    requestSummary: "Test the fixed session convention",
    document: semanticDocument(),
  };

  const result = await executePublishSemanticAnswer(input, client);

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.sessionId, input.sessionId);
  assert.equal(received.sessionId, input.sessionId);
  assert.match(received.idempotencyKey, /^[0-9a-f-]{36}$/i);
  assert.equal(Object.hasOwn(received, "sourceTurnKey"), false);
  assert.equal(Object.hasOwn(input, "idempotencyKey"), false);
});

test("MCP publication rejects missing sessionId and obsolete identity fields before transport", async () => {
  let calls = 0;
  const client = { async publish() { calls += 1; } };
  const base = {
    requestSummary: "Test invalid identity",
    document: semanticDocument("Do not echo this body"),
  };

  const missing = await executePublishSemanticAnswer(base, client);
  const obsolete = await executePublishSemanticAnswer(
    { ...base, sessionId: "sa-current", sourceTurnKey: "obsolete" },
    client,
  );

  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent.error.code, "invalid_tool_input");
  assert.equal(obsolete.isError, true);
  assert.equal(obsolete.structuredContent.error.code, "invalid_tool_input");
  assert.equal(calls, 0);
  assert.doesNotMatch(JSON.stringify(missing), /Do not echo this body/);
});

test("MCP history uses the same explicit sessionId", async () => {
  let received;
  const client = {
    async readHistory(input) {
      received = input;
      return { session: { id: input.sessionId }, turns: [] };
    },
  };

  const result = await executeReadSemanticHistory(
    { sessionId: "sa-session-123", limit: 3 },
    client,
  );
  const missing = await executeReadSemanticHistory({ limit: 3 }, client);

  assert.deepEqual(received, { sessionId: "sa-session-123", limit: 3 });
  assert.equal(result.structuredContent.session.id, "sa-session-123");
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent.error.code, "invalid_tool_input");
});

test("final-surface policy returns exactly one surface", () => {
  assert.equal(finalResponseForPublication(true, "ordinary answer"), VIEWER_SUCCESS_FINAL);
  assert.equal(VIEWER_SUCCESS_FINAL, "Rendered in Semantic Answer.");
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
