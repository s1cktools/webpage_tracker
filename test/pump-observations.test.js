const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

test("deduplicates Pump observations and rejects stale releases", () => {
  const dataDirectory = mkdtempSync(path.join(tmpdir(), "pagepulse-pump-observation-"));
  try {
    const output = execFileSync(
      process.execPath,
      [
        "-e",
        `
          const {
            applyPumpObservation, claimPumpNotification, db, statements
          } = require("./src/db");
          const base = {
            etag: "etag-v1",
            runtimeVersion: "26.0.0",
            launchHash: "launch-v1",
            bundleHash: "bundle-v1",
            signals: { hosts: ["api-v1.example"], routes: [], textHints: [], assets: [] },
            probeId: "primary",
            observedAt: "2026-08-21T14:00:00.000Z"
          };
          const baseline = applyPumpObservation({
            ...base,
            updateId: "pump-v1",
            publishedAt: "2026-08-21T14:00:00.000Z"
          });
          const accepted = applyPumpObservation({
            ...base,
            updateId: "pump-v2",
            etag: "etag-v2",
            launchHash: "launch-v2",
            bundleHash: "bundle-v2",
            signals: { hosts: ["api-v2.example"], routes: [], textHints: [], assets: [] },
            probeId: "eu",
            observedAt: "2026-08-21T14:01:01.000Z",
            publishedAt: "2026-08-21T14:01:00.000Z"
          });
          const duplicate = applyPumpObservation({
            ...base,
            updateId: "pump-v2",
            publishedAt: "2026-08-21T14:01:00.000Z",
            probeId: "asia"
          });
          const stale = applyPumpObservation({
            ...base,
            updateId: "pump-v0",
            publishedAt: "2026-08-21T13:59:00.000Z",
            probeId: "us"
          });
          const firstClaim = claimPumpNotification("pump-v2");
          const secondClaim = claimPumpNotification("pump-v2");
          process.stdout.write(JSON.stringify({
            statuses: [baseline.status, accepted.status, duplicate.status, stale.status],
            claims: [Boolean(firstClaim), Boolean(secondClaim)],
            updates: statements.countPumpUpdates.get().count,
            state: statements.getPumpState.get(),
            observations: db.prepare(
              "SELECT COUNT(*) AS count FROM pump_app_observations"
            ).get().count
          }));
        `,
      ],
      {
        cwd: path.join(__dirname, ".."),
        env: { ...process.env, DATA_DIR: dataDirectory },
        encoding: "utf8",
      }
    );
    const result = JSON.parse(output);

    assert.deepEqual(result.statuses, [
      "baselined",
      "accepted",
      "duplicate",
      "stale",
    ]);
    assert.deepEqual(result.claims, [true, false]);
    assert.equal(result.updates, 1);
    assert.equal(result.observations, 2);
    assert.equal(result.state.update_id, "pump-v2");
    assert.deepEqual(JSON.parse(result.state.signals_json).hosts, [
      "api-v2.example",
    ]);
  } finally {
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test("validates regional Pump observation envelopes", () => {
  const dataDirectory = mkdtempSync(path.join(tmpdir(), "pagepulse-pump-validation-"));
  try {
    const output = execFileSync(
      process.execPath,
      [
        "-e",
        `
          const { normalizePumpObservation } = require("./src/pump-observations");
          const errors = [];
          for (const payload of [
            {},
            {
              updateId: "wrong",
              manifest: {
                id: "right",
                createdAt: "2026-08-21T14:00:00.000Z",
                launchAsset: { hash: "hash", url: "https://assets.example/bundle" }
              },
              probeId: "eu"
            }
          ]) {
            try { normalizePumpObservation(payload); }
            catch (error) { errors.push(error.message); }
          }
          process.stdout.write(JSON.stringify(errors));
        `,
      ],
      {
        cwd: path.join(__dirname, ".."),
        env: { ...process.env, DATA_DIR: dataDirectory },
        encoding: "utf8",
      }
    );
    assert.deepEqual(JSON.parse(output), [
      "Invalid Pump manifest",
      "Pump updateId does not match manifest",
    ]);
  } finally {
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});
