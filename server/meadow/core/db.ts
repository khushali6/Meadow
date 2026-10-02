import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType, SQLInputValue } from "node:sqlite";
import { homePath } from "../config";

// Loaded through require so bundlers and test transformers never try to resolve the builtin themselves.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL,
    engine TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    screenshots INTEGER NOT NULL DEFAULT 1,
    base_branch TEXT NOT NULL DEFAULT 'main',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    raw_md TEXT NOT NULL,
    spec_md TEXT,
    source TEXT NOT NULL DEFAULT 'generated',
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL,
    UNIQUE(project_id, version)
  );
  CREATE TABLE phases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    phase_key TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    branch TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    summary TEXT,
    commit_sha TEXT,
    started_at TEXT,
    finished_at TEXT
  );
  CREATE TABLE executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    engine TEXT NOT NULL,
    current_phase_id INTEGER,
    tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    note TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE TABLE runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id INTEGER NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
    phase_id INTEGER NOT NULL REFERENCES phases(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    engine TEXT NOT NULL,
    session_id TEXT,
    status TEXT NOT NULL,
    prompt TEXT NOT NULL,
    exit_reason TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0
  );
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    execution_id INTEGER,
    run_id INTEGER,
    phase_id INTEGER,
    ts TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    payload_json TEXT
  );
  CREATE INDEX events_project ON events(project_id, id);
  CREATE TABLE checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phase_id INTEGER NOT NULL,
    run_id INTEGER,
    label TEXT NOT NULL,
    command TEXT NOT NULL,
    exit_code INTEGER,
    passed INTEGER NOT NULL,
    output_tail TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER NOT NULL DEFAULT 0,
    ts TEXT NOT NULL
  );
  CREATE TABLE approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    run_id INTEGER,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL,
    risk TEXT NOT NULL DEFAULT 'medium',
    status TEXT NOT NULL DEFAULT 'pending',
    requested_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    decided_at TEXT,
    decided_by TEXT
  );
  CREATE TABLE screenshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phase_id INTEGER,
    project_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    path TEXT NOT NULL,
    viewport TEXT NOT NULL,
    ts TEXT NOT NULL
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    source TEXT NOT NULL,
    path TEXT NOT NULL,
    text TEXT NOT NULL,
    embedding TEXT
  );
  CREATE INDEX chunks_project ON chunks(project_id);
  CREATE TABLE conversations (
    channel TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    state_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(channel, chat_id)
  );
  `,
  `
  CREATE TABLE atlas_nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    path TEXT,
    props_json TEXT NOT NULL DEFAULT '{}',
    valid_from TEXT,
    valid_to TEXT,
    source TEXT NOT NULL,
    UNIQUE(project_id, key)
  );
  CREATE INDEX atlas_nodes_kind ON atlas_nodes(project_id, kind);
  CREATE INDEX atlas_nodes_name ON atlas_nodes(project_id, name);
  CREATE TABLE atlas_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    src INTEGER NOT NULL REFERENCES atlas_nodes(id) ON DELETE CASCADE,
    dst INTEGER NOT NULL REFERENCES atlas_nodes(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    props_json TEXT NOT NULL DEFAULT '{}',
    valid_from TEXT,
    valid_to TEXT,
    UNIQUE(src, dst, kind)
  );
  CREATE INDEX atlas_edges_src ON atlas_edges(src);
  CREATE INDEX atlas_edges_dst ON atlas_edges(dst);
  CREATE TABLE atlas_docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    node_id INTEGER REFERENCES atlas_nodes(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    path TEXT,
    text TEXT NOT NULL,
    meta_json TEXT NOT NULL DEFAULT '{}',
    ts TEXT,
    embedding BLOB
  );
  CREATE INDEX atlas_docs_project ON atlas_docs(project_id);
  CREATE INDEX atlas_docs_node ON atlas_docs(node_id);
  CREATE VIRTUAL TABLE atlas_fts USING fts5(title, text, content='atlas_docs', content_rowid='id', tokenize='porter unicode61');
  CREATE TRIGGER atlas_docs_ai AFTER INSERT ON atlas_docs BEGIN
    INSERT INTO atlas_fts(rowid, title, text) VALUES (new.id, new.title, new.text);
  END;
  CREATE TRIGGER atlas_docs_ad AFTER DELETE ON atlas_docs BEGIN
    INSERT INTO atlas_fts(atlas_fts, rowid, title, text) VALUES ('delete', old.id, old.title, old.text);
  END;
  CREATE TABLE atlas_investigations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    question TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    answer TEXT,
    result_json TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE TABLE atlas_trace (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    investigation_id INTEGER NOT NULL REFERENCES atlas_investigations(id) ON DELETE CASCADE,
    ts TEXT NOT NULL,
    agent TEXT NOT NULL,
    step TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    data_json TEXT
  );
  CREATE TABLE atlas_ingests (
    project_id INTEGER PRIMARY KEY,
    stats_json TEXT NOT NULL,
    finished_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE atlas_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    investigation_id INTEGER,
    tool TEXT NOT NULL,
    title TEXT NOT NULL,
    args_json TEXT NOT NULL,
    status TEXT NOT NULL,
    approval_id INTEGER,
    result TEXT,
    actor TEXT NOT NULL,
    created_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE INDEX atlas_actions_project ON atlas_actions(project_id, id);
  CREATE INDEX atlas_trace_investigation ON atlas_trace(investigation_id, id);
  CREATE INDEX atlas_investigations_project ON atlas_investigations(project_id, id);
  `,
  `
  ALTER TABLE chunks ADD COLUMN embedding_space TEXT;
  ALTER TABLE atlas_docs ADD COLUMN embedding_space TEXT;
  UPDATE chunks SET embedding_space = 'legacy' WHERE embedding IS NOT NULL;
  UPDATE atlas_docs SET embedding_space = 'legacy' WHERE embedding IS NOT NULL;
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    project_id INTEGER,
    agent TEXT NOT NULL,
    user TEXT NOT NULL,
    tool TEXT NOT NULL,
    risk TEXT NOT NULL,
    args_hash TEXT NOT NULL,
    approval TEXT NOT NULL,
    result TEXT NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    detail TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX audit_log_project ON audit_log(project_id, id);
  `,
];

export type Row = Record<string, SQLInputValue>;

export class MigrationError extends Error {}

const KEEP_BACKUPS = 5;

export class Db {
  raw: DatabaseSyncType;
  /** Path of the backup taken before the last schema upgrade, if one was needed. */
  lastBackup: string | null = null;

  constructor(private readonly file: string, migrations: string[] = MIGRATIONS) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.raw = this.open();
    this.migrate(migrations);
  }

  private open() {
    const raw = new DatabaseSync(this.file);
    raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    return raw;
  }

  /** A consistent copy of the database (VACUUM INTO), pruned to the newest few. */
  backup(label: string): string | null {
    if (this.file === ":memory:") return null;
    const dir = path.join(path.dirname(this.file), "backups");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, `meadow-${label}-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
    this.raw.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    fs.chmodSync(target, 0o600);
    const old = fs.readdirSync(dir).filter(name => /^meadow-.*\.db$/.test(name)).sort().reverse().slice(KEEP_BACKUPS);
    for (const name of old) fs.rmSync(path.join(dir, name), { force: true });
    return target;
  }

  private restore(from: string) {
    this.raw.close();
    for (const suffix of ["-wal", "-shm"]) fs.rmSync(`${this.file}${suffix}`, { force: true });
    fs.copyFileSync(from, this.file);
    this.raw = this.open();
  }

  private migrate(migrations: string[]) {
    this.raw.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
    const row = this.raw.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null };
    const start = row?.v ?? 0;
    let current = start;
    if (current >= migrations.length) return;
    // A fresh database has nothing to lose; an existing one is copied before its schema changes.
    const backup = start > 0 ? this.backup(`v${start}`) : null;
    this.lastBackup = backup;
    try {
      while (current < migrations.length) {
        this.raw.exec("BEGIN");
        try {
          this.raw.exec(migrations[current]);
          current += 1;
          this.raw.prepare("INSERT INTO schema_version (version) VALUES (?)").run(current);
          this.raw.exec("COMMIT");
        } catch (error) {
          this.raw.exec("ROLLBACK");
          throw new MigrationError(`Database migration ${current + 1} failed: ${(error as Error).message}`);
        }
      }
      const check = this.raw.prepare("PRAGMA quick_check").get() as { quick_check: string } | undefined;
      if (check?.quick_check !== "ok") throw new MigrationError(`Database integrity check failed after upgrading: ${check?.quick_check ?? "no result"}`);
    } catch (error) {
      if (backup) {
        this.restore(backup);
        throw new MigrationError(`${(error as Error).message}. Your data was restored from ${backup} (schema v${start}); this Meadow version can't open it until the problem is fixed.`);
      }
      throw error;
    }
  }

  schemaVersion() {
    return (this.raw.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v;
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: SQLInputValue[]) {
    const result = this.raw.prepare(sql).run(...params);
    return { id: Number(result.lastInsertRowid), changes: Number(result.changes) };
  }

  insert(table: string, row: Row) {
    const keys = Object.keys(row);
    return this.run(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`, ...keys.map(key => row[key])).id;
  }

  update(table: string, id: number, row: Row) {
    const keys = Object.keys(row);
    if (!keys.length) return;
    this.run(`UPDATE ${table} SET ${keys.map(key => `${key} = ?`).join(", ")} WHERE id = ?`, ...keys.map(key => row[key]), id);
  }

  close() {
    this.raw.close();
  }
}

let instance: Db | null = null;

export function getDb() {
  if (!instance) instance = new Db(process.env.MEADOW_DB || homePath("meadow.db"));
  return instance;
}

export function setDb(db: Db | null) {
  instance = db;
}

export const now = () => new Date().toISOString();
