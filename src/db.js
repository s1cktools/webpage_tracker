const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const dataDirectory = process.env.DATA_DIR || path.join(process.cwd(), "data");
fs.mkdirSync(dataDirectory, { recursive: true });

const db = new DatabaseSync(path.join(dataDirectory, "tracker.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sites (
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
  );

  CREATE TABLE IF NOT EXISTS discovered_urls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    is_baseline INTEGER NOT NULL DEFAULT 0,
    first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(site_id, url)
  );

  CREATE TABLE IF NOT EXISTS scan_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS discovered_urls_site_seen
    ON discovered_urls(site_id, first_seen_at DESC);

  CREATE INDEX IF NOT EXISTS scan_logs_site_created
    ON scan_logs(site_id, id DESC);
`);

const urlColumns = db.prepare("PRAGMA table_info(discovered_urls)").all();
if (!urlColumns.some((column) => column.name === "is_baseline")) {
  db.exec("ALTER TABLE discovered_urls ADD COLUMN is_baseline INTEGER NOT NULL DEFAULT 0");
}

const siteColumns = db.prepare("PRAGMA table_info(sites)").all();
if (!siteColumns.some((column) => column.name === "nickname")) {
  db.exec("ALTER TABLE sites ADD COLUMN nickname TEXT");
}
if (!siteColumns.some((column) => column.name === "ignore_locales")) {
  db.exec("ALTER TABLE sites ADD COLUMN ignore_locales INTEGER NOT NULL DEFAULT 0");
  db.exec(`
    UPDATE sites
    SET ignore_locales = 1
    WHERE hostname IN ('solana.com', 'www.solana.com', 'claude.com', 'www.claude.com')
  `);
}

const statements = {
  getSetting: db.prepare("SELECT value FROM settings WHERE key = ?"),
  setSetting: db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `),
  listSites: db.prepare(`
    SELECT sites.*,
      (SELECT COUNT(*) FROM discovered_urls WHERE site_id = sites.id) AS url_count
    FROM sites
    ORDER BY created_at DESC
  `),
  getSite: db.prepare("SELECT * FROM sites WHERE id = ?"),
  addSite: db.prepare("INSERT INTO sites (url, hostname, nickname) VALUES (?, ?, ?)"),
  toggleSite: db.prepare(`
    UPDATE sites SET enabled = CASE enabled WHEN 1 THEN 0 ELSE 1 END WHERE id = ?
  `),
  toggleLocales: db.prepare(`
    UPDATE sites
    SET ignore_locales = CASE ignore_locales WHEN 1 THEN 0 ELSE 1 END
    WHERE id = ?
  `),
  deleteSite: db.prepare("DELETE FROM sites WHERE id = ?"),
  activeSites: db.prepare("SELECT * FROM sites WHERE enabled = 1 ORDER BY id"),
  markBaselined: db.prepare("UPDATE sites SET baselined = 1 WHERE id = ?"),
  markScanSuccess: db.prepare(`
    UPDATE sites SET last_scanned_at = CURRENT_TIMESTAMP, last_error = NULL WHERE id = ?
  `),
  markScanError: db.prepare(`
    UPDATE sites SET last_scanned_at = CURRENT_TIMESTAMP, last_error = ? WHERE id = ?
  `),
  insertUrl: db.prepare(`
    INSERT OR IGNORE INTO discovered_urls (site_id, url, is_baseline) VALUES (?, ?, ?)
  `),
  siteUrls: db.prepare("SELECT url FROM discovered_urls WHERE site_id = ?"),
  deleteUrl: db.prepare("DELETE FROM discovered_urls WHERE site_id = ? AND url = ?"),
  recentUrls: db.prepare(`
    SELECT discovered_urls.url, discovered_urls.first_seen_at, sites.hostname
    FROM discovered_urls
    JOIN sites ON sites.id = discovered_urls.site_id
    WHERE discovered_urls.is_baseline = 0
    ORDER BY discovered_urls.id DESC
    LIMIT ?
  `),
  insertLog: db.prepare(`
    INSERT INTO scan_logs (site_id, level, message) VALUES (?, ?, ?)
  `),
  trimLogs: db.prepare(`
    DELETE FROM scan_logs
    WHERE id NOT IN (SELECT id FROM scan_logs ORDER BY id DESC LIMIT 200)
  `),
  globalLogs: db.prepare(`
    SELECT scan_logs.*, sites.hostname, COALESCE(sites.nickname, sites.hostname) AS nickname
    FROM scan_logs
    JOIN sites ON sites.id = scan_logs.site_id
    ORDER BY scan_logs.id DESC
    LIMIT ?
  `),
  siteLogs: db.prepare(`
    SELECT scan_logs.*, sites.hostname, COALESCE(sites.nickname, sites.hostname) AS nickname
    FROM scan_logs
    JOIN sites ON sites.id = scan_logs.site_id
    WHERE scan_logs.site_id = ?
    ORDER BY scan_logs.id DESC
    LIMIT ?
  `),
};

function getSetting(key) {
  return statements.getSetting.get(key)?.value || "";
}

function addDiscoveredUrls(siteId, urls, isBaseline = false) {
  const inserted = [];
  db.exec("BEGIN");
  try {
    for (const url of urls) {
      if (statements.insertUrl.run(siteId, url, isBaseline ? 1 : 0).changes) {
        inserted.push(url);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return inserted;
}

function addLog(siteId, level, message) {
  statements.insertLog.run(siteId, level, String(message).slice(0, 500));
  statements.trimLogs.run();
}

function pruneDiscoveredUrls(siteId, shouldDelete) {
  const urls = statements.siteUrls.all(siteId).map((row) => row.url);
  const removed = urls.filter(shouldDelete);
  db.exec("BEGIN");
  try {
    for (const url of removed) statements.deleteUrl.run(siteId, url);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return removed.length;
}

module.exports = {
  db,
  statements,
  getSetting,
  addDiscoveredUrls,
  addLog,
  pruneDiscoveredUrls,
};
