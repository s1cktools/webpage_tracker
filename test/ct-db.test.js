const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("stores a silent CT baseline and marks later subdomains as new", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pagepulse-ct-"));
  process.env.DATA_DIR = directory;
  const { addDiscoveredSubdomains, db, statements } = require("../src/db");

  try {
    const siteId = Number(
      statements.addSite.run("https://example.com/", "example.com", "Example")
        .lastInsertRowid
    );
    const baseline = addDiscoveredSubdomains(
      siteId,
      [{ hostname: "www.example.com", wildcard: false }],
      "crt.sh",
      true
    );
    statements.markCtBaselined.run(siteId);
    const discovered = addDiscoveredSubdomains(
      siteId,
      [{ hostname: "auth.example.com", wildcard: false }],
      "certspotter",
      false
    );

    assert.equal(baseline.length, 1);
    assert.equal(discovered.length, 1);
    assert.equal(statements.listSites.get().ct_baselined, 1);
    assert.equal(statements.listSites.get().ct_history_baselined, 1);
    assert.deepEqual(
      statements.recentSubdomains.all(10).map((row) => row.hostname),
      ["auth.example.com"]
    );
    assert.equal(
      addDiscoveredSubdomains(
        siteId,
        [{ hostname: "auth.example.com", wildcard: false }],
        "certspotter"
      ).length,
      0
    );

    const delayedId = Number(
      statements.addSite.run("https://delayed.test/", "delayed.test", "Delayed")
        .lastInsertRowid
    );
    statements.markCtLiveAfterBaselineError.run("crt.sh timed out", delayedId);
    const delayed = statements.getSite.get(delayedId);
    assert.equal(delayed.ct_baselined, 1);
    assert.equal(delayed.ct_history_baselined, 0);
    assert.equal(delayed.ct_last_error, "crt.sh timed out");
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
