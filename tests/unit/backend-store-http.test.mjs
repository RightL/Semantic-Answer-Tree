import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_VIEWER_ORIGINS,
  createSemanticAnswerHttpService,
} from "../../server/http-server.mjs";
import {
  makeTemporaryDirectory,
  publication,
  readSseUntil,
  removeTemporaryDirectory,
  semanticDocument,
} from "./backend-test-helpers.mjs";

const TOKEN = "a".repeat(64);

async function startService(options = {}) {
  const directory = await makeTemporaryDirectory("http-");
  const service = createSemanticAnswerHttpService({
    port: 0,
    dbPath: path.join(directory, "transcript.sqlite3"),
    legacyFilePath: null,
    token: TOKEN,
    ...options,
  });
  const address = await service.start();
  return { directory, service, baseUrl: `http://127.0.0.1:${address.port}` };
}

function authenticatedHeaders(extra = {}) {
  return { Authorization: `Bearer ${TOKEN}`, ...extra };
}

async function publish(baseUrl, envelope = publication(), extra = {}) {
  return fetch(`${baseUrl}/api/publish`, {
    method: "POST",
    headers: authenticatedHeaders({ "Content-Type": "application/json", ...(extra.headers ?? {}) }),
    body: JSON.stringify(envelope),
    ...extra,
  });
}

test("serves session, page, and one-turn query shapes after authenticated publication", async () => {
  const { directory, service, baseUrl } = await startService();
  try {
    assert.deepEqual(await (await fetch(`${baseUrl}/health`)).json(), { ok: true });
    const response = await publish(baseUrl);
    assert.equal(response.status, 200);
    const acknowledgment = await response.json();
    assert.deepEqual(Object.keys(acknowledgment).sort(), ["ok", "sequence", "sessionId", "turnId"]);
    assert.equal(acknowledgment.sequence, 1);
    assert.doesNotMatch(JSON.stringify(acknowledgment), /A valid answer/);

    const sessionsResponse = await fetch(`${baseUrl}/api/sessions`);
    const sessions = (await sessionsResponse.json()).sessions;
    assert.equal(sessions.length, 1);
    assert.deepEqual(Object.keys(sessions[0]).sort(), [
      "archivedAt",
      "createdAt",
      "id",
      "latestSequence",
      "latestTurnId",
      "temporary",
      "title",
      "turnCount",
      "updatedAt",
    ]);
    assert.equal(sessions[0].temporary, false);

    const page = await (
      await fetch(`${baseUrl}/api/sessions/${acknowledgment.sessionId}/turns?limit=20&detail=full`)
    ).json();
    assert.equal(page.turns[0].requestSummary, publication().requestSummary);
    assert.deepEqual(page.turns[0].answer, publication().document);
    assert.equal(page.latestSequence, 1);

    const one = await (
      await fetch(`${baseUrl}/api/turns/${acknowledgment.turnId}?detail=full`)
    ).json();
    assert.equal(one.turn.id, acknowledgment.turnId);
  } finally {
    await service.stop();
    await removeTemporaryDirectory(directory);
  }
});

test("marks only Codex temporary-source sessions as temporary without exposing the source key", async () => {
  const { directory, service, baseUrl } = await startService();
  try {
    await publish(
      baseUrl,
      publication({
        sourceSessionKey: "codex-temporary:v1:turn-123",
        sourceTurnKey: "turn-123",
        idempotencyKey: "idempotency:temporary:turn-123",
      }),
    );
    await publish(
      baseUrl,
      publication({
        sourceSessionKey: "codex-temporary:v2:turn-456",
        sourceTurnKey: "turn-456",
        idempotencyKey: "idempotency:durable:turn-456",
      }),
    );

    const sessions = (await (await fetch(`${baseUrl}/api/sessions`)).json()).sessions;
    assert.equal(sessions.length, 2);
    const temporary = sessions.find((session) => session.temporary);
    const durable = sessions.find((session) => !session.temporary);
    assert.ok(temporary);
    assert.ok(durable);
    assert.doesNotMatch(JSON.stringify(sessions), /sourceSessionKey|source_session_key|turn-123/);

    const historyResponse = await fetch(
      `${baseUrl}/api/history?sourceSessionKey=${encodeURIComponent("codex-temporary:v1:turn-123")}`,
      { headers: authenticatedHeaders() },
    );
    assert.equal(historyResponse.status, 200);
    const history = await historyResponse.json();
    assert.equal(history.session.temporary, true);
    assert.doesNotMatch(JSON.stringify(history.session), /sourceSessionKey|source_session_key|turn-123/);
  } finally {
    await service.stop();
    await removeTemporaryDirectory(directory);
  }
});

