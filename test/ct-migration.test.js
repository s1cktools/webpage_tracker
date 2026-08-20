const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

test("upgrades an existing sites table with CT state", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pagepulse-ct-migration-"));
  const databasePath = path.join(directory, "tracker.db");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL UNIQUE,
      hostname TEXT NOT NULL,
      nickname TEXT,
      ignore_locales INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      baselined INTEGER NOT NULL DEFAULT 0,
      last_scanned_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  legacy.close();

  process.env.DATA_DIR = directory;
  const { db } = require("../src/db");
  try {
    const columns = db
      .prepare("PRAGMA table_info(sites)")
      .all()
      .map((column) => column.name);
    assert.ok(columns.includes("ct_baselined"));
    assert.ok(columns.includes("ct_history_baselined"));
    assert.ok(columns.includes("ct_last_checked_at"));
    assert.ok(columns.includes("ct_last_error"));
    assert.ok(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("discovered_subdomains")
    );
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
