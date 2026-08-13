import assert from "node:assert/strict";
import test from "node:test";

import {
  SemanticAnswerServiceClient,
  executePublishSemanticAnswer,
} from "../../server/publisher.mjs";
import { publication } from "./backend-test-helpers.mjs";

const ACKNOWLEDGMENT = {
  ok: true,
  sessionId: "session-1",
  turnId: "turn-1",
  sequence: 1,
};

function response(body, { ok = true, status = 200 } = {}) {
  return {
    url: "http://127.0.0.1:4318/api/publish",
    ok,
    status,
    json: async () => body,
  };
}

test("publication retries one ambiguous delivery with the identical envelope", async () => {
  const requests = [];
  const client = new SemanticAnswerServiceClient({
    token: "r".repeat(64),
    environment: {},
    fetchImpl: async (_url, options) => {
      requests.push(options.body);
      if (requests.length === 1) throw new TypeError("connection closed before acknowledgement");
      return response(ACKNOWLEDGMENT);
    },
  });
  const envelope = publication();

  assert.deepEqual(await client.publish(envelope), ACKNOWLEDGMENT);
  assert.equal(requests.length, 2);
  assert.equal(requests[1], requests[0]);
  assert.equal(requests[0], JSON.stringify(envelope));
});

test("publication retries a malformed success acknowledgement once", async () => {
  let calls = 0;
  const client = new SemanticAnswerServiceClient({
    token: "r".repeat(64),
    environment: {},
    fetchImpl: async () => {
      calls += 1;
      return response(calls === 1 ? { ok: true } : ACKNOWLEDGMENT);
    },
  });

  assert.deepEqual(await client.publish(publication()), ACKNOWLEDGMENT);
  assert.equal(calls, 2);
});

test("definitive validation rejection is returned without an automatic retry", async () => {
  let calls = 0;
  const client = new SemanticAnswerServiceClient({
    token: "r".repeat(64),
    environment: {},
    fetchImpl: async () => {
      calls += 1;
      return response(
        {
          ok: false,
          error: {
            code: "invalid_publish_envelope",
            message: "The publication envelope is invalid.",
            issues: [{ path: "$.document.body", message: "Must not be empty." }],
          },
        },
        { ok: false, status: 400 },
      );
    },
  });

  await assert.rejects(
    () => client.publish(publication()),
    (error) => error.code === "invalid_publish_envelope" && error.status === 400,
  );
  assert.equal(calls, 1);
});

test("an unconfirmed acknowledgement becomes a safe tool failure", async () => {
  let calls = 0;
  const client = new SemanticAnswerServiceClient({
    token: "r".repeat(64),
    environment: {},
    fetchImpl: async () => {
      calls += 1;
      return response({ ok: true, sessionId: "session-1" });
    },
  });
  const envelope = publication();
  const result = await executePublishSemanticAnswer(
    {
      sessionId: envelope.sessionId,
      requestSummary: envelope.requestSummary,
      document: envelope.document,
    },
    client,
  );

  assert.equal(calls, 2);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "invalid_publish_acknowledgement");
  assert.doesNotMatch(JSON.stringify(result), /A valid answer/);
});

test("each ambiguous publication attempt has a fresh bounded deadline", async () => {
  let calls = 0;
  const signals = [];
  const client = new SemanticAnswerServiceClient({
    token: "r".repeat(64),
    environment: {},
    requestTimeoutMs: 20,
    fetchImpl: async (_url, options) => {
      calls += 1;
      signals.push(options.signal);
      return new Promise((_, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    },
  });

  await assert.rejects(
    () => client.publish(publication()),
    (error) => error.code === "service_unavailable",
  );
  assert.equal(calls, 2);
  assert.notEqual(signals[0], signals[1]);
  assert.equal(signals.every((signal) => signal.aborted), true);
});
