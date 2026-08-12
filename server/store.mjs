import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  SemanticAnswerValidationError,
  assertPublicationEnvelope,
  assertSemanticAnswer,
  extractTermReferences,
} from "./validation.mjs";
import { isTemporarySourceSessionKey } from "./identity-namespaces.mjs";

export const SEMANTIC_ANSWER_DB_ENV = "SEMANTIC_ANSWER_DB";
export const SEMANTIC_ANSWER_LEGACY_FILE_ENV = "SEMANTIC_ANSWER_LEGACY_FILE";
export const DEFAULT_DATABASE_PATH = path.join(
  ".semantic-answer",
  "semantic-transcript.sqlite3",
);

const DEFAULT_MIGRATIONS_DIRECTORY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "migrations",
);
const LEGACY_SOURCE_SESSION_KEY = "legacy-import:previous-single-document-viewer";
const LEGACY_REQUEST_SUMMARY = "Imported answer from the previous single-document viewer";
const LEGACY_SESSION_TITLE = "Imported · Previous single-document viewer";

export function resolveDatabasePath(environment = process.env, cwd = process.cwd()) {
  return path.resolve(cwd, environment[SEMANTIC_ANSWER_DB_ENV] || DEFAULT_DATABASE_PATH);
}

export function resolveLegacyFilePath(environment = process.env, cwd = process.cwd()) {
  const configuredPath = environment[SEMANTIC_ANSWER_LEGACY_FILE_ENV];
  if (typeof configuredPath !== "string" || configuredPath.trim() === "") {
    return null;
  }
  return path.resolve(cwd, configuredPath);
}

export class SemanticTranscriptError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "SemanticTranscriptError";
    this.code = code;
    this.statusCode = options.statusCode ?? 500;
  }
}

export class SemanticTranscriptConflictError extends SemanticTranscriptError {
  constructor(code, message) {
    super(code, message, { statusCode: 409 });
    this.name = "SemanticTranscriptConflictError";
  }
}

export class SemanticTranscriptNotFoundError extends SemanticTranscriptError {
  constructor(code, message) {
    super(code, message, { statusCode: 404 });
    this.name = "SemanticTranscriptNotFoundError";
  }
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deterministic JSON for hashes; arrays retain order and object keys do not. */
export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function mapSession(row) {
  return {
    id: row.id,
    title: row.title,
    temporary: isTemporarySourceSessionKey(row.source_session_key),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? null,
    latestSequence: Number(row.latest_sequence ?? 0),
    latestTurnId: row.latest_turn_id ?? null,
    turnCount: Number(row.turn_count ?? 0),
  };
}

function mapFullTurn(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    sequence: Number(row.sequence),
    createdAt: row.created_at,
    requestSummary: row.request_summary,
    answer: JSON.parse(row.answer_json),
  };
}

function compactNode(node, depth) {
  const result = {
    content: node.content,
    childCount: Array.isArray(node.children) ? node.children.length : 0,
  };
  if (depth > 0 && Array.isArray(node.children) && node.children.length > 0) {
    result.children = node.children.map((child) => compactNode(child, depth - 1));
  }
  return result;
}

function compactTerms(answer, root) {
  const referenced = new Set();
  const visit = (node) => {
    for (const termId of extractTermReferences(node.content)) {
      referenced.add(termId);
    }
    for (const child of node.children ?? []) {
      visit(child);
    }
  };
  visit(root);
  return Object.fromEntries(
    [...referenced]
      .filter((termId) => Object.prototype.hasOwnProperty.call(answer.terms ?? {}, termId))
      .map((termId) => [termId, answer.terms[termId]]),
  );
}

function mapCompactTurn(row, detail) {
  const answer = JSON.parse(row.answer_json);
  const root = compactNode(answer.root, detail === "frontier" ? 1 : 0);
  return {
    id: row.id,
    sessionId: row.session_id,
    sequence: Number(row.sequence),
    createdAt: row.created_at,
    requestSummary: row.request_summary,
    answer: {
      version: 1,
      title: answer.title,
      root,
      terms: compactTerms(answer, root),
    },
  };
}

