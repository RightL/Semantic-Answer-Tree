import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  SemanticTranscriptConflictError,
  SemanticTranscriptStore,
} from "../../server/store.mjs";
import {
  makeTemporaryDirectory,
  publication,
  removeTemporaryDirectory,
  semanticDocument,
} from "./backend-test-helpers.mjs";

test("separates interleaved sessions and preserves monotonic append order across reload", async () => {
  const directory = await makeTemporaryDirectory("sessions-");
  const dbPath = path.join(directory, "transcript.sqlite3");
  let store = new SemanticTranscriptStore({ dbPath });
  try {
    assert.equal(store.journalMode(), "wal");
    assert.equal(store.schemaVersion(), 2);

    const a1 = store.publish(publication());
    const b1 = store.publish(
      publication({
        sourceSessionKey: "session:other",
        sourceTurnKey: "turn:b1",
        idempotencyKey: "idem:b1",
        document: semanticDocument("Other session", "Other"),
      }),
    );
    const a2 = store.publish(
      publication({
        sourceTurnKey: "turn:2",
        idempotencyKey: "idempotency:test:2",
        document: semanticDocument("Second A"),
      }),
    );

    assert.equal(a1.sequence, 1);
    assert.equal(b1.sequence, 1);
    assert.equal(a2.sequence, 2);
    assert.equal(a1.sessionId, a2.sessionId);
    assert.notEqual(a1.sessionId, b1.sessionId);
    store.close();

    store = new SemanticTranscriptStore({ dbPath });
    const sessions = store.listSessions();
    assert.equal(sessions.length, 2);
    assert.equal(sessions.find((session) => session.id === a1.sessionId).turnCount, 2);
    assert.deepEqual(
      store.getTurnsPage(a1.sessionId).turns.map((turn) => turn.sequence),
      [1, 2],
    );
  } finally {
    store.close();
    await removeTemporaryDirectory(directory);
  }
});

test("identical retries return the exact acknowledgment without another turn or event", async () => {
  const directory = await makeTemporaryDirectory("idempotency-");
  const store = new SemanticTranscriptStore({
    dbPath: path.join(directory, "transcript.sqlite3"),
  });
  const events = [];
  store.onTurnPublished((event) => events.push(event));
  try {
    const envelope = publication();
    const first = store.publish(envelope);
    const retryWithDifferentObjectOrder = store.publish({
      document: envelope.document,
      idempotencyKey: envelope.idempotencyKey,
      requestSummary: envelope.requestSummary,
      sourceTurnKey: envelope.sourceTurnKey,
      sourceSessionKey: envelope.sourceSessionKey,
    });
    assert.deepEqual(retryWithDifferentObjectOrder, first);
    assert.equal(store.listSessions()[0].turnCount, 1);
    assert.equal(events.length, 1);

    assert.throws(
      () =>
        store.publish({
          ...envelope,
          document: semanticDocument("Different payload"),
        }),
      (error) =>
        error instanceof SemanticTranscriptConflictError && error.code === "idempotency_conflict",
    );
    assert.throws(
      () =>
        store.publish({
          ...envelope,
          idempotencyKey: "different-idempotency-key",
        }),
      (error) =>
        error instanceof SemanticTranscriptConflictError && error.code === "source_turn_conflict",
    );
    assert.equal(store.listSessions()[0].turnCount, 1);
    assert.equal(events.length, 1);
  } finally {
    store.close();
    await removeTemporaryDirectory(directory);
  }
});

test("rolls back failed appends and emits only after the committed turn is queryable", async () => {
  const directory = await makeTemporaryDirectory("rollback-");
  let shouldFail = true;
  const store = new SemanticTranscriptStore({
    dbPath: path.join(directory, "transcript.sqlite3"),
    beforeCommit() {
      if (shouldFail) throw new Error("injected failure");
    },
  });
  const observed = [];
  store.onTurnPublished((event) => observed.push(store.getTurn(event.turnId)));
  try {
    assert.throws(() => store.publish(publication()), /injected failure/);
    assert.deepEqual(store.listSessions(), []);
    assert.deepEqual(observed, []);

    shouldFail = false;
    const acknowledgment = store.publish(publication());
    assert.equal(observed.length, 1);
    assert.equal(observed[0].id, acknowledgment.turnId);
  } finally {
    store.close();
    await removeTemporaryDirectory(directory);
  }
});

