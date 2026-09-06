const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { diffObjects, getBinanceNamespaceUrl } = require("./binance");
const { canonicalizePageUrl, pageUrlAliases } = require("./discovery");
const { diffPumpSignals } = require("./pump");

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

  CREATE TABLE IF NOT EXISTS pump_app_observations (
    update_id TEXT PRIMARY KEY,
    runtime_version TEXT NOT NULL,
    previous_update_id TEXT,
    published_at TEXT,
    launch_hash TEXT NOT NULL,
    first_probe_id TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    changes_json TEXT,
    notification_status TEXT NOT NULL DEFAULT 'none'
      CHECK(notification_status IN ('none', 'pending', 'delivering', 'delivered')),
    delivery_error TEXT
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

  CREATE TABLE IF NOT EXISTS robinhood_state (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    home_etag TEXT,
    login_etag TEXT,
    learn_etag TEXT,
    robots_etag TEXT,
    sitemap_etag TEXT,
    brand_build_id TEXT,
    learn_build_id TEXT,
    runtime_url TEXT,
    sources_json TEXT NOT NULL DEFAULT '{}',
    page_count INTEGER NOT NULL DEFAULT 0,
    baselined INTEGER NOT NULL DEFAULT 0,
    last_checked_at TEXT,
    last_error TEXT
  );

  CREATE TABLE IF NOT EXISTS robinhood_pages (
    url TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    host TEXT NOT NULL,
    source TEXT NOT NULL,
    title TEXT,
    is_baseline INTEGER NOT NULL DEFAULT 0,
    first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS youtube_channels (
    channel_id TEXT PRIMARY KEY,
    handle TEXT,
    title TEXT NOT NULL,
    poll_interval_seconds INTEGER NOT NULL DEFAULT 15,
    enabled INTEGER NOT NULL DEFAULT 1,
    baselined INTEGER NOT NULL DEFAULT 0,
    ai_analysis_enabled INTEGER NOT NULL DEFAULT 0,
    last_checked_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS youtube_videos (
    channel_id TEXT NOT NULL REFERENCES youtube_channels(channel_id) ON DELETE CASCADE,
    video_id TEXT NOT NULL,
    title TEXT,
    thumbnail_url TEXT,
    is_baseline INTEGER NOT NULL DEFAULT 0,
    first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (channel_id, video_id)
  );

  CREATE TABLE IF NOT EXISTS binance_square_targets (
    square_uid TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    display_name TEXT NOT NULL,
    avatar TEXT,
    biography TEXT,
    poll_interval_seconds INTEGER NOT NULL DEFAULT 15,
    enabled INTEGER NOT NULL DEFAULT 1,
    baselined INTEGER NOT NULL DEFAULT 0,
    pinned_post_count INTEGER NOT NULL DEFAULT 0,
    last_checked_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS binance_square_posts (
    square_uid TEXT NOT NULL REFERENCES binance_square_targets(square_uid) ON DELETE CASCADE,
    post_id TEXT NOT NULL,
    title TEXT,
    content TEXT,
    created_at INTEGER,
    post_type TEXT,
    content_type INTEGER,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    url TEXT,
    cover TEXT,
    images_json TEXT,
    is_baseline INTEGER NOT NULL DEFAULT 0,
    first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (square_uid, post_id)
  );

  CREATE TABLE IF NOT EXISTS satellites (
    id TEXT PRIMARY KEY,
    last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_kinds_json TEXT NOT NULL DEFAULT '[]'
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

  CREATE INDEX IF NOT EXISTS robinhood_pages_seen
    ON robinhood_pages(first_seen_at DESC);

  CREATE INDEX IF NOT EXISTS youtube_videos_seen
    ON youtube_videos(first_seen_at DESC);

  CREATE INDEX IF NOT EXISTS binance_square_posts_seen
    ON binance_square_posts(first_seen_at DESC);

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
  getSiteByHostnames: db.prepare(`
    SELECT * FROM sites
    WHERE lower(hostname) IN (lower(?), lower(?))
    ORDER BY id
    LIMIT 1
  `),
  addSite: db.prepare("INSERT INTO sites (url, hostname, nickname) VALUES (?, ?, ?)"),
  addSiteWithLocales: db.prepare(`
    INSERT INTO sites (url, hostname, nickname, ignore_locales) VALUES (?, ?, ?, ?)
  `),
  updateWebsitePlaybook: db.prepare(`
    UPDATE sites
    SET url = ?, hostname = ?, nickname = ?, ignore_locales = ?
    WHERE id = ?
  `),
  setSiteEnabled: db.prepare("UPDATE sites SET enabled = ? WHERE id = ?"),
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
  getUrl: db.prepare("SELECT url FROM discovered_urls WHERE site_id = ? AND url = ?"),
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
  insertPumpObservation: db.prepare(`
    INSERT OR IGNORE INTO pump_app_observations (
      update_id, runtime_version, previous_update_id, published_at,
      launch_hash, first_probe_id, observed_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  getPumpObservation: db.prepare(`
    SELECT * FROM pump_app_observations WHERE update_id = ?
  `),
  finishPumpObservation: db.prepare(`
    UPDATE pump_app_observations
    SET changes_json = ?, notification_status = ?
    WHERE update_id = ?
  `),
  claimPumpNotification: db.prepare(`
    UPDATE pump_app_observations
    SET notification_status = 'delivering', delivery_error = NULL
    WHERE update_id = ? AND notification_status = 'pending'
  `),
  markPumpNotificationDelivered: db.prepare(`
    UPDATE pump_app_observations
    SET notification_status = 'delivered', delivery_error = NULL
    WHERE update_id = ?
  `),
  markPumpNotificationFailed: db.prepare(`
    UPDATE pump_app_observations
    SET notification_status = 'pending', delivery_error = ?
    WHERE update_id = ?
  `),
  pendingPumpNotifications: db.prepare(`
    SELECT update_id, first_probe_id, observed_at
    FROM pump_app_observations
    WHERE notification_status = 'pending'
    ORDER BY observed_at
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
  ensureRobinhoodState: db.prepare(`
    INSERT OR IGNORE INTO robinhood_state (id) VALUES (1)
  `),
  getRobinhoodState: db.prepare("SELECT * FROM robinhood_state WHERE id = 1"),
  markRobinhoodUnchanged: db.prepare(`
    UPDATE robinhood_state
    SET last_checked_at = CURRENT_TIMESTAMP, last_error = NULL
    WHERE id = 1
  `),
  saveRobinhoodState: db.prepare(`
    UPDATE robinhood_state
    SET home_etag = ?,
        login_etag = ?,
        learn_etag = ?,
        robots_etag = ?,
        sitemap_etag = ?,
        brand_build_id = ?,
        learn_build_id = ?,
        runtime_url = ?,
        sources_json = ?,
        page_count = ?,
        baselined = 1,
        last_checked_at = CURRENT_TIMESTAMP,
        last_error = NULL
    WHERE id = 1
  `),
  markRobinhoodError: db.prepare(`
    UPDATE robinhood_state
    SET last_checked_at = CURRENT_TIMESTAMP, last_error = ?
    WHERE id = 1
  `),
  insertRobinhoodPage: db.prepare(`
    INSERT OR IGNORE INTO robinhood_pages
      (url, path, host, source, title, is_baseline)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  recentRobinhoodPages: db.prepare(`
    SELECT * FROM robinhood_pages
    WHERE is_baseline = 0
    ORDER BY first_seen_at DESC, url
    LIMIT ?
  `),
  countRobinhoodPages: db.prepare(`
    SELECT COUNT(*) AS count FROM robinhood_pages
  `),
  countRobinhoodDiscoveries: db.prepare(`
    SELECT COUNT(*) AS count FROM robinhood_pages WHERE is_baseline = 0
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
  upsertSatellite: db.prepare(`
    INSERT INTO satellites (id, last_seen_at, last_kinds_json)
    VALUES (?, CURRENT_TIMESTAMP, ?)
    ON CONFLICT(id) DO UPDATE SET
      last_seen_at = CURRENT_TIMESTAMP,
      last_kinds_json = CASE
        WHEN excluded.last_kinds_json = '[]' THEN satellites.last_kinds_json
        ELSE excluded.last_kinds_json
      END
  `),
  listSatellites: db.prepare(`
    SELECT * FROM satellites ORDER BY last_seen_at DESC
  `),
  listYouTubeChannels: db.prepare(`
    SELECT youtube_channels.*,
      (SELECT COUNT(*) FROM youtube_videos WHERE channel_id = youtube_channels.channel_id) AS video_count
    FROM youtube_channels
    ORDER BY created_at DESC
  `),
  getYouTubeChannel: db.prepare("SELECT * FROM youtube_channels WHERE channel_id = ?"),
  countYouTubeChannels: db.prepare("SELECT COUNT(*) AS count FROM youtube_channels"),
  activeYouTubeChannels: db.prepare(`
    SELECT * FROM youtube_channels WHERE enabled = 1 ORDER BY created_at
  `),
  addYouTubeChannel: db.prepare(`
    INSERT INTO youtube_channels (channel_id, handle, title, poll_interval_seconds)
    VALUES (?, ?, ?, ?)
  `),
  updateYouTubeChannel: db.prepare(`
    UPDATE youtube_channels
    SET poll_interval_seconds = COALESCE(?, poll_interval_seconds),
        ai_analysis_enabled = COALESCE(?, ai_analysis_enabled)
    WHERE channel_id = ?
  `),
  toggleYouTubeChannel: db.prepare(`
    UPDATE youtube_channels
    SET enabled = CASE enabled WHEN 1 THEN 0 ELSE 1 END
    WHERE channel_id = ?
  `),
  deleteYouTubeChannel: db.prepare("DELETE FROM youtube_channels WHERE channel_id = ?"),
  markYouTubeBaselined: db.prepare(`
    UPDATE youtube_channels
    SET baselined = 1, last_checked_at = CURRENT_TIMESTAMP, last_error = NULL
    WHERE channel_id = ?
  `),
  markYouTubeSuccess: db.prepare(`
    UPDATE youtube_channels
    SET last_checked_at = CURRENT_TIMESTAMP, last_error = NULL
    WHERE channel_id = ?
  `),
  markYouTubeError: db.prepare(`
    UPDATE youtube_channels
    SET last_checked_at = CURRENT_TIMESTAMP, last_error = ?
    WHERE channel_id = ?
  `),
  insertYouTubeVideo: db.prepare(`
    INSERT OR IGNORE INTO youtube_videos
      (channel_id, video_id, title, thumbnail_url, is_baseline)
    VALUES (?, ?, ?, ?, ?)
  `),
  recentYouTubeVideos: db.prepare(`
    SELECT youtube_videos.*, youtube_channels.title AS channel_title,
      youtube_channels.handle AS channel_handle
    FROM youtube_videos
    JOIN youtube_channels ON youtube_channels.channel_id = youtube_videos.channel_id
    WHERE youtube_videos.is_baseline = 0
    ORDER BY youtube_videos.first_seen_at DESC
    LIMIT ?
  `),
  countYouTubeVideos: db.prepare("SELECT COUNT(*) AS count FROM youtube_videos"),
  countYouTubeDiscoveries: db.prepare(`
    SELECT COUNT(*) AS count FROM youtube_videos WHERE is_baseline = 0
  `),
  syncYouTubeChannel: db.prepare(`
    UPDATE youtube_channels
    SET handle = COALESCE(?, handle),
        title = COALESCE(?, title),
        poll_interval_seconds = COALESCE(?, poll_interval_seconds)
    WHERE channel_id = ?
  `),
  listBinanceSquareTargets: db.prepare(`
    SELECT binance_square_targets.*,
      (SELECT COUNT(*) FROM binance_square_posts WHERE square_uid = binance_square_targets.square_uid) AS post_count
    FROM binance_square_targets
    ORDER BY created_at DESC
  `),
  getBinanceSquareTarget: db.prepare("SELECT * FROM binance_square_targets WHERE square_uid = ?"),
  getBinanceSquareTargetByUsername: db.prepare(`
    SELECT * FROM binance_square_targets WHERE lower(username) = lower(?)
  `),
  countBinanceSquareTargets: db.prepare("SELECT COUNT(*) AS count FROM binance_square_targets"),
  activeBinanceSquareTargets: db.prepare(`
    SELECT * FROM binance_square_targets WHERE enabled = 1 ORDER BY created_at
  `),
  addBinanceSquareTarget: db.prepare(`
    INSERT INTO binance_square_targets
      (square_uid, username, display_name, avatar, biography, poll_interval_seconds)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  syncBinanceSquareTarget: db.prepare(`
    UPDATE binance_square_targets
    SET username = COALESCE(?, username),
        display_name = COALESCE(?, display_name),
        poll_interval_seconds = COALESCE(?, poll_interval_seconds)
    WHERE square_uid = ?
  `),
  updateBinanceSquareTarget: db.prepare(`
    UPDATE binance_square_targets
    SET poll_interval_seconds = COALESCE(?, poll_interval_seconds),
        enabled = COALESCE(?, enabled)
    WHERE square_uid = ?
  `),
  toggleBinanceSquareTarget: db.prepare(`
    UPDATE binance_square_targets
    SET enabled = CASE enabled WHEN 1 THEN 0 ELSE 1 END
    WHERE square_uid = ?
  `),
  deleteBinanceSquareTarget: db.prepare("DELETE FROM binance_square_targets WHERE square_uid = ?"),
  markBinanceSquareBaselined: db.prepare(`
    UPDATE binance_square_targets
    SET baselined = 1, last_checked_at = CURRENT_TIMESTAMP, last_error = NULL,
        pinned_post_count = ?
    WHERE square_uid = ?
  `),
  markBinanceSquareSuccess: db.prepare(`
    UPDATE binance_square_targets
    SET last_checked_at = CURRENT_TIMESTAMP, last_error = NULL,
        pinned_post_count = ?
    WHERE square_uid = ?
  `),
  markBinanceSquareError: db.prepare(`
    UPDATE binance_square_targets
    SET last_checked_at = CURRENT_TIMESTAMP, last_error = ?
    WHERE square_uid = ?
  `),
  insertBinanceSquarePost: db.prepare(`
    INSERT OR IGNORE INTO binance_square_posts
      (square_uid, post_id, title, content, created_at, post_type, content_type,
       is_pinned, url, cover, images_json, is_baseline)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  recentBinanceSquarePosts: db.prepare(`
    SELECT binance_square_posts.*, binance_square_targets.username,
      binance_square_targets.display_name
    FROM binance_square_posts
    JOIN binance_square_targets
      ON binance_square_targets.square_uid = binance_square_posts.square_uid
    WHERE binance_square_posts.is_baseline = 0
    ORDER BY binance_square_posts.first_seen_at DESC
    LIMIT ?
  `),
  countBinanceSquarePosts: db.prepare("SELECT COUNT(*) AS count FROM binance_square_posts"),
  countBinanceSquareDiscoveries: db.prepare(`
    SELECT COUNT(*) AS count FROM binance_square_posts WHERE is_baseline = 0
  `),
};

statements.ensurePumpState.run();
statements.ensureRobinhoodState.run();
db.exec(`
  UPDATE binance_ui_observations
  SET notification_status = 'pending'
  WHERE notification_status = 'delivering';

  UPDATE pump_app_observations
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
      const canonical = canonicalizePageUrl(url) || url;
      const alreadySeen = pageUrlAliases(canonical).some(
        (alias) => statements.getUrl.get(siteId, alias)
      );
      if (alreadySeen) continue;
      if (statements.insertUrl.run(siteId, canonical, isBaseline ? 1 : 0).changes) {
        inserted.push(canonical);
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

function addRobinhoodPages(pages, isBaseline = false) {
  const inserted = [];
  db.exec("BEGIN");
  try {
    for (const page of pages) {
      const result = statements.insertRobinhoodPage.run(
        page.url,
        page.path,
        page.host || "robinhood.com",
        page.source,
        page.title || "",
        isBaseline ? 1 : 0
      );
      if (result.changes) inserted.push(page);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return inserted;
}

function syncYouTubeChannels(channels) {
  let added = 0;
  let updated = 0;
  db.exec("BEGIN");
  try {
    for (const channel of channels) {
      const interval = channel.pollIntervalSeconds ?? 15;
      const existing = statements.getYouTubeChannel.get(channel.channelId);
      if (!existing) {
        statements.addYouTubeChannel.run(
          channel.channelId,
          channel.handle ?? null,
          channel.title,
          interval
        );
        added += 1;
        continue;
      }
      const handle = channel.handle ?? null;
      if (
        existing.title !== channel.title ||
        (existing.handle || null) !== handle ||
        existing.poll_interval_seconds !== interval
      ) {
        statements.syncYouTubeChannel.run(handle, channel.title, interval, channel.channelId);
        updated += 1;
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { added, updated };
}

function recordYouTubeVideos(channelId, videos, isBaseline = false) {
  const inserted = [];
  db.exec("BEGIN");
  try {
    for (const video of videos) {
      if (
        statements.insertYouTubeVideo.run(
          channelId,
          video.videoId,
          video.title || null,
          video.thumbnailUrl || null,
          isBaseline ? 1 : 0
        ).changes
      ) {
        inserted.push(video);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return inserted;
}

function syncBinanceSquareTargets(targets) {
  let added = 0;
  let updated = 0;
  db.exec("BEGIN");
  try {
    for (const target of targets) {
      const interval = target.pollIntervalSeconds ?? 2;
      const existing = statements.getBinanceSquareTarget.get(target.squareUid);
      if (!existing) {
        statements.addBinanceSquareTarget.run(
          target.squareUid,
          target.username,
          target.displayName,
          target.avatar ?? null,
          target.biography ?? null,
          interval
        );
        added += 1;
        continue;
      }
      if (
        existing.username !== target.username ||
        existing.display_name !== target.displayName ||
        existing.poll_interval_seconds !== interval
      ) {
        statements.syncBinanceSquareTarget.run(
          target.username,
          target.displayName,
          interval,
          target.squareUid
        );
        updated += 1;
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { added, updated };
}

function recordBinanceSquarePosts(squareUid, posts, isBaseline = false) {
  const inserted = [];
  db.exec("BEGIN");
  try {
    for (const post of posts) {
      if (
        statements.insertBinanceSquarePost.run(
          squareUid,
          post.id,
          post.title || null,
          post.content || null,
          post.createdAt ?? null,
          post.postType || null,
          post.contentType ?? null,
          post.isPinned ? 1 : 0,
          post.url || null,
          post.cover || null,
          JSON.stringify(post.images || []),
          isBaseline ? 1 : 0
        ).changes
      ) {
        inserted.push(post);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return inserted;
}

function touchSatellite(satelliteId, kinds = []) {
  const id = String(satelliteId || "").trim();
  if (!id) return;
  statements.upsertSatellite.run(
    id,
    JSON.stringify([...new Set(kinds.filter(Boolean))])
  );
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

function inspectPumpObservation(updateId, publishedAt) {
  if (statements.getPumpObservation.get(updateId)) return "duplicate";
  const current = statements.getPumpState.get();
  if (current.baselined && current.update_id === updateId) return "unchanged";

  const currentTime = Date.parse(current.published_at || "");
  const incomingTime = Date.parse(publishedAt || "");
  if (
    current.baselined &&
    Number.isFinite(currentTime) &&
    (!Number.isFinite(incomingTime) || incomingTime <= currentTime)
  ) {
    return "stale";
  }
  return "new";
}

function applyPumpObservation(observation) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const status = inspectPumpObservation(
      observation.updateId,
      observation.publishedAt
    );
    if (status !== "new") {
      db.exec("COMMIT");
      return { status };
    }

    const previous = statements.getPumpState.get();
    const inserted = statements.insertPumpObservation.run(
      observation.updateId,
      observation.runtimeVersion,
      previous.update_id || null,
      observation.publishedAt || null,
      observation.launchHash,
      observation.probeId,
      observation.observedAt
    );
    if (!inserted.changes) {
      db.exec("COMMIT");
      return { status: "duplicate" };
    }

    let previousSignals = {};
    if (previous.baselined) {
      previousSignals = JSON.parse(previous.signals_json || "{}");
    }
    const changes = previous.baselined
      ? diffPumpSignals(previousSignals, observation.signals)
      : [];

    statements.savePumpState.run(
      observation.runtimeVersion,
      observation.updateId,
      observation.etag || null,
      observation.launchHash,
      observation.bundleHash,
      JSON.stringify(observation.signals),
      observation.publishedAt || null
    );

    const update = previous.baselined
      ? {
          changes,
          launchHash: observation.launchHash,
          previousUpdateId: previous.update_id,
          publishedAt: observation.publishedAt,
          runtimeVersion: observation.runtimeVersion,
          updateId: observation.updateId,
        }
      : null;
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
    statements.finishPumpObservation.run(
      update ? JSON.stringify(changes) : null,
      update ? "pending" : "none",
      observation.updateId
    );
    db.exec("COMMIT");
    return {
      status: previous.baselined ? "accepted" : "baselined",
      update,
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function claimPumpNotification(updateId) {
  const result = statements.claimPumpNotification.run(updateId);
  if (!result.changes) return null;
  const row = statements.getPumpObservation.get(updateId);
  return {
    changes: JSON.parse(row.changes_json || "[]"),
    launchHash: row.launch_hash,
    previousUpdateId: row.previous_update_id,
    publishedAt: row.published_at,
    runtimeVersion: row.runtime_version,
    updateId: row.update_id,
  };
}

function markPumpNotificationDelivered(updateId) {
  statements.markPumpNotificationDelivered.run(updateId);
}

function markPumpNotificationFailed(updateId, error) {
  statements.markPumpNotificationFailed.run(
    String(error?.message || error).slice(0, 500),
    updateId
  );
}

function listPendingPumpNotifications() {
  return statements.pendingPumpNotifications.all();
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
  statements,
  getSetting,
  addDiscoveredUrls,
  addDiscoveredSubdomains,
  addLog,
  pruneDiscoveredUrls,
  addGithubItems,
  addGithubLog,
  addBinanceChanges,
  addRobinhoodPages,
  applyBinanceObservation,
  applyPumpObservation,
  claimBinanceNotification,
  claimPumpNotification,
  createAlertReport,
  inspectPumpObservation,
  listPendingBinanceNotifications,
  listPendingPumpNotifications,
  markBinanceNotificationDelivered,
  markBinanceNotificationFailed,
  markPumpNotificationDelivered,
  markPumpNotificationFailed,
  recordBinanceSquarePosts,
  recordYouTubeVideos,
  savePumpUpdate,
  syncBinanceSquareTargets,
  syncYouTubeChannels,
  touchSatellite,
};
