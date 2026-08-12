CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  source_session_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  source_turn_key TEXT,
  request_summary TEXT NOT NULL,
  answer_json TEXT NOT NULL,
  answer_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  publication_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, sequence),
  UNIQUE (session_id, idempotency_key)
);

CREATE UNIQUE INDEX turns_session_source_turn_unique
  ON turns(session_id, source_turn_key)
  WHERE source_turn_key IS NOT NULL;

CREATE INDEX turns_session_sequence_desc
  ON turns(session_id, sequence DESC);

CREATE INDEX sessions_updated_desc
  ON sessions(updated_at DESC, id DESC);

CREATE TABLE legacy_imports (
  source_path TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE RESTRICT,
  imported_at TEXT NOT NULL
);

CREATE TRIGGER turns_block_update
BEFORE UPDATE ON turns
BEGIN
  SELECT RAISE(ABORT, 'turns_are_immutable');
END;

CREATE TRIGGER turns_block_delete
BEFORE DELETE ON turns
BEGIN
  SELECT RAISE(ABORT, 'turns_are_immutable');
END;