test("database triggers enforce turn immutability", async () => {
  const directory = await makeTemporaryDirectory("immutable-");
  const dbPath = path.join(directory, "transcript.sqlite3");
  const store = new SemanticTranscriptStore({ dbPath });
  let inspector;
  try {
    const acknowledgment = store.publish(publication());
    inspector = new DatabaseSync(dbPath);
    assert.throws(
      () => inspector.prepare("UPDATE turns SET request_summary = 'changed' WHERE id = ?").run(acknowledgment.turnId),
      /turns_are_immutable/,
    );
    assert.throws(
      () => inspector.prepare("DELETE FROM turns WHERE id = ?").run(acknowledgment.turnId),
      /turns_are_immutable/,
    );
    assert.equal(store.getTurn(acknowledgment.turnId).requestSummary, publication().requestSummary);
  } finally {
    inspector?.close();
    store.close();
    await removeTemporaryDirectory(directory);
  }
});

test("paginates older and newer turns chronologically with honest boundaries", async () => {
  const directory = await makeTemporaryDirectory("pagination-");
  const store = new SemanticTranscriptStore({
    dbPath: path.join(directory, "transcript.sqlite3"),
  });
  try {
    let sessionId;
    for (let index = 1; index <= 7; index += 1) {
      const acknowledgment = store.publish(
        publication({
          sourceTurnKey: `turn:${index}`,
          idempotencyKey: `idem:${index}`,
          requestSummary: `Request ${index}`,
          document: semanticDocument(`Answer ${index}`),
        }),
      );
      sessionId = acknowledgment.sessionId;
    }

    const latest = store.getTurnsPage(sessionId, { limit: 3 });
    assert.deepEqual(latest.turns.map((turn) => turn.sequence), [5, 6, 7]);
    assert.equal(latest.hasOlder, true);
    assert.equal(latest.hasNewer, false);
    assert.equal(latest.latestSequence, 7);

    const older = store.getTurnsPage(sessionId, { beforeSequence: 5, limit: 3 });
    assert.deepEqual(older.turns.map((turn) => turn.sequence), [2, 3, 4]);
    assert.equal(older.hasOlder, true);
    assert.equal(older.hasNewer, true);

    const newer = store.getTurnsPage(sessionId, { afterSequence: 3, limit: 2 });
    assert.deepEqual(newer.turns.map((turn) => turn.sequence), [4, 5]);
    assert.equal(newer.hasOlder, true);
    assert.equal(newer.hasNewer, true);
  } finally {
    store.close();
    await removeTemporaryDirectory(directory);
  }
});

test("history omits expansion content while one-turn lookup returns the exact immutable document", async () => {
  const directory = await makeTemporaryDirectory("history-");
  const store = new SemanticTranscriptStore({
    dbPath: path.join(directory, "transcript.sqlite3"),
  });
  try {
    const document = {
      version: 1,
      title: "Linear answer",
      body: "The answer is complete. [Define this](zoom:definition)",
      expansions: {
        definition: {
          kind: "definition",
          content: "Turn-local private expansion content.",
        },
      },
    };
    const acknowledgment = store.publish(publication({ document }));
    const history = store.readHistory("session:test");
    assert.equal(Object.hasOwn(history, "detail"), false);
    assert.deepEqual(history.turns[0].answer, {
      version: 1,
      title: document.title,
      body: document.body,
    });
    assert.deepEqual(store.getTurn(acknowledgment.turnId).answer, document);
  } finally {
    store.close();
    await removeTemporaryDirectory(directory);
  }
});

test("identical expansion IDs remain scoped to their immutable turn", async () => {
  const directory = await makeTemporaryDirectory("expansion-scope-");
  const store = new SemanticTranscriptStore({
    dbPath: path.join(directory, "transcript.sqlite3"),
  });
  try {
    const answer = (title, content) => ({
      version: 1,
      title,
      body: "Read [this](zoom:shared).",
      expansions: { shared: { kind: "definition", content } },
    });
    const first = store.publish(
      publication({ document: answer("First scope", "Definition in the first turn.") }),
    );
    const second = store.publish(
      publication({
        sourceTurnKey: "turn:2",
        idempotencyKey: "idempotency:test:2",
        document: answer("Second scope", "Definition in the second turn."),
      }),
    );

    assert.equal(
      store.getTurn(first.turnId).answer.expansions.shared.content,
      "Definition in the first turn.",
    );
    assert.equal(
      store.getTurn(second.turnId).answer.expansions.shared.content,
      "Definition in the second turn.",
    );
  } finally {
    store.close();
    await removeTemporaryDirectory(directory);
  }
});
