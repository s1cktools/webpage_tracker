const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

test("stores complete immutable alert report snapshots", () => {
  const dataDirectory = mkdtempSync(path.join(tmpdir(), "pagepulse-reports-"));
  try {
    const output = execFileSync(
      process.execPath,
      [
        "-e",
        [
          'const { createAlertReport, statements } = require("./src/db");',
          'const items = Array.from({ length: 15 }, (_, index) => ({ label: `item ${index}` }));',
          'const id = createAlertReport("test", "Exact report", { subtitle: "snapshot", items });',
          "const saved = statements.getAlertReport.get(id);",
          "process.stdout.write(JSON.stringify(saved));",
        ].join(""),
      ],
      {
        cwd: path.join(__dirname, ".."),
        env: { ...process.env, DATA_DIR: dataDirectory },
        encoding: "utf8",
      }
    );
    const saved = JSON.parse(output);
    const payload = JSON.parse(saved.payload_json);

    assert.equal(saved.kind, "test");
    assert.equal(saved.item_count, 15);
    assert.equal(payload.items.length, 15);
    assert.equal(payload.items[14].label, "item 14");
  } finally {
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});