function clampLimit(value, fallback = 20, maximum = 100) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new SemanticTranscriptError(
      "invalid_query",
      `limit must be an integer from 1 through ${maximum}.`,
      { statusCode: 400 },
    );
  }
  return parsed;
}

function optionalSequence(value, name) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new SemanticTranscriptError("invalid_query", `${name} must be a positive integer.`, {
      statusCode: 400,
    });
  }
  return parsed;
}

export class SemanticTranscriptStore {
  #database;
  #listeners = new Set();
  #closed = false;
  #clock;
  #beforeCommit;

  constructor(options = {}) {
    if (typeof options === "string") {
      options = { dbPath: options };
    }
    const configuredDatabase = options.dbPath ?? resolveDatabasePath(options.environment, options.cwd);
    this.dbPath = configuredDatabase === ":memory:" ? ":memory:" : path.resolve(configuredDatabase);
    const configuredLegacyFilePath =
      options.legacyFilePath === undefined
        ? resolveLegacyFilePath(options.environment, options.cwd)
        : options.legacyFilePath;
    this.legacyFilePath =
      configuredLegacyFilePath === null ||
      configuredLegacyFilePath === false ||
      configuredLegacyFilePath === ""
        ? null
        : path.resolve(options.cwd ?? process.cwd(), configuredLegacyFilePath);
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#beforeCommit = options.beforeCommit;

    if (this.dbPath !== ":memory:") {
      mkdirSync(path.dirname(this.dbPath), { recursive: true });
    }
    this.#database = new DatabaseSync(this.dbPath);
    this.#database.exec("PRAGMA foreign_keys = ON;");
    this.#database.exec("PRAGMA busy_timeout = 5000;");
    this.#database.exec("PRAGMA journal_mode = WAL;");
    this.#database.exec("PRAGMA synchronous = FULL;");
    this.#applyMigrations(options.migrationsDirectory ?? DEFAULT_MIGRATIONS_DIRECTORY);
    this.legacyImport = this.#importLegacyIfPresent();
  }