test("requires the capability before parsing publication bodies and protects history", async () => {
  const { directory, service, baseUrl } = await startService();
  try {
    const unauthorized = await fetch(`${baseUrl}/api/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "this is intentionally invalid json",
    });
    assert.equal(unauthorized.status, 401);
    assert.equal((await unauthorized.json()).error.code, "unauthorized");

    const wrong = await fetch(`${baseUrl}/api/publish`, {
      method: "POST",
      headers: { Authorization: `Bearer ${"b".repeat(64)}`, "Content-Type": "application/json" },
      body: JSON.stringify(publication()),
    });
    assert.equal(wrong.status, 401);
    assert.deepEqual((await (await fetch(`${baseUrl}/api/sessions`)).json()).sessions, []);

    const history = await fetch(
      `${baseUrl}/api/history?sourceSessionKey=${encodeURIComponent("session:test")}`,
    );
    assert.equal(history.status, 401);
  } finally {
    await service.stop();
    await removeTemporaryDirectory(directory);
  }
});

test("uses exact configurable loopback origins and a narrow preflight", async () => {
  const { directory, service, baseUrl } = await startService();
  try {
    const allowed = await fetch(`${baseUrl}/health`, {
      headers: { Origin: DEFAULT_VIEWER_ORIGINS[0] },
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("access-control-allow-origin"), DEFAULT_VIEWER_ORIGINS[0]);

    const wrongPort = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "http://localhost:3000" },
    });
    assert.equal(wrongPort.status, 403);

    const remote = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "https://example.com" },
    });
    assert.equal(remote.status, 403);

    const preflight = await fetch(`${baseUrl}/api/publish`, {
      method: "OPTIONS",
      headers: { Origin: DEFAULT_VIEWER_ORIGINS[1] },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-headers"), "Authorization, Content-Type");
  } finally {
    await service.stop();
    await removeTemporaryDirectory(directory);
  }
});

test("rejects invalid and oversized publications without echoing answer content", async () => {
  const { directory, service, baseUrl } = await startService({ maxBodyBytes: 400 });
  try {
    const secret = "PRIVATE-ANSWER-CONTENT-MUST-NOT-BE-ECHOED";
    const privateKeyCanary = "PRIVATE_UNKNOWN_FIELD_NAME_CANARY";
    const invalid = await publish(
      baseUrl,
      publication({
        document: {
          version: 1,
          title: "Invalid",
          root: { content: secret, [privateKeyCanary]: true },
        },
        [privateKeyCanary]: true,
      }),
    );
    assert.equal(invalid.status, 400);
    const responseText = await invalid.text();
    assert.doesNotMatch(responseText, new RegExp(secret));
    assert.doesNotMatch(responseText, new RegExp(privateKeyCanary));
    assert.equal(JSON.parse(responseText).error.code, "invalid_publish_envelope");

    const oversized = await publish(
      baseUrl,
      publication({ document: semanticDocument("x".repeat(1_000)) }),
    );
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).error.code, "body_too_large");
    assert.deepEqual((await (await fetch(`${baseUrl}/api/sessions`)).json()).sessions, []);
  } finally {
    await service.stop();
    await removeTemporaryDirectory(directory);
  }
});

test("SSE emits committed identifiers only and replays persisted events after Last-Event-ID", async () => {
  const { directory, service, baseUrl } = await startService();
  const firstController = new AbortController();
  const secondController = new AbortController();
  try {
    const firstStream = await fetch(`${baseUrl}/events`, { signal: firstController.signal });
    const firstReader = firstStream.body.getReader();
    await readSseUntil(firstReader, (text) => text.includes("event: ready"));

    const firstAck = await (await publish(baseUrl)).json();
    const firstEvent = await readSseUntil(firstReader, (text) => text.includes("event: turn-published"));
    assert.match(firstEvent, /event: turn-published/);
    assert.doesNotMatch(firstEvent, /A valid answer|Test the transcript backend/);
    const eventId = firstEvent.match(/id: ([^\n]+)/)?.[1];
    assert.ok(eventId);
    const payload = JSON.parse(firstEvent.match(/data: (\{[^\n]+\})/)?.[1]);
    assert.deepEqual(Object.keys(payload).sort(), ["eventId", "sequence", "sessionId", "turnId"]);
    assert.equal(payload.turnId, firstAck.turnId);
    await firstReader.cancel();

    const secondAck = await (
      await publish(
        baseUrl,
        publication({
          sourceTurnKey: "turn:2",
          idempotencyKey: "idempotency:test:2",
          document: semanticDocument("Second committed answer"),
        }),
      )
    ).json();

    const replayStream = await fetch(`${baseUrl}/events`, {
      signal: secondController.signal,
      headers: { "Last-Event-ID": eventId },
    });
    const replayReader = replayStream.body.getReader();
    const replay = await readSseUntil(
      replayReader,
      (text) => text.includes(secondAck.turnId),
    );
    assert.match(replay, new RegExp(secondAck.turnId));
    assert.doesNotMatch(replay, /Second committed answer/);
    await replayReader.cancel();
  } finally {
    firstController.abort();
    secondController.abort();
    await service.stop();
    await removeTemporaryDirectory(directory);
  }
});

test("creates and reuses a random token file beside the database", async () => {
  const directory = await makeTemporaryDirectory("token-");
  const dbPath = path.join(directory, "transcript.sqlite3");
  let service = createSemanticAnswerHttpService({ port: 0, dbPath, legacyFilePath: null });
  const firstToken = service.token;
  const tokenFilePath = service.tokenFilePath;
  try {
    assert.match(firstToken, /^[a-f0-9]{64}$/);
    assert.equal(path.dirname(tokenFilePath), directory);
    const metadata = await stat(tokenFilePath);
    if (process.platform !== "win32") {
      assert.equal(metadata.mode & 0o077, 0);
    }
    await service.stop();
    service = createSemanticAnswerHttpService({ port: 0, dbPath, legacyFilePath: null });
    assert.equal(service.token, firstToken);
  } finally {
    await service.stop();
    await removeTemporaryDirectory(directory);
  }
});
