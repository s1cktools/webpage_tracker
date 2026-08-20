const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pagepulse-certspotter-"));
process.env.DATA_DIR = directory;

const { db, statements } = require("../src/db");
const {
  CERTSPOTTER_CANARY,
  buildWatchlist,
  validateHookPayload,
} = require("../src/certspotter-manager");
const { buildPayload, getHookUrl } = require("../src/certspotter-hook");
const { processLiveNames } = require("../src/ct-scanner");

test.after(() => {
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("builds a sorted Cert Spotter watchlist from enabled roots", () => {
  assert.equal(
    buildWatchlist([
      { hostname: "SpaceX.com", enabled: 1 },
      { hostname: "openai.com", enabled: 1 },
      { hostname: "spacex.com", enabled: 1 },
      { hostname: "paused.test", enabled: 0 },
      { hostname: "invalid hostname", enabled: 1 },
    ]),
    [".openai.com", ".spacex.com", CERTSPOTTER_CANARY].sort().join("\n") + "\n"
  );
});

test("validates and bounds Cert Spotter hook events", () => {
  assert.deepEqual(
    validateHookPayload({
      event: "discovered_cert",
      dns_names: ["auth.example.com", 123],
      summary: "new certificate",
      log_uri: "https://ct.example/log",
    }),
    {
      event: "discovered_cert",
      dns_names: ["auth.example.com"],
      summary: "new certificate",
      detail: "",
      log_uri: "https://ct.example/log",
    }
  );
  assert.throws(
    () => validateHookPayload({ event: "discovered_cert" }),
    /dns_names/
  );
  assert.throws(() => validateHookPayload({ event: "unknown" }), /Unsupported/);
});

test("hook reads the documented Cert Spotter certificate JSON", async () => {
  const filename = path.join(directory, "certificate.json");
  fs.writeFileSync(
    filename,
    JSON.stringify({ dns_names: ["auth.example.com", "*.example.com"] })
  );
  assert.deepEqual(
    await buildPayload({
      EVENT: "discovered_cert",
      SUMMARY: "certificate discovered",
      LOG_URI: "https://ct.example/log",
      JSON_FILENAME: filename,
    }),
    {
      event: "discovered_cert",
      summary: "certificate discovered",
      log_uri: "https://ct.example/log",
      dns_names: ["auth.example.com", "*.example.com"],
      detail: "",
    }
  );
});

test("hook only accepts its loopback HTTP receiver", () => {
  process.env.PAGEPULSE_CT_HOOK_URL = "http://127.0.0.1:4567/event";
  assert.equal(getHookUrl().href, "http://127.0.0.1:4567/event");
  process.env.PAGEPULSE_CT_HOOK_URL = "https://example.com/event";
  assert.throws(() => getHookUrl(), /Invalid/);
  delete process.env.PAGEPULSE_CT_HOOK_URL;
});

test("routes direct certificate names through hostname matching and SQLite dedupe", async () => {
  const siteId = Number(
    statements.addSite.run("https://example.com/", "example.com", "Example")
      .lastInsertRowid
  );
  await processLiveNames([
    "example.com",
    "auth.example.com",
    "*.wildcard.example.com",
    "example.com.evil.test",
  ]);
  const stored = db
    .prepare("SELECT * FROM discovered_subdomains ORDER BY id DESC")
    .all();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].site_id, siteId);
  assert.equal(stored[0].hostname, "auth.example.com");
  assert.equal(stored[0].source, "certspotter");

  await processLiveNames(["auth.example.com"]);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM discovered_subdomains").get().count, 1);
});
