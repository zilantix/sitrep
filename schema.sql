-- SITREP schema (D1 / SQLite)

CREATE TABLE IF NOT EXISTS projects (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  stakeholders TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'planned'
               CHECK (status IN ('planned','active','blocked','complete')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS updates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  content      TEXT NOT NULL,
  meeting_date TEXT NOT NULL DEFAULT (date('now')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Generated artifacts. project_id NULL = consolidated meeting prep across projects.
CREATE TABLE IF NOT EXISTS briefs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'sitrep' CHECK (kind IN ('sitrep','meeting_prep')),
  content_json TEXT NOT NULL,
  model        TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_updates_project ON updates(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notes_project   ON notes(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_briefs_project  ON briefs(project_id, created_at);
