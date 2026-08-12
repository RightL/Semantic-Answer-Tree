CREATE TABLE event_log (
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  turn_id TEXT NOT NULL UNIQUE REFERENCES turns(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX event_log_session_sequence
  ON event_log(session_id, sequence DESC);
