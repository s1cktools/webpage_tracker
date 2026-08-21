const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { diffObjects, getBinanceNamespaceUrl } = require("./binance");

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
    ct_baselined INTEGER NOT NULL DEFAULT 0,
    ct_history_baselined INTEGER NOT NULL DEFAULT 0,
    ct_last_checked_at TEXT,
    ct_last_error TEXT,
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

  CREATE TABLE IF NOT EXISTS discovered_subdomains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    hostname TEXT NOT NULL,
    source TEXT NOT NULL,
    wildcard_observation INTEGER NOT NULL DEFAULT 0,
    dns_status TEXT NOT NULL DEFAULT 'unchecked',
    is_baseline INTEGER NOT NULL DEFAULT 0,
    first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(site_id, hostname)
  );

  CREATE TABLE IF NOT EXISTS github_targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK(kind IN ('repo', 'user')),
    owner TEXT NOT NULL,
    repo TEXT,
    nickname TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    baselined INTEGER NOT NULL DEFAULT 0,
    etag TEXT,
    last_checked_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS github_seen_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id INTEGER NOT NULL REFERENCES github_targets(id) ON DELETE CASCADE,
    external_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('commit', 'repository')),
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    is_baseline INTEGER NOT NULL DEFAULT 0,
    first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(target_id, external_id)
  );

  CREATE TABLE IF NOT EXISTS github_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id INTEGER NOT NULL REFERENCES github_targets(id) ON DELETE CASCADE,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS binance_ui_namespaces (
    name TEXT PRIMARY KEY,
    etag TEXT,
    version_id TEXT,
    last_modified_at TEXT,
    snapshot_json TEXT,
    baselined INTEGER NOT NULL DEFAULT 0,
    last_checked_at TEXT,
    last_error TEXT
  );

  CREATE TABLE IF NOT EXISTS binance_ui_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    namespace TEXT NOT NULL REFERENCES binance_ui_namespaces(name) ON DELETE CASCADE,
    change_type TEXT NOT NULL CHECK(change_type IN ('added', 'changed', 'removed')),
    item_key TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS binance_ui_observations (
    namespace TEXT NOT NULL REFERENCES binance_ui_namespaces(name) ON DELETE CASCADE,
    version_key TEXT NOT NULL,
    etag TEXT,
    version_id TEXT,
    source_last_modified_at TEXT,
    first_probe_id TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    report_id TEXT,
    changes_count INTEGER NOT NULL DEFAULT 0,
    changes_json TEXT,
    notification_status TEXT NOT NULL DEFAULT 'none'
      CHECK(notification_status IN ('none', 'pending', 'delivering', 'delivered')),
    delivery_error TEXT,
    PRIMARY KEY(namespace, version_key)
  );

  CREATE TABLE IF NOT EXISTS pump_app_state (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    runtime_version TEXT,
    update_id TEXT,
    etag TEXT,
    launch_hash TEXT,
    bundle_hash TEXT,
    signals_json TEXT NOT NULL DEFAULT '{}',
    baselined INTEGER NOT NULL DEFAULT 0,
    published_at TEXT,
    last_checked_at TEXT,
    last_error TEXT
  );

  CREATE TABLE IF NOT EXISTS pump_app_updates (
    update_id TEXT PRIMARY KEY,
    runtime_version TEXT NOT NULL,
    previous_update_id TEXT,
    published_at TEXT,
    launch_hash TEXT NOT NULL,
    change_count INTEGER NOT NULL,
    changes_json TEXT NOT NULL,
    detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pump_assets (
    asset_key TEXT PRIMARY KEY,
    name TEXT,
    file_extension TEXT,
    content_type TEXT,
    has_file INTEGER NOT NULL DEFAULT 0,
    filename TEXT,
    source_update_id TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS alert_reports (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    item_count INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS discovered_urls_site_seen
    ON discovered_urls(site_id, first_seen_at DESC);

  CREATE INDEX IF NOT EXISTS scan_logs_site_created
    ON scan_logs(site_id, id DESC);

  CREATE INDEX IF NOT EXISTS discovered_subdomains_site_seen
    ON discovered_subdomains(site_id, id DESC);

  CREATE INDEX IF NOT EXISTS github_seen_target
    ON github_seen_items(target_id, id DESC);

  CREATE INDEX IF NOT EXISTS github_logs_target
    ON github_logs(target_id, id DESC);

  CREATE INDEX IF NOT EXISTS binance_ui_changes_detected
    ON binance_ui_changes(id DESC);

  CREATE INDEX IF NOT EXISTS pump_app_updates_detected
    ON pump_app_updates(detected_at DESC);

  CREATE INDEX IF NOT EXISTS alert_reports_created
    ON alert_reports(created_at DESC);
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
if (!siteColumns.some((column) => column.name === "ct_baselined")) {
  db.exec("ALTER TABLE sites ADD COLUMN ct_baselined INTEGER NOT NULL DEFAULT 0");
}
if (!siteColumns.some((column) => column.name === "ct_history_baselined")) {
  db.exec("ALTER TABLE sites ADD COLUMN ct_history_baselined INTEGER NOT NULL DEFAULT 0");
}
if (!siteColumns.some((column) => column.name === "ct_last_checked_at")) {
  db.exec("ALTER TABLE sites ADD COLUMN ct_last_checked_at TEXT");
}
if (!siteColumns.some((column) => column.name === "ct_last_error")) {
  db.exec("ALTER TABLE sites ADD COLUMN ct_last_error TEXT");
}

const binanceNamespaceColumns = db
  .prepare("PRAGMA table_info(binance_ui_namespaces)")
  .all();
if (!binanceNamespaceColumns.some((column) => column.name === "version_id")) {
  db.exec("ALTER TABLE binance_ui_namespaces ADD COLUMN version_id TEXT");
}
if (!binanceNamespaceColumns.some((column) => column.name === "last_modified_at")) {
  db.exec("ALTER TABLE binance_ui_namespaces ADD COLUMN last_modified_at TEXT");
}

const statements = {
  getSetting: db.prepare("SELECT value FROM settings WHERE key = ?"),
  setSetting: db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `),
  listSites: db.prepare(`
    SELECT sites.*,
      (SELECT COUNT(*) FROM discovered_urls WHERE site_id = sites.id) AS url_count,
      (SELECT COUNT(*) FROM discovered_subdomains WHERE site_id = sites.id) AS subdomain_count
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
  insertSubdomain: db.prepare(`
    INSERT OR IGNORE INTO discovered_subdomains
      (site_id, hostname, source, wildcard_observation, dns_status, is_baseline)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  updateSubdomainDns: db.prepare(`
    UPDATE discovered_subdomains SET dns_status = ? WHERE site_id = ? AND hostname = ?
  `),
  recentSubdomains: db.prepare(`
    SELECT discovered_subdomains.*, sites.hostname AS root_hostname,
      COALESCE(sites.nickname, sites.hostname) AS site_name
    FROM discovered_subdomains
    JOIN sites ON sites.id = discovered_subdomains.site_id
    WHERE discovered_subdomains.is_baseline = 0
    ORDER BY discovered_subdomains.id DESC
    LIMIT ?
  `),
  markCtBaselined: db.prepare(`
    UPDATE sites SET ct_baselined = 1, ct_history_baselined = 1,
      ct_last_checked_at = CURRENT_TIMESTAMP,
      ct_last_error = NULL WHERE id = ?
  `),
  markCtLiveAfterBaselineError: db.prepare(`
    UPDATE sites SET ct_baselined = 1, ct_last_checked_at = CURRENT_TIMESTAMP,
      ct_last_error = ? WHERE id = ?
  `),
  markCtSuccess: db.prepare(`
    UPDATE sites SET ct_last_checked_at = CURRENT_TIMESTAMP, ct_last_error = NULL WHERE id = ?
  `),
  markCtError: db.prepare(`
    UPDATE sites SET ct_last_checked_at = CURRENT_TIMESTAMP, ct_last_error = ? WHERE id = ?
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
  listGithubTargets: db.prepare(`
    SELECT github_targets.*,
      (SELECT COUNT(*) FROM github_seen_items WHERE target_id = github_targets.id) AS item_count
    FROM github_targets
    ORDER BY created_at DESC
  `),
  getGithubTarget: db.prepare("SELECT * FROM github_targets WHERE id = ?"),
  addGithubTarget: db.prepare(`
    INSERT INTO github_targets (target_key, kind, owner, repo, nickname)
    VALUES (?, ?, ?, ?, ?)
  `),
  toggleGithubTarget: db.prepare(`
    UPDATE github_targets
    SET enabled = CASE enabled WHEN 1 THEN 0 ELSE 1 END
    WHERE id = ?
  `),
  deleteGithubTarget: db.prepare("DELETE FROM github_targets WHERE id = ?"),
  activeGithubTargets: db.prepare(`
    SELECT * FROM github_targets WHERE enabled = 1 ORDER BY id
  `),
  markGithubBaselined: db.prepare(`
    UPDATE github_targets SET baselined = 1 WHERE id = ?
  `),
  markGithubSuccess: db.prepare(`
    UPDATE github_targets
    SET etag = COALESCE(?, etag),
        last_checked_at = CURRENT_TIMESTAMP,
        last_error = NULL
    WHERE id = ?
  `),
  markGithubError: db.prepare(`
    UPDATE github_targets
    SET last_checked_at = CURRENT_TIMESTAMP, last_error = ?
    WHERE id = ?
  `),
  insertGithubItem: db.prepare(`
    INSERT OR IGNORE INTO github_seen_items
      (target_id, external_id, kind, title, url, is_baseline)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  recentGithubItems: db.prepare(`
    SELECT github_seen_items.*, github_targets.owner, github_targets.repo,
      COALESCE(github_targets.nickname, github_targets.target_key) AS target_name
    FROM github_seen_items
    JOIN github_targets ON github_targets.id = github_seen_items.target_id
    WHERE github_seen_items.is_baseline = 0
    ORDER BY github_seen_items.id DESC
    LIMIT ?
  `),
  insertGithubLog: db.prepare(`
    INSERT INTO github_logs (target_id, level, message) VALUES (?, ?, ?)
  `),
  trimGithubLogs: db.prepare(`
    DELETE FROM github_logs
    WHERE id NOT IN (SELECT id FROM github_logs ORDER BY id DESC LIMIT 200)
  `),
  globalGithubLogs: db.prepare(`
    SELECT github_logs.*, github_targets.target_key,
      COALESCE(github_targets.nickname, github_targets.target_key) AS target_name
    FROM github_logs
    JOIN github_targets ON github_targets.id = github_logs.target_id
    ORDER BY github_logs.id DESC
    LIMIT ?
  `),
  targetGithubLogs: db.prepare(`
    SELECT github_logs.*, github_targets.target_key,
      COALESCE(github_targets.nickname, github_targets.target_key) AS target_name
    FROM github_logs
    JOIN github_targets ON github_targets.id = github_logs.target_id
    WHERE github_logs.target_id = ?
    ORDER BY github_logs.id DESC
    LIMIT ?
  `),
  ensureBinanceNamespace: db.prepare(`
    INSERT OR IGNORE INTO binance_ui_namespaces (name) VALUES (?)
  `),
  getBinanceNamespace: db.prepare(`
    SELECT * FROM binance_ui_namespaces WHERE name = ?
  `),
  listBinanceNamespaces: db.prepare(`
    SELECT * FROM binance_ui_namespaces ORDER BY name COLLATE NOCASE
  `),
  markBinanceUnchanged: db.prepare(`
    UPDATE binance_ui_namespaces
    SET version_id = COALESCE(?, version_id),
        last_modified_at = COALESCE(?, last_modified_at),
        last_checked_at = CURRENT_TIMESTAMP,
        last_error = NULL
    WHERE name = ?
  `),
  saveBinanceSnapshot: db.prepare(`
    UPDATE binance_ui_namespaces
    SET etag = ?,
        version_id = ?,
        last_modified_at = ?,
        snapshot_json = ?,
        baselined = 1,
        last_checked_at = CURRENT_TIMESTAMP,
        last_error = NULL
    WHERE name = ?
  `),
  markBinanceError: db.prepare(`
    UPDATE binance_ui_namespaces
    SET last_checked_at = CURRENT_TIMESTAMP, last_error = ?
    WHERE name = ?
  `),
  insertBinanceChange: db.prepare(`
    INSERT INTO binance_ui_changes
      (namespace, change_type, item_key, old_value, new_value)
    VALUES (?, ?, ?, ?, ?)
  `),
  trimBinanceChanges: db.prepare(`
    DELETE FROM binance_ui_changes
    WHERE id NOT IN (SELECT id FROM binance_ui_changes ORDER BY id DESC LIMIT 500)
  `),
  recentBinanceChanges: db.prepare(`
    SELECT * FROM binance_ui_changes ORDER BY id DESC LIMIT ?
  `),
  countBinanceChanges: db.prepare(`
    SELECT COUNT(*) AS count FROM binance_ui_changes
  `),
  insertBinanceObservation: db.prepare(`
    INSERT OR IGNORE INTO binance_ui_observations (
      namespace, version_key, etag, version_id,
      source_last_modified_at, first_probe_id, observed_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  getBinanceObservation: db.prepare(`
    SELECT * FROM binance_ui_observations
    WHERE namespace = ? AND version_key = ?
  `),
  finishBinanceObservation: db.prepare(`
    UPDATE binance_ui_observations
    SET report_id = ?,
        changes_count = ?,
        changes_json = ?,
        notification_status = ?
    WHERE namespace = ? AND version_key = ?
  `),
  claimBinanceNotification: db.prepare(`
    UPDATE binance_ui_observations
    SET notification_status = 'delivering', delivery_error = NULL
    WHERE namespace = ? AND version_key = ? AND notification_status = 'pending'
  `),
  markBinanceNotificationDelivered: db.prepare(`
    UPDATE binance_ui_observations
    SET notification_status = 'delivered', delivery_error = NULL
    WHERE namespace = ? AND version_key = ?
  `),
  markBinanceNotificationFailed: db.prepare(`
    UPDATE binance_ui_observations
    SET notification_status = 'pending', delivery_error = ?
    WHERE namespace = ? AND version_key = ?
  `),
  pendingBinanceNotifications: db.prepare(`
    SELECT namespace, version_key, first_probe_id, observed_at
    FROM binance_ui_observations
    WHERE notification_status = 'pending'
    ORDER BY observed_at
  `),
  ensurePumpState: db.prepare(`
    INSERT OR IGNORE INTO pump_app_state (id) VALUES (1)
  `),
  getPumpState: db.prepare("SELECT * FROM pump_app_state WHERE id = 1"),
  markPumpUnchanged: db.prepare(`
    UPDATE pump_app_state
    SET last_checked_at = CURRENT_TIMESTAMP, last_error = NULL
    WHERE id = 1
  `),
  savePumpState: db.prepare(`
    UPDATE pump_app_state
    SET runtime_version = ?,
        update_id = ?,
        etag = ?,
        launch_hash = ?,
        bundle_hash = ?,
        signals_json = ?,
        baselined = 1,
        published_at = ?,
        last_checked_at = CURRENT_TIMESTAMP,
        last_error = NULL
    WHERE id = 1
  `),
  markPumpError: db.prepare(`
    UPDATE pump_app_state
    SET last_checked_at = CURRENT_TIMESTAMP,
        last_error = ?,
        runtime_version = COALESCE(?, runtime_version)
    WHERE id = 1
  `),
  insertPumpUpdate: db.prepare(`
    INSERT OR IGNORE INTO pump_app_updates
      (update_id, runtime_version, previous_update_id, published_at,
       launch_hash, change_count, changes_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  recentPumpUpdates: db.prepare(`
    SELECT * FROM pump_app_updates ORDER BY detected_at DESC LIMIT ?
  `),
  getPumpUpdate: db.prepare(`
    SELECT * FROM pump_app_updates WHERE update_id = ?
  `),
  countPumpUpdates: db.prepare(`
    SELECT COUNT(*) AS count FROM pump_app_updates
  `),
  trimPumpUpdates: db.prepare(`
    DELETE FROM pump_app_updates
    WHERE update_id NOT IN (
      SELECT update_id FROM pump_app_updates ORDER BY detected_at DESC LIMIT 50
    )
  `),
  upsertPumpAsset: db.prepare(`
    INSERT INTO pump_assets (
      asset_key, name, file_extension, content_type,
      has_file, filename, source_update_id, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(asset_key) DO UPDATE SET
      name = COALESCE(excluded.name, name),
      file_extension = COALESCE(excluded.file_extension, file_extension),
      content_type = COALESCE(excluded.content_type, content_type),
      has_file = CASE WHEN excluded.has_file = 1 THEN 1 ELSE has_file END,
      filename = COALESCE(excluded.filename, filename),
      source_update_id = COALESCE(excluded.source_update_id, source_update_id),
      updated_at = CURRENT_TIMESTAMP
  `),
  getPumpAsset: db.prepare(`
    SELECT * FROM pump_assets WHERE asset_key = ?
  `),
  insertAlertReport: db.prepare(`
    INSERT INTO alert_reports (id, kind, title, item_count, payload_json)
    VALUES (?, ?, ?, ?, ?)
  `),
  getAlertReport: db.prepare(`
    SELECT * FROM alert_reports WHERE id = ?
  `),
  recentAlertReports: db.prepare(`
    SELECT id, kind, title, item_count, created_at
    FROM alert_reports
    ORDER BY created_at DESC, rowid DESC
    LIMIT ?
  `),
  countAlertReports: db.prepare(`
    SELECT COUNT(*) AS count FROM alert_reports
  `),
  trimAlertReports: db.prepare(`
    DELETE FROM alert_reports
    WHERE id NOT IN (
      SELECT id FROM alert_reports ORDER BY created_at DESC, rowid DESC LIMIT 500
    )
  `),
};

statements.ensurePumpState.run();
db.exec(`
  UPDATE binance_ui_observations
  SET notification_status = 'pending'
  WHERE notification_status = 'delivering'
`);

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

function addDiscoveredSubdomains(siteId, entries, source, isBaseline = false) {
  const inserted = [];
  db.exec("BEGIN");
  try {
    for (const entry of entries) {
      const result = statements.insertSubdomain.run(
        siteId,
        entry.hostname,
        source,
        entry.wildcard ? 1 : 0,
        entry.dnsStatus || "unchecked",
        isBaseline ? 1 : 0
      );
      if (result.changes) inserted.push({ ...entry, source });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return inserted;
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

function addGithubItems(targetId, items, isBaseline = false) {
  const inserted = [];
  db.exec("BEGIN");
  try {
    for (const item of items) {
      const result = statements.insertGithubItem.run(
        targetId,
        item.externalId,
        item.kind,
        item.title,
        item.url,
        isBaseline ? 1 : 0
      );
      if (result.changes) inserted.push(item);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return inserted;
}

function addGithubLog(targetId, level, message) {
  statements.insertGithubLog.run(targetId, level, String(message).slice(0, 500));
  statements.trimGithubLogs.run();
}

function addBinanceChanges(namespace, changes) {
  db.exec("BEGIN");
  try {
    for (const change of changes) {
      statements.insertBinanceChange.run(
        namespace,
        change.type,
        change.key,
        change.oldValue ?? null,
        change.newValue ?? null
      );
    }
    statements.trimBinanceChanges.run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function applyBinanceObservation(observation) {
  const versionKey = observation.versionId || observation.etag;
  if (!versionKey) throw new Error("Binance observation is missing a version identifier");

  statements.ensureBinanceNamespace.run(observation.namespace);
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = statements.getBinanceNamespace.get(observation.namespace);
    if (
      current.baselined &&
      !current.last_modified_at &&
      current.etag !== observation.etag &&
      !observation.trustedLocal
    ) {
      db.exec("COMMIT");
      return { status: "deferred", versionKey };
    }

    const inserted = statements.insertBinanceObservation.run(
      observation.namespace,
      versionKey,
      observation.etag || null,
      observation.versionId || null,
      observation.lastModified || null,
      observation.probeId,
      observation.observedAt
    );
    if (!inserted.changes) {
      db.exec("COMMIT");
      return { status: "duplicate", versionKey };
    }

    const currentTime = Date.parse(current.last_modified_at || "");
    const incomingTime = Date.parse(observation.lastModified || "");
    const hasCurrentTime = Number.isFinite(currentTime);
    const hasIncomingTime = Number.isFinite(incomingTime);
    const isStale =
      current.baselined &&
      current.etag !== observation.etag &&
      ((hasCurrentTime && !hasIncomingTime) ||
        (hasCurrentTime && hasIncomingTime && incomingTime <= currentTime));

    if (isStale) {
      statements.finishBinanceObservation.run(
        null,
        0,
        null,
        "none",
        observation.namespace,
        versionKey
      );
      db.exec("COMMIT");
      return { status: "stale", versionKey };
    }

    if (
      current.baselined &&
      (current.etag === observation.etag ||
        (current.version_id &&
          observation.versionId &&
          current.version_id === observation.versionId))
    ) {
      statements.markBinanceUnchanged.run(
        observation.versionId || null,
        observation.lastModified || null,
        observation.namespace
      );
      statements.finishBinanceObservation.run(
        null,
        0,
        null,
        "none",
        observation.namespace,
        versionKey
      );
      db.exec("COMMIT");
      return { status: "unchanged", versionKey };
    }

    let changes = [];
    if (current.baselined) {
      if (!current.snapshot_json) {
        throw new Error(`Missing Binance snapshot for ${observation.namespace}`);
      }
      changes = diffObjects(JSON.parse(current.snapshot_json), observation.snapshot);
    }

    statements.saveBinanceSnapshot.run(
      observation.etag || null,
      observation.versionId || null,
      observation.lastModified || null,
      JSON.stringify(observation.snapshot),
      observation.namespace
    );

    let reportId = null;
    if (current.baselined && changes.length) {
      for (const change of changes) {
        statements.insertBinanceChange.run(
          observation.namespace,
          change.type,
          change.key,
          change.oldValue ?? null,
          change.newValue ?? null
        );
      }
      statements.trimBinanceChanges.run();

      reportId = randomUUID();
      const items = changes.map((change) => ({
        type: change.type,
        label: change.key,
        oldValue: change.oldValue,
        newValue: change.newValue,
      }));
      statements.insertAlertReport.run(
        reportId,
        "binance",
        `${observation.namespace} · Binance UI changes`,
        items.length,
        JSON.stringify({
          subtitle: `${items.length} extracted translation changes`,
          items,
          sourceUrl: getBinanceNamespaceUrl(observation.namespace),
        })
      );
      statements.trimAlertReports.run();
    }

    statements.finishBinanceObservation.run(
      reportId,
      changes.length,
      changes.length ? JSON.stringify(changes) : null,
      changes.length ? "pending" : "none",
      observation.namespace,
      versionKey
    );
    db.exec("COMMIT");
    return {
      status: current.baselined ? "accepted" : "baselined",
      versionKey,
      changes,
      reportId,
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function claimBinanceNotification(namespace, versionKey) {
  const result = statements.claimBinanceNotification.run(namespace, versionKey);
  if (!result.changes) return null;
  const row = statements.getBinanceObservation.get(namespace, versionKey);
  return {
    namespace,
    versionKey,
    reportId: row.report_id,
    changes: JSON.parse(row.changes_json || "[]"),
  };
}

function markBinanceNotificationDelivered(namespace, versionKey) {
  statements.markBinanceNotificationDelivered.run(namespace, versionKey);
}

function markBinanceNotificationFailed(namespace, versionKey, error) {
  statements.markBinanceNotificationFailed.run(
    String(error?.message || error).slice(0, 500),
    namespace,
    versionKey
  );
}

function listPendingBinanceNotifications() {
  return statements.pendingBinanceNotifications.all();
}

function savePumpUpdate(state, update) {
  db.exec("BEGIN");
  try {
    statements.savePumpState.run(
      state.runtimeVersion,
      state.updateId,
      state.etag,
      state.launchHash,
      state.bundleHash,
      JSON.stringify(state.signals),
      state.publishedAt
    );
    if (update) {
      statements.insertPumpUpdate.run(
        update.updateId,
        update.runtimeVersion,
        update.previousUpdateId,
        update.publishedAt,
        update.launchHash,
        update.changes.length,
        JSON.stringify(update.changes)
      );
      statements.trimPumpUpdates.run();
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function createAlertReport(kind, title, payload) {
  const id = randomUUID();
  const itemCount = Array.isArray(payload?.items) ? payload.items.length : 0;
  statements.insertAlertReport.run(
    id,
    String(kind),
    String(title),
    itemCount,
    JSON.stringify(payload)
  );
  statements.trimAlertReports.run();
  return id;
}

module.exports = {
  dataDirectory,
  db,
  dataDirectory,
  statements,
  getSetting,
  addDiscoveredUrls,
  addDiscoveredSubdomains,
  addLog,
  pruneDiscoveredUrls,
  addGithubItems,
  addGithubLog,
  addBinanceChanges,
  applyBinanceObservation,
  claimBinanceNotification,
  createAlertReport,
  listPendingBinanceNotifications,
  markBinanceNotificationDelivered,
  markBinanceNotificationFailed,
  savePumpUpdate,
};