  #assertOpen() {
    if (this.#closed) {
      throw new SemanticTranscriptError("store_closed", "The transcript store is closed.");
    }
  }

  #applyMigrations(directory) {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const files = readdirSync(directory)
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort((left, right) => left.localeCompare(right));
    const applied = this.#database.prepare(
      "SELECT 1 FROM schema_migrations WHERE version = ?",
    );
    const record = this.#database.prepare(
      "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
    );

    for (const file of files) {
      const version = Number(file.slice(0, file.indexOf("_")));
      if (applied.get(version)) {
        continue;
      }
      const sql = readFileSync(path.join(directory, file), "utf8");
      this.#database.exec("BEGIN IMMEDIATE;");
      try {
        this.#database.exec(sql);
        record.run(version, file, this.#clock());
        this.#database.exec("COMMIT;");
      } catch (error) {
        this.#database.exec("ROLLBACK;");
        throw new SemanticTranscriptError("migration_failed", `Database migration ${file} failed.`, {
          cause: error,
        });
      }
    }
  }

  #importLegacyIfPresent() {
    if (!this.legacyFilePath || !existsSync(this.legacyFilePath)) {
      return { status: "missing" };
    }
    const absolutePath = path.resolve(this.legacyFilePath);
    const existing = this.#database
      .prepare("SELECT session_id, turn_id FROM legacy_imports WHERE source_path = ?")
      .get(absolutePath);
    if (existing) {
      return { status: "already-imported", sessionId: existing.session_id, turnId: existing.turn_id };
    }

    let bytes;
    let document;
    try {
      bytes = readFileSync(absolutePath);
      document = assertSemanticAnswer(JSON.parse(bytes.toString("utf8")));
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof SemanticAnswerValidationError) {
        return { status: "invalid", code: "invalid_legacy_answer" };
      }
      throw error;
    }

    const contentHash = sha256(bytes);
    const answerJson = canonicalJson(document);
    const answerHash = sha256(answerJson);
    const idempotencyKey = `legacy:${contentHash}`;
    const now = this.#clock();
    let sessionId;
    let turnId;

    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const marker = this.#database
        .prepare("SELECT session_id, turn_id FROM legacy_imports WHERE source_path = ?")
        .get(absolutePath);
      if (marker) {
        this.#database.exec("COMMIT;");
        return { status: "already-imported", sessionId: marker.session_id, turnId: marker.turn_id };
      }

      let session = this.#database
        .prepare("SELECT id FROM sessions WHERE source_session_key = ?")
        .get(LEGACY_SOURCE_SESSION_KEY);
      if (!session) {
        sessionId = randomUUID();
        this.#database
          .prepare(
            "INSERT INTO sessions(id, source_session_key, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(sessionId, LEGACY_SOURCE_SESSION_KEY, LEGACY_SESSION_TITLE, now, now);
      } else {
        sessionId = session.id;
      }

      const importedTurn = this.#database
        .prepare("SELECT id FROM turns WHERE session_id = ? AND idempotency_key = ?")
        .get(sessionId, idempotencyKey);
      if (importedTurn) {
        turnId = importedTurn.id;
      } else {
        const latest = this.#database
          .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM turns WHERE session_id = ?")
          .get(sessionId);
        const sequence = Number(latest.sequence) + 1;
        turnId = randomUUID();
        const publicationHash = sha256(
          canonicalJson({
            sourceSessionKey: LEGACY_SOURCE_SESSION_KEY,
            sourceTurnKey: `legacy:${contentHash}`,
            requestSummary: LEGACY_REQUEST_SUMMARY,
            document,
            idempotencyKey,
          }),
        );
        this.#database
          .prepare(`
            INSERT INTO turns(
              id, session_id, sequence, source_turn_key, request_summary, answer_json,
              answer_hash, idempotency_key, publication_hash, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            turnId,
            sessionId,
            sequence,
            `legacy:${contentHash}`,
            LEGACY_REQUEST_SUMMARY,
            answerJson,
            answerHash,
            idempotencyKey,
            publicationHash,
            now,
          );
      }
      this.#database
        .prepare(
          "INSERT INTO legacy_imports(source_path, content_hash, session_id, turn_id, imported_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(absolutePath, contentHash, sessionId, turnId, now);
      this.#database.exec("COMMIT;");
      return { status: "imported", sessionId, turnId };
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw new SemanticTranscriptError("legacy_import_failed", "Legacy answer import failed.", {
        cause: error,
      });
    }
  }

  onTurnPublished(listener) {
    this.#assertOpen();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notifyCommitted(event) {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A notification consumer cannot undo or misreport a durable commit.
      }
    }
  }

  publish(envelopeValue) {
    this.#assertOpen();
    const envelope = assertPublicationEnvelope(envelopeValue);
    const answerJson = canonicalJson(envelope.document);
    const answerHash = sha256(answerJson);
    const publicationHash = sha256(canonicalJson(envelope));
    const now = this.#clock();
    let committedEvent;
    let acknowledgment;

    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      let session = this.#database
        .prepare("SELECT id FROM sessions WHERE source_session_key = ?")
        .get(envelope.sourceSessionKey);
      if (!session) {
        const sessionId = randomUUID();
        const title = (envelope.document.title.trim() || envelope.requestSummary.trim()).slice(0, 240);
        this.#database
          .prepare(
            "INSERT INTO sessions(id, source_session_key, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(sessionId, envelope.sourceSessionKey, title, now, now);
        session = { id: sessionId };
      }

      const existing = this.#database
        .prepare(
          "SELECT id, sequence, publication_hash FROM turns WHERE session_id = ? AND idempotency_key = ?",
        )
        .get(session.id, envelope.idempotencyKey);
      if (existing) {
        if (existing.publication_hash !== publicationHash) {
          throw new SemanticTranscriptConflictError(
            "idempotency_conflict",
            "The idempotency key is already bound to a different publication.",
          );
        }
        acknowledgment = {
          ok: true,
          sessionId: session.id,
          turnId: existing.id,
          sequence: Number(existing.sequence),
        };
        this.#database.exec("COMMIT;");
        return acknowledgment;
      }

      if (envelope.sourceTurnKey !== undefined) {
        const sourceTurn = this.#database
          .prepare("SELECT id FROM turns WHERE session_id = ? AND source_turn_key = ?")
          .get(session.id, envelope.sourceTurnKey);
        if (sourceTurn) {
          throw new SemanticTranscriptConflictError(
            "source_turn_conflict",
            "The source turn key is already bound to another immutable publication.",
          );
        }
      }

      const latest = this.#database
        .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM turns WHERE session_id = ?")
        .get(session.id);
      const sequence = Number(latest.sequence) + 1;
      const turnId = randomUUID();
      const eventId = randomUUID();
      this.#database
        .prepare(`
          INSERT INTO turns(
            id, session_id, sequence, source_turn_key, request_summary, answer_json,
            answer_hash, idempotency_key, publication_hash, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          turnId,
          session.id,
          sequence,
          envelope.sourceTurnKey ?? null,
          envelope.requestSummary,
          answerJson,
          answerHash,
          envelope.idempotencyKey,
          publicationHash,
          now,
        );
      this.#database
        .prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
        .run(now, session.id);
      this.#database
        .prepare(
          "INSERT INTO event_log(event_id, session_id, turn_id, sequence, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(eventId, session.id, turnId, sequence, now);

      this.#beforeCommit?.({ sessionId: session.id, turnId, sequence });
      this.#database.exec("COMMIT;");
      acknowledgment = { ok: true, sessionId: session.id, turnId, sequence };
      committedEvent = {
        eventId,
        sessionId: session.id,
        turnId,
        sequence,
      };
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK;");
      } catch {
        // The transaction may already have ended; preserve the original error.
      }
      throw error;
    }

    this.#notifyCommitted(committedEvent);
    return acknowledgment;
  }

  listSessions() {
    this.#assertOpen();
    return this.#database
      .prepare(`
        SELECT
          s.id, s.source_session_key, s.title, s.created_at, s.updated_at, s.archived_at,
          COUNT(t.id) AS turn_count,
          COALESCE(MAX(t.sequence), 0) AS latest_sequence,
          (
            SELECT newest.id FROM turns newest
            WHERE newest.session_id = s.id
            ORDER BY newest.sequence DESC LIMIT 1
          ) AS latest_turn_id
        FROM sessions s
        LEFT JOIN turns t ON t.session_id = s.id
        GROUP BY s.id
        ORDER BY s.updated_at DESC, s.id DESC
      `)
      .all()
      .map(mapSession);
  }

  getTurnsPage(sessionId, options = {}) {
    this.#assertOpen();
    const beforeSequence = optionalSequence(options.beforeSequence, "beforeSequence");
    const afterSequence = optionalSequence(options.afterSequence, "afterSequence");
    if (beforeSequence !== undefined && afterSequence !== undefined) {
      throw new SemanticTranscriptError(
        "invalid_query",
        "beforeSequence and afterSequence cannot be combined.",
        { statusCode: 400 },
      );
    }
    const limit = clampLimit(options.limit);
    const session = this.#database
      .prepare("SELECT id FROM sessions WHERE id = ?")
      .get(sessionId);
    if (!session) {
      throw new SemanticTranscriptNotFoundError("session_not_found", "Session not found.");
    }
    const bounds = this.#database
      .prepare(
        "SELECT MIN(sequence) AS minimum, MAX(sequence) AS maximum FROM turns WHERE session_id = ?",
      )
      .get(sessionId);

    let rows;
    if (beforeSequence !== undefined) {
      rows = this.#database
        .prepare(
          "SELECT * FROM turns WHERE session_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT ?",
        )
        .all(sessionId, beforeSequence, limit)
        .reverse();
    } else if (afterSequence !== undefined) {
      rows = this.#database
        .prepare(
          "SELECT * FROM turns WHERE session_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?",
        )
        .all(sessionId, afterSequence, limit);
    } else {
      rows = this.#database
        .prepare("SELECT * FROM turns WHERE session_id = ? ORDER BY sequence DESC LIMIT ?")
        .all(sessionId, limit)
        .reverse();
    }

    const turns = rows.map(mapFullTurn);
    const pageMinimum = turns[0]?.sequence;
    const pageMaximum = turns.at(-1)?.sequence;
    const databaseMinimum = bounds.minimum === null ? null : Number(bounds.minimum);
    const databaseMaximum = bounds.maximum === null ? 0 : Number(bounds.maximum);
    return {
      sessionId,
      turns,
      hasOlder: pageMinimum !== undefined && databaseMinimum !== null && pageMinimum > databaseMinimum,
      hasNewer: pageMaximum !== undefined && pageMaximum < databaseMaximum,
      oldestSequence: pageMinimum ?? null,
      latestSequence: databaseMaximum,
    };
  }

  getTurn(turnId) {
    this.#assertOpen();
    const row = this.#database.prepare("SELECT * FROM turns WHERE id = ?").get(turnId);
    if (!row) {
      throw new SemanticTranscriptNotFoundError("turn_not_found", "Turn not found.");
    }
    return mapFullTurn(row);
  }

  readHistory(sourceSessionKey, options = {}) {
    this.#assertOpen();
    const detail = options.detail ?? "roots";
    if (detail !== "roots" && detail !== "frontier") {
      throw new SemanticTranscriptError(
        "invalid_query",
        "detail must be roots or frontier for history reads.",
        { statusCode: 400 },
      );
    }
    const beforeSequence = optionalSequence(options.beforeSequence, "beforeSequence");
    const limit = clampLimit(options.limit, 10, 50);
    const session = this.#database
      .prepare("SELECT id, source_session_key, title, created_at, updated_at, archived_at FROM sessions WHERE source_session_key = ?")
      .get(sourceSessionKey);
    if (!session) {
      throw new SemanticTranscriptNotFoundError("session_not_found", "Session not found.");
    }
    const page = this.getTurnsPage(session.id, { beforeSequence, limit });
    const ids = page.turns.map((turn) => turn.id);
    let turns = [];
    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(",");
      turns = this.#database
        .prepare(`SELECT * FROM turns WHERE id IN (${placeholders}) ORDER BY sequence ASC`)
        .all(...ids)
        .map((row) => mapCompactTurn(row, detail));
    }
    return {
      session: {
        id: session.id,
        title: session.title,
        temporary: isTemporarySourceSessionKey(session.source_session_key),
        createdAt: session.created_at,
        updatedAt: session.updated_at,
        archivedAt: session.archived_at ?? null,
      },
      turns,
      hasOlder: page.hasOlder,
      oldestSequence: page.oldestSequence,
      latestSequence: page.latestSequence,
      detail,
    };
  }

  eventsAfter(eventId, options = {}) {
    this.#assertOpen();
    if (typeof eventId !== "string" || eventId.length === 0) {
      return [];
    }
    const anchor = this.#database
      .prepare("SELECT ordinal FROM event_log WHERE event_id = ?")
      .get(eventId);
    if (!anchor) {
      return [];
    }
    const limit = clampLimit(options.limit, 100, 500);
    return this.#database
      .prepare(
        "SELECT event_id, session_id, turn_id, sequence FROM event_log WHERE ordinal > ? ORDER BY ordinal ASC LIMIT ?",
      )
      .all(anchor.ordinal, limit)
      .map((row) => ({
        eventId: row.event_id,
        sessionId: row.session_id,
        turnId: row.turn_id,
        sequence: Number(row.sequence),
      }));
  }

  journalMode() {
    this.#assertOpen();
    return this.#database.prepare("PRAGMA journal_mode").get().journal_mode;
  }

  schemaVersion() {
    this.#assertOpen();
    return Number(
      this.#database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get()
        .version,
    );
  }

  close() {
    if (this.#closed) {
      return;
    }
    this.#listeners.clear();
    this.#database.close();
    this.#closed = true;
  }
}
