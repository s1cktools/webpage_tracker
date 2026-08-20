const test = require("node:test");
const assert = require("node:assert/strict");
const {
  diffPumpSignals,
  extractBundleSignals,
  fetchPumpBundle,
  fetchPumpUpdate,
  groupPumpChanges,
  parseMultipartParts,
  parsePlayStoreVersion,
} = require("../src/pump");
const { buildPumpPayload } = require("../src/discord");

const boundary = "test-boundary";
const manifest = {
  id: "new-update",
  createdAt: "2026-08-18T08:00:00.000Z",
  runtimeVersion: "26.0.0",
  launchAsset: {
    hash: "launch-hash",
    key: "launch-key",
    contentType: "application/javascript",
    url: "https://assets.eascdn.net/bundle",
  },
  assets: [{ key: "asset-one" }],
};
const extensions = {
  assetRequestHeaders: {
    "launch-key": { authorization: "EAS-HMAC-SHA256 secret" },
  },
};

function multipartBody() {
  return [
    `--${boundary}`,
    'Content-Disposition: form-data; name="manifest"',
    "Content-Type: application/json",
    "",
    JSON.stringify(manifest),
    `--${boundary}`,
    'Content-Disposition: form-data; name="extensions"',
    "Content-Type: application/json",
    "",
    JSON.stringify(extensions),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

test("extracts the current runtime from Google Play metadata", () => {
  assert.equal(
    parsePlayStoreVersion(
      'data,null,[[["26.0.0"]],[[[36]],[[[24,"7.0"]]]]],null'
    ),
    "26.0.0"
  );
});

test("parses Expo multipart manifest and extensions", () => {
  const parts = parseMultipartParts(
    multipartBody(),
    `multipart/mixed; boundary=${boundary}`
  );
  assert.equal(parts.manifest.id, "new-update");
  assert.equal(
    parts.extensions.assetRequestHeaders["launch-key"].authorization,
    "EAS-HMAC-SHA256 secret"
  );
});

test("uses Expo update ID and ETag for cheap unchanged checks", async (context) => {
  let requestHeaders;
  context.mock.method(global, "fetch", async (_url, options) => {
    requestHeaders = options.headers;
    return new Response(null, { status: 204 });
  });

  const result = await fetchPumpUpdate({
    updateId: "current-update",
    etag: 'W/"saved"',
  });
  assert.equal(result.unchanged, true);
  assert.equal(requestHeaders["expo-current-update-id"], "current-update");
  assert.equal(requestHeaders["if-none-match"], 'W/"saved"');
  assert.equal(requestHeaders["expo-channel-name"], "mainnet");
});

test("labels Expo and launch-bundle timeouts", async (context) => {
  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), {
    name: "TimeoutError",
  });
  context.mock.method(global, "fetch", async () => {
    throw timeout;
  });

  await assert.rejects(
    () => fetchPumpUpdate({ runtimeVersion: "26.0.0" }),
    /Pump update feed timed out after 30s/
  );
  await assert.rejects(
    () => fetchPumpBundle(manifest, extensions),
    /Pump launch bundle timed out after 180s/
  );
});

test("fetches changed manifests and authorized launch bundles", async (context) => {
  const calls = [];
  context.mock.method(global, "fetch", async (url, options) => {
    calls.push({ url, headers: options.headers });
    if (String(url).includes("u.expo.dev")) {
      return new Response(multipartBody(), {
        status: 200,
        headers: {
          "content-type": `multipart/mixed; boundary=${boundary}`,
          etag: 'W/"new"',
        },
      });
    }
    return new Response(Buffer.from("bundle"), { status: 200 });
  });

  const update = await fetchPumpUpdate();
  const bundle = await fetchPumpBundle(update.manifest, update.extensions);
  assert.equal(update.updateId, "new-update");
  assert.equal(update.etag, 'W/"new"');
  assert.equal(bundle.toString(), "bundle");
  assert.equal(calls[1].headers.authorization, "EAS-HMAC-SHA256 secret");
});

test("extracts and diffs Pump feature signals", () => {
  const signals = extractBundleSignals(
    Buffer.from(
      [
        "https://advanced-api-v2.pump.fun/v1",
        "/coin/[mint]/position",
        "Create a bounty and publish it",
      ].join("\0")
    ),
    manifest
  );
  assert.ok(signals.hosts.includes("advanced-api-v2.pump.fun"));
  assert.ok(signals.routes.includes("/coin/[mint]/position"));
  assert.ok(signals.textHints.includes("Create a bounty and publish it"));
  assert.deepEqual(
    diffPumpSignals(
      { hosts: ["old-api.pump.fun"], routes: [], assets: [], textHints: [] },
      signals
    ).filter((change) => change.category === "host"),
    [
      { type: "added", category: "host", value: "advanced-api-v2.pump.fun" },
      { type: "removed", category: "host", value: "old-api.pump.fun" },
    ]
  );
});

test("groups every Pump change by category and type", () => {
  const changes = [
    { type: "added", category: "host", value: "api.pump.fun" },
    { type: "removed", category: "host", value: "old.pump.fun" },
    { type: "added", category: "route", value: "/coin/new" },
  ];
  const groups = groupPumpChanges(changes);
  const endpoints = groups.find((group) => group.key === "host");
  const routes = groups.find((group) => group.key === "route");

  assert.deepEqual(endpoints.added, ["api.pump.fun"]);
  assert.deepEqual(endpoints.removed, ["old.pump.fun"]);
  assert.equal(endpoints.count, 2);
  assert.deepEqual(routes.added, ["/coin/new"]);
  assert.equal(
    groups.reduce((total, group) => total + group.count, 0),
    changes.length
  );
});

test("builds a concise Pump app Discord alert", () => {
  const changes = [
    { type: "added", category: "host", value: "advanced-api-v2.pump.fun" },
    ...Array.from({ length: 4102 }, (_, index) => ({
      type: index % 2 ? "added" : "removed",
      category: "text",
      value: `Extracted UI text ${index}`,
    })),
  ];
  const payload = buildPumpPayload(
    {
      updateId: "new-update",
      runtimeVersion: "26.0.0",
      publishedAt: "2026-08-18T08:00:00.000Z",
      changes,
    },
    942,
    new Date("2026-08-18T08:01:00.000Z")
  );
  assert.equal(payload.embeds[0].title, "New app update · 26.0.0");
  assert.match(payload.embeds[0].description, /\*\*4103 changes\*\*/);
  assert.match(payload.embeds[0].description, /View all 4103 changes/);
  assert.match(payload.embeds[0].url, /\/pump\/updates\/new-update$/);
  assert.ok(payload.embeds[0].description.split("\n").length <= 10);
  assert.ok(payload.embeds[0].description.length < 500);
  assert.equal(payload.embeds[0].fields, undefined);
  assert.equal(payload.embeds[0].footer.text, "PUMP APP · expo · 942ms");
});
