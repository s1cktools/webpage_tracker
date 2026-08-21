const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

function runWithTemporaryDatabase(source) {
  const dataDirectory = mkdtempSync(path.join(tmpdir(), "pagepulse-binance-"));
  try {
    return execFileSync(process.execPath, ["-e", source], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, DATA_DIR: dataDirectory },
      encoding: "utf8",
    });
  } finally {
    rmSync(dataDirectory, { recursive: true, force: true });
  }
}

test("deduplicates regional observations and rejects stale versions", () => {
  const output = runWithTemporaryDatabase(`
    const {
      applyBinanceObservation, claimBinanceNotification, db, statements
    } = require("./src/db");
    const base = {
      namespace: "activity-ui",
      probeId: "primary",
      observedAt: "2026-08-21T13:50:00.000Z",
      trustedLocal: true
    };
    const first = applyBinanceObservation({
      ...base, etag: "v1", versionId: "s3-v1",
      lastModified: "2026-08-21T13:50:00.000Z", snapshot: { title: "before" }
    });
    const second = applyBinanceObservation({
      ...base, probeId: "eu", etag: "v2", versionId: "s3-v2",
      lastModified: "2026-08-21T13:51:00.000Z", snapshot: { title: "after" }
    });
    const firstClaim = claimBinanceNotification("activity-ui", "s3-v2");
    const secondClaim = claimBinanceNotification("activity-ui", "s3-v2");
    const duplicate = applyBinanceObservation({
      ...base, probeId: "asia", etag: "v2", versionId: "s3-v2",
      lastModified: "2026-08-21T13:51:00.000Z", snapshot: { title: "after" }
    });
    const stale = applyBinanceObservation({
      ...base, probeId: "us", etag: "v0", versionId: "s3-v0",
      lastModified: "2026-08-21T13:49:00.000Z", snapshot: { title: "old" }
    });
    process.stdout.write(JSON.stringify({
      statuses: [first.status, second.status, duplicate.status, stale.status],
      reports: statements.countAlertReports.get().count,
      changes: statements.countBinanceChanges.get().count,
      notificationClaims: [Boolean(firstClaim), Boolean(secondClaim)],
      state: statements.getBinanceNamespace.get("activity-ui"),
      observations: db.prepare(
        "SELECT COUNT(*) AS count FROM binance_ui_observations"
      ).get().count
    }));
  `);
  const result = JSON.parse(output);

  assert.deepEqual(result.statuses, [
    "baselined",
    "accepted",
    "duplicate",
    "stale",
  ]);
  assert.equal(result.reports, 1);
  assert.equal(result.changes, 1);
  assert.deepEqual(result.notificationClaims, [true, false]);
  assert.equal(result.observations, 3);
  assert.equal(result.state.etag, "v2");
  assert.deepEqual(JSON.parse(result.state.snapshot_json), { title: "after" });
});

test("migrates legacy Binance namespace state", () => {
  const output = runWithTemporaryDatabase(`
    const path = require("node:path");
    const { DatabaseSync } = require("node:sqlite");
    const file = path.join(process.env.DATA_DIR, "tracker.db");
    const legacy = new DatabaseSync(file);
    legacy.exec(
      "CREATE TABLE binance_ui_namespaces (" +
      "name TEXT PRIMARY KEY, etag TEXT, snapshot_json TEXT, " +
      "baselined INTEGER NOT NULL DEFAULT 0, last_checked_at TEXT, last_error TEXT)"
    );
    legacy.close();
    const { db } = require("./src/db");
    process.stdout.write(JSON.stringify({
      columns: db.prepare("PRAGMA table_info(binance_ui_namespaces)").all()
        .map((column) => column.name),
      observations: db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' " +
        "AND name = 'binance_ui_observations'"
      ).get()
    }));
  `);
  const result = JSON.parse(output);

  assert.ok(result.columns.includes("version_id"));
  assert.ok(result.columns.includes("last_modified_at"));
  assert.equal(result.observations.name, "binance_ui_observations");
});
